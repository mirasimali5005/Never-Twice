// Executes a probe spec with the READ key (HANDOVER.md §11.4). Fixed code: the spec only chooses the path, the query (rendered from
// intent fields), where the objects and the marker are, and how to page. The only credential ever attached is the read key passed in
// here; the spec's own `credential` and `headers` are never sent (static admission rejects anything but "read" and no headers).
// The result is one more read-only evidence source for the SAME fixed matcher (matchEvidence, in ../pure).
import type { ProviderObject } from "@nt/contracts";
import { evalPath, renderTemplate } from "./spec.ts";
import type { ProbeContext, ProbeSpec } from "./spec.ts";

export type ProbeConnection = {
  /** The provider origin, e.g. http://127.0.0.1:4010 (NT_SIM_URL). */
  baseUrl: string;
  /** NT_SIM_READ_KEY. Never a write or admin key. */
  readKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** One object the probe returned, with the marker read at marker_path (null when the spec has no marker_path). */
export type ProbeRecord = { id: string; marker: string | null; item: Record<string, unknown> };

export type ProbeRun =
  | { ok: true; records: ProbeRecord[]; pages: number; requests: number; complete: boolean }
  | { ok: false; error: string; pages: number; requests: number };

export type ExecuteOptions = {
  /** TEST ONLY (PRB-06c): lets a non-GET spec through so canary 4 can be shown to catch a mutation. Never set in product code. */
  testOnlyAllowNonGet?: boolean;
};

const MAX_PAGES_CAP = 10;

function asItem(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function executeProbe(spec: ProbeSpec, ctx: ProbeContext, conn: ProbeConnection, opts: ExecuteOptions = {}): Promise<ProbeRun> {
  const method = spec.request.method.toUpperCase();
  if (method !== "GET" && !opts.testOnlyAllowNonGet) return { ok: false, error: `method ${method} refused: probes are GET only`, pages: 0, requests: 0 };
  const doFetch = conn.fetchImpl ?? fetch;
  let url: URL;
  try {
    url = new URL(spec.request.path, conn.baseUrl);
  } catch {
    return { ok: false, error: "invalid path", pages: 0, requests: 0 };
  }
  if (url.origin !== new URL(conn.baseUrl).origin) return { ok: false, error: `host ${url.origin} refused`, pages: 0, requests: 0 };
  const query: Record<string, string> = {};
  try {
    for (const [k, v] of Object.entries(spec.request.query)) query[k] = renderTemplate(v, ctx);
  } catch (e) {
    return { ok: false, error: (e as Error).message, pages: 0, requests: 0 };
  }
  const maxPages = spec.pagination ? Math.max(1, Math.min(spec.pagination.max_pages, MAX_PAGES_CAP)) : 1;
  const records: ProbeRecord[] = [];
  let pages = 0;
  let cursor: string | null = null;
  for (;;) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    if (cursor !== null && spec.pagination) u.searchParams.set(spec.pagination.cursor_param, cursor);
    const init: RequestInit = { method, headers: { Authorization: `Bearer ${conn.readKey}` }, signal: AbortSignal.timeout(conn.timeoutMs ?? 5000) };
    if (method !== "GET") {
      init.body = JSON.stringify(query);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
    let body: unknown;
    try {
      const r = await doFetch(u, init);
      pages++;
      const text = await r.text();
      if (!r.ok) return { ok: false, error: `HTTP ${r.status} from ${u.pathname}`, pages, requests: pages };
      body = text ? JSON.parse(text) : null;
    } catch (e) {
      return { ok: false, error: `request failed: ${(e as Error).message}`, pages: pages + 1, requests: pages + 1 };
    }
    let items: unknown[];
    try {
      items = evalPath(body, spec.items_path);
    } catch (e) {
      return { ok: false, error: (e as Error).message, pages, requests: pages };
    }
    for (const raw of items) {
      const item = asItem(raw);
      if (!item || typeof item.id !== "string") continue;
      let marker: string | null = null;
      if (spec.marker_path !== null) {
        const found = evalPath(item, spec.marker_path)[0];
        marker = typeof found === "string" ? found : null;
        if (marker !== ctx.marker) continue; // the probe keeps only objects carrying this intent's marker at its marker_path
      }
      records.push({ id: item.id, marker, item });
    }
    if (!spec.pagination) return { ok: true, records, pages, requests: pages, complete: true };
    const next = evalPath(body, spec.pagination.next_path)[0];
    if (typeof next !== "string" || next === "") return { ok: true, records, pages, requests: pages, complete: true };
    if (pages >= maxPages) return { ok: true, records, pages, requests: pages, complete: false };
    cursor = next;
  }
}

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const o = asItem(v);
  if (o) for (const [k, x] of Object.entries(o)) if (typeof x === "string") out[k] = x;
  return out;
}

/**
 * Project probe records onto the frozen ProviderObject shape for matchEvidence. Fixed code, NotifySim's documented object schema:
 * recipient → payee_ref, amount_minor (null → 0), currency (null → ""), status, metadata (string values), created_at, kind "message"
 * (CP-LETTER-1). With provider notify_letter the fixed matcher accepts status "sent"; it still requires marker, amount, currency, payee.
 */
export function toProviderObjects(records: readonly ProbeRecord[]): ProviderObject[] {
  return records.map((r) => {
    const it = r.item;
    return {
      id: r.id,
      kind: "message",
      status: typeof it.status === "string" ? it.status : "unknown",
      amount_minor: typeof it.amount_minor === "number" && Number.isSafeInteger(it.amount_minor) && it.amount_minor >= 0 ? it.amount_minor : 0,
      currency: typeof it.currency === "string" ? it.currency : "",
      payee_ref: typeof it.recipient === "string" ? it.recipient : typeof it.payee_ref === "string" ? it.payee_ref : "",
      parent_ref: null,
      metadata: stringRecord(it.metadata),
      created_at: typeof it.created_at === "string" ? it.created_at : "",
    };
  });
}
