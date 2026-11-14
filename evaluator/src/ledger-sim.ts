// Read-only reader of the provider simulator's whole-account list (ARCHITECTURE §7.2):
//   GET {EVAL_SIM_URL}/v1/payouts?account=acct_<run_id>&limit=100[&starting_after=<cursor>]
//   Authorization: Bearer <EVAL_SIM_READ_KEY>
// Follows has_more / next_cursor to the end. Never uses the search endpoint. Issues GET only.
import { LedgerError } from "./ledger.ts";
import type { LedgerObject, LedgerSource } from "./ledger.ts";

const PAGE_LIMIT = 100;
const MAX_PAGES = 10_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toLedgerObject(raw: unknown, where: string): LedgerObject {
  if (!isObj(raw)) throw new LedgerError(`simulator: ${where} is not an object`);
  const need = (k: string): string => {
    if (typeof raw[k] !== "string") throw new LedgerError(`simulator: ${where}.${k} must be a string`);
    return raw[k] as string;
  };
  const amount = raw.amount_minor;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) throw new LedgerError(`simulator: ${where}.amount_minor must be an integer`);
  const metadata: Record<string, string> = {};
  if (raw.metadata !== undefined && raw.metadata !== null) {
    if (!isObj(raw.metadata)) throw new LedgerError(`simulator: ${where}.metadata must be an object`);
    for (const [k, v] of Object.entries(raw.metadata)) if (typeof v === "string") metadata[k] = v;
  }
  return {
    source: "sim", id: need("id"), kind: need("kind"), status: need("status"), amount_minor: amount, currency: need("currency"),
    payee_ref: typeof raw.payee_ref === "string" ? raw.payee_ref : null,
    parent_ref: typeof raw.parent_ref === "string" ? raw.parent_ref : null,
    metadata, created_at: typeof raw.created_at === "string" ? raw.created_at : "",
  };
}

export type SimLedgerOptions = { baseUrl: string; readKey: string; fetchImpl?: typeof fetch; timeoutMs?: number };

export function simLedgerSource(opts: SimLedgerOptions): LedgerSource {
  if (!opts.baseUrl) throw new LedgerError("EVAL_SIM_URL is not set");
  if (!opts.readKey) throw new LedgerError("EVAL_SIM_READ_KEY is not set");
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    id: "sim",
    async readAll(runId: string): Promise<LedgerObject[]> {
      const account = `acct_${runId}`;
      const out: LedgerObject[] = [];
      const ids = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const q = new URLSearchParams({ account, limit: String(PAGE_LIMIT) });
        if (cursor !== null) q.set("starting_after", cursor);
        let res: Response;
        try {
          res = await f(`${base}/v1/payouts?${q.toString()}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${opts.readKey}`, Accept: "application/json" },
            signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
          });
        } catch (e) {
          throw new LedgerError(`simulator unreachable at ${base}: ${(e as Error).message}`);
        }
        if (res.status !== 200) throw new LedgerError(`simulator list returned HTTP ${res.status}`);
        let body: unknown;
        try { body = await res.json(); } catch { throw new LedgerError("simulator list returned a body that is not JSON"); }
        if (!isObj(body) || !Array.isArray(body.data) || typeof body.has_more !== "boolean") {
          throw new LedgerError("simulator list body must be { data: [], has_more: boolean, next_cursor }");
        }
        body.data.forEach((raw, i) => {
          const o = toLedgerObject(raw, `page ${page + 1} data[${i}]`);
          if (ids.has(o.id)) throw new LedgerError(`simulator list returned object ${o.id} twice`);
          ids.add(o.id);
          out.push(o);
        });
        if (!body.has_more) return out;
        const next = typeof body.next_cursor === "string" ? body.next_cursor : out.length > 0 ? out[out.length - 1].id : null;
        if (next === null || next === cursor) throw new LedgerError("simulator list says has_more but gives no new cursor");
        cursor = next;
      }
      throw new LedgerError(`simulator list exceeded ${MAX_PAGES} pages`);
    },
  };
}
