// Read-only reader of Stripe test mode's refund list (HANDOVER §12.3 "All operations", task F4):
//   GET https://api.stripe.com/v1/refunds?limit=100[&starting_after=<last refund id>]
//   Authorization: Basic base64(<EVAL_STRIPE_KEY> + ":")
// The top-level list (immediately consistent per §12.3), never the Search API. Follows has_more with
// starting_after = the id of the last object on the page, to the end. Keeps refunds whose metadata.nt_run_id is
// the run's. Issues GET only: the auditor never writes to Stripe.
//
// Key guard: EVAL_STRIPE_KEY must match ^rk_test_ (a restricted, test-mode key). Anything else, including any
// sk_ key and any live key, is refused when the source is constructed, before any request; the CLI maps the
// LedgerError to exit 2. The key is never echoed in an error message.
import { LedgerError } from "./ledger.ts";
import type { LedgerObject, LedgerSource } from "./ledger.ts";

export const STRIPE_API_BASE = "https://api.stripe.com";
export const STRIPE_KEY_RE = /^rk_test_/;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Throws LedgerError unless `key` is a restricted test-mode key. The message describes the key's kind, never its value. */
export function assertStripeKey(key: string | undefined): asserts key is string {
  if (key === undefined || key === "") throw new LedgerError("EVAL_STRIPE_KEY is not set");
  if (STRIPE_KEY_RE.test(key)) return;
  const kind = /^sk_live_/.test(key) || /^rk_live_/.test(key) || /^pk_live_/.test(key) ? "a LIVE key"
    : /^sk_test_/.test(key) ? "a secret (sk_test_) key, not a restricted read-only key"
    : /^pk_/.test(key) ? "a publishable key"
    : "not a Stripe restricted test-mode key";
  throw new LedgerError(`EVAL_STRIPE_KEY is ${kind}; the auditor uses only a restricted read-only test-mode key (rk_test_...). Refusing before any request`);
}

/**
 * Base URL override, for tests only: accepted only when it points at a loopback host, so the key can never be
 * sent anywhere but api.stripe.com or this machine.
 */
export function resolveApiBase(override: string | undefined): string {
  if (override === undefined || override === "") return STRIPE_API_BASE;
  let u: URL;
  try { u = new URL(override); } catch { throw new LedgerError("EVAL_STRIPE_API_BASE is not a URL"); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new LedgerError("EVAL_STRIPE_API_BASE may only point at a loopback host (tests)");
  return override.replace(/\/+$/, "");
}

/** Maps one Stripe refund object to the evaluator's LedgerObject. Throws LedgerError on a shape it does not expect. */
export function refundToLedgerObject(raw: unknown, where: string): LedgerObject {
  if (!isObj(raw)) throw new LedgerError(`stripe: ${where} is not an object`);
  if (raw.object !== "refund") throw new LedgerError(`stripe: ${where}.object is ${JSON.stringify(raw.object)}, expected "refund"`);
  const str = (k: string): string => {
    if (typeof raw[k] !== "string" || raw[k] === "") throw new LedgerError(`stripe: ${where}.${k} must be a non-empty string`);
    return raw[k] as string;
  };
  const amount = raw.amount;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) throw new LedgerError(`stripe: ${where}.amount must be an integer`);
  const metadata: Record<string, string> = {};
  if (raw.metadata !== undefined && raw.metadata !== null) {
    if (!isObj(raw.metadata)) throw new LedgerError(`stripe: ${where}.metadata must be an object`);
    for (const [k, v] of Object.entries(raw.metadata)) if (typeof v === "string") metadata[k] = v;
  }
  const pi = raw.payment_intent;
  const parent_ref = typeof pi === "string" ? pi : isObj(pi) && typeof pi.id === "string" ? pi.id : null;
  const created = raw.created;
  return {
    source: "stripe",
    id: str("id"),
    kind: "refund",
    status: str("status"),
    amount_minor: amount,
    currency: str("currency").toUpperCase(),
    payee_ref: metadata.nt_payee_ref ?? null,   // a Stripe refund has no payee field (HANDOVER §12.3); absent → C9
    parent_ref,
    metadata,
    created_at: typeof created === "number" && Number.isFinite(created) ? new Date(created * 1000).toISOString() : "",
  };
}

export type StripeLedgerOptions = { key: string | undefined; apiBase?: string; fetchImpl?: typeof fetch; timeoutMs?: number };

/** One GET of the refund list. Exported for the gated live test; returns the HTTP status and parsed body. */
export async function listRefundsPage(
  opts: { key: string; apiBase?: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  params: { limit: number; startingAfter?: string },
): Promise<{ status: number; body: unknown }> {
  assertStripeKey(opts.key);
  const base = opts.apiBase ?? STRIPE_API_BASE;
  const q = new URLSearchParams({ limit: String(params.limit) });
  if (params.startingAfter !== undefined) q.set("starting_after", params.startingAfter);
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${base}/v1/refunds?${q.toString()}`, {
      method: "GET",
      headers: { Authorization: `Basic ${Buffer.from(`${opts.key}:`).toString("base64")}`, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    throw new LedgerError(`stripe unreachable at ${base}: ${(e as Error).message}`);
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

export function stripeLedgerSource(opts: StripeLedgerOptions): LedgerSource {
  assertStripeKey(opts.key);   // before any request
  const key = opts.key;
  const apiBase = opts.apiBase ?? STRIPE_API_BASE;
  return {
    id: "stripe",
    async readAll(runId: string): Promise<LedgerObject[]> {
      const out: LedgerObject[] = [];
      const ids = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { status, body } = await listRefundsPage({ key, apiBase, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs }, { limit: PAGE_LIMIT, startingAfter: cursor });
        if (status !== 200) {
          // Only Stripe's error type and code are reported: an invalid-key message can quote part of the key.
          const err = isObj(body) && isObj(body.error) ? body.error : {};
          const detail = [err.type, err.code].filter((x) => typeof x === "string").join("/");
          const hint = status === 401 ? " (key rejected)" : status === 403 ? " (key lacks Refunds read permission)" : "";
          throw new LedgerError(`stripe refund list returned HTTP ${status}${hint}${detail ? `: ${detail}` : ""}`);
        }
        if (!isObj(body) || body.object !== "list" || !Array.isArray(body.data) || typeof body.has_more !== "boolean") {
          throw new LedgerError('stripe refund list body must be { object: "list", data: [], has_more: boolean }');
        }
        let lastId: string | undefined;
        body.data.forEach((raw, i) => {
          const o = refundToLedgerObject(raw, `page ${page + 1} data[${i}]`);
          if (ids.has(o.id)) throw new LedgerError(`stripe refund list returned ${o.id} twice`);
          ids.add(o.id);
          lastId = o.id;
          if (o.metadata.nt_run_id === runId) out.push(o);
        });
        if (!body.has_more) return out;
        if (lastId === undefined || lastId === cursor) throw new LedgerError("stripe refund list says has_more but returned no new object to page after");
        cursor = lastId;
      }
      throw new LedgerError(`stripe refund list exceeded ${MAX_PAGES} pages`);
    },
  };
}
