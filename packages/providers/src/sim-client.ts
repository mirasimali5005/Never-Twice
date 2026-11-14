// The one simulator client behind SimPayoutProvider and SimKeylessProvider (task C2; ARCHITECTURE.md §7.2, §7.3).
// Both call POST /v1/payouts and differ only in the rail they send and in whether they send Idempotency-Key.
// The body is exactly frozenRequestBody(req) = canonicalJson(whole FrozenRequest), so its SHA-256 is frozen_request_sha256.
// No retries here: the gateway owns retries. Outcomes are values; only programmer/configuration errors throw.
import { ProviderObject, frozenRequestBody } from "@nt/contracts";
import type { DispatchResult, FrozenRequest, PaymentProvider, ProviderCapabilities } from "@nt/contracts";
import { ProviderConfigError, ProviderReadError, httpRequest, parseJson } from "./http.ts";
import type { HttpOutcome } from "./http.ts";

export type SimClientOptions = {
  baseUrl: string;
  account: string;
  writeKey: string;
  readKey: string;
  /** Timeout for GET requests (account lookup, reads). Default 5000. The POST timeout is `opts.timeoutMs` of each call. */
  readTimeoutMs?: number;
};

export type SimAccountInfo = { account: string; retention_ms: number; max_in_flight_ms: number | null; search_lag_ms: number };

/** Safety valve for findOperationEvidence: at most this many pages (ARCHITECTURE.md / AGENT_TASKS C2). */
export const MAX_EVIDENCE_PAGES = 50;
const PAGE_LIMIT = 100;
const DEFAULT_READ_TIMEOUT_MS = 5000;

export type SimRail = "instant" | "legacy";

type Spec = { id: "sim_payout" | "sim_keyless"; rail: SimRail };

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

function errorBody(text: string): { code: string; message: string } {
  const p = parseJson(text);
  if (p.ok && typeof p.value === "object" && p.value !== null) {
    const e = (p.value as { error?: unknown }).error;
    if (typeof e === "object" && e !== null) {
      const { code, message } = e as { code?: unknown; message?: unknown };
      return { code: typeof code === "string" ? code : "unknown", message: typeof message === "string" ? message : "" };
    }
  }
  return { code: "unknown", message: text.slice(0, 200) };
}

/** Reads GET /v1/accounts/:account once. Anything but a 200 with the expected shape is a configuration error. */
export async function readAccount(o: SimClientOptions): Promise<SimAccountInfo> {
  const out = await httpRequest(`${trimSlash(o.baseUrl)}/v1/accounts/${encodeURIComponent(o.account)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${o.readKey}`, Accept: "application/json" },
    timeoutMs: o.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
  });
  if (out.kind !== "response") throw new ProviderConfigError(`cannot read simulator account ${o.account}: ${out.kind} (${out.detail})`);
  if (out.status !== 200) throw new ProviderConfigError(`cannot read simulator account ${o.account}: HTTP ${out.status}`);
  const p = parseJson(out.text);
  const v = p.ok ? (p.value as Partial<SimAccountInfo> | null) : null;
  if (
    !v ||
    typeof v.retention_ms !== "number" ||
    !(v.max_in_flight_ms === null || typeof v.max_in_flight_ms === "number") ||
    typeof v.search_lag_ms !== "number"
  ) {
    throw new ProviderConfigError(`simulator account ${o.account}: unexpected response shape`);
  }
  return { account: o.account, retention_ms: v.retention_ms, max_in_flight_ms: v.max_in_flight_ms, search_lag_ms: v.search_lag_ms };
}

export class SimClient implements PaymentProvider {
  readonly id: "sim_payout" | "sim_keyless";
  readonly capabilities: ProviderCapabilities;
  readonly account: string;
  /** Account facts read once at construction (search_lag_ms is informational: the clients never use the search path). */
  readonly accountInfo: SimAccountInfo;
  readonly #rail: SimRail;
  readonly #base: string;
  readonly #writeKey: string;
  readonly #readKey: string;
  readonly #readTimeoutMs: number;

  protected constructor(spec: Spec, o: SimClientOptions, info: SimAccountInfo) {
    this.id = spec.id;
    this.#rail = spec.rail;
    this.account = o.account;
    this.accountInfo = info;
    this.#base = trimSlash(o.baseUrl);
    this.#writeKey = o.writeKey;
    this.#readKey = o.readKey;
    this.#readTimeoutMs = o.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    const dedupes = spec.rail === "instant";
    this.capabilities = {
      dedupesOnIdempotencyKey: dedupes,
      keyRetentionMs: dedupes ? info.retention_ms : null,
      declaredMaxInFlightMs: info.max_in_flight_ms,
      stronglyConsistentList: true,
    };
  }

  // ---------------------------------------------------------------- the one write

  async createPaymentOrRefund(req: FrozenRequest, opts: { idempotencyKey: string | null; timeoutMs: number }): Promise<DispatchResult> {
    if (req.provider !== this.id) throw new ProviderConfigError(`${this.id} client given a request for provider ${req.provider}`);
    if (req.rail !== this.#rail) throw new ProviderConfigError(`${this.id} client sends rail ${this.#rail}, request has rail ${String(req.rail)}`);
    if (req.account !== this.account) throw new ProviderConfigError(`client is bound to account ${this.account}, request names ${req.account}`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#writeKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.#rail === "instant") {
      if (opts.idempotencyKey === null) throw new ProviderConfigError("sim_payout requires a non-null idempotencyKey");
      headers["Idempotency-Key"] = opts.idempotencyKey;
    } else if (opts.idempotencyKey !== null) {
      throw new ProviderConfigError("sim_keyless never sends an idempotency key; idempotencyKey must be null");
    }
    // The exact bytes: canonicalJson of the whole frozen request (throws on an invalid request: programmer error).
    const body = Buffer.from(frozenRequestBody(req), "utf8");
    const out = await httpRequest(`${this.#base}/v1/payouts`, { method: "POST", headers, body, timeoutMs: opts.timeoutMs });
    return this.#mapPost(out);
  }

  /** The only place an HTTP status of the POST is interpreted (ARCHITECTURE.md §7.3, AGENT_TASKS C2 mapping table). */
  #mapPost(out: HttpOutcome): DispatchResult {
    if (out.kind === "timeout") return { kind: "INDETERMINATE", cause: "TIMEOUT", detail: out.detail };
    if (out.kind === "connection") return { kind: "INDETERMINATE", cause: "CONNECTION", detail: out.detail };
    const { status } = out;
    const replayed = out.headers.get("idempotent-replayed") === "true";
    if (status === 201) {
      const p = parseJson(out.text);
      const obj = p.ok ? ProviderObject.safeParse(p.value) : null;
      if (obj === null || !obj.success) {
        return { kind: "CONTRADICTION", code: "UNEXPECTED_OBJECT", detail: "HTTP 201 body does not parse as a ProviderObject" };
      }
      return { kind: "ACCEPTED", object: obj.data, replayed };
    }
    if (status === 400) {
      const e = errorBody(out.text);
      return { kind: "REJECTED_DEFINITIVE", code: e.code, message: e.message, replayed };
    }
    if (status === 409) return { kind: "INDETERMINATE", cause: "IN_PROGRESS_CONFLICT", detail: `HTTP 409 ${errorBody(out.text).code}` };
    if (status === 422) {
      return { kind: "CONTRADICTION", code: "KEY_REUSED_DIFFERENT_PARAMS", detail: `HTTP 422 ${errorBody(out.text).code}` };
    }
    if (status >= 500) return { kind: "INDETERMINATE", cause: "SERVER_ERROR", detail: `HTTP ${status}` };
    if (status === 401 || status === 403 || status === 404) {
      throw new ProviderConfigError(`simulator refused the POST with HTTP ${status} (${errorBody(out.text).code}): check the write key, URL and account`);
    }
    if (status >= 200 && status < 300) {
      // A success status the simulator never sends: an object may exist that we cannot account for.
      return { kind: "CONTRADICTION", code: "UNEXPECTED_OBJECT", detail: `unexpected success status HTTP ${status}` };
    }
    // Any other status (3xx, 408, 429, other 4xx) is not a definitive rejection by the simulator's contract: unknown outcome.
    return { kind: "INDETERMINATE", cause: "SERVER_ERROR", detail: `unexpected HTTP ${status}` };
  }

  // ---------------------------------------------------------------- reads (GET only, read key)

  async #get(path: string): Promise<HttpOutcome> {
    return httpRequest(`${this.#base}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.#readKey}`, Accept: "application/json" },
      timeoutMs: this.#readTimeoutMs,
    });
  }

  async getOperation(providerObjectId: string): Promise<ProviderObject | null> {
    const out = await this.#get(`/v1/payouts/${encodeURIComponent(providerObjectId)}`);
    if (out.kind !== "response") throw new ProviderReadError(`getOperation: ${out.kind} (${out.detail})`);
    if (out.status === 404) return null;
    if (out.status === 401 || out.status === 403) throw new ProviderConfigError(`getOperation: HTTP ${out.status}: check the read key`);
    if (out.status !== 200) throw new ProviderReadError(`getOperation: HTTP ${out.status}`);
    const p = parseJson(out.text);
    const obj = p.ok ? ProviderObject.safeParse(p.value) : null;
    if (obj === null || !obj.success) throw new ProviderReadError("getOperation: body does not parse as a ProviderObject");
    return obj.data;
  }

  /** One page of GET /v1/payouts. `bad` counts objects that did not parse (they are skipped, and make the read incomplete). */
  async #page(q: { account: string; payeeRef?: string; since?: Date; after: string | null }): Promise<
    | { ok: true; data: ProviderObject[]; bad: number; next: string | null }
    | { ok: false; why: string }
  > {
    const params = new URLSearchParams({ account: q.account, limit: String(PAGE_LIMIT) });
    if (q.payeeRef !== undefined) params.set("payee_ref", q.payeeRef);
    if (q.since !== undefined) params.set("created_gte", q.since.toISOString());
    if (q.after !== null) params.set("starting_after", q.after);
    const out = await this.#get(`/v1/payouts?${params.toString()}`);
    if (out.kind !== "response") return { ok: false, why: `${out.kind} (${out.detail})` };
    if (out.status === 401 || out.status === 403) throw new ProviderConfigError(`list: HTTP ${out.status}: check the read key`);
    if (out.status !== 200) return { ok: false, why: `HTTP ${out.status}` };
    const p = parseJson(out.text);
    const v = p.ok ? (p.value as { data?: unknown; has_more?: unknown; next_cursor?: unknown } | null) : null;
    if (!v || !Array.isArray(v.data) || typeof v.has_more !== "boolean") return { ok: false, why: "list body has an unexpected shape" };
    const data: ProviderObject[] = [];
    let bad = 0;
    for (const item of v.data) {
      const o = ProviderObject.safeParse(item);
      if (o.success) data.push(o.data);
      else bad += 1;
    }
    let next: string | null = null;
    if (v.has_more) {
      if (typeof v.next_cursor !== "string" || v.next_cursor === "") return { ok: false, why: "has_more without a next_cursor" };
      next = v.next_cursor;
    }
    return { ok: true, data, bad, next };
  }

  /** Lists by payee since `since` and follows `next_cursor` to the end (cap MAX_EVIDENCE_PAGES). `complete` is true only if every
   *  page was read and parsed; on any error it returns what was read with `complete: false`. Absence is never proof. */
  async findOperationEvidence(q: {
    account: string;
    payeeRef: string;
    parentRef: string | null;
    since: Date;
  }): Promise<{ records: ProviderObject[]; complete: boolean }> {
    const records: ProviderObject[] = [];
    let after: string | null = null;
    let complete = true;
    for (let page = 0; ; page++) {
      if (page >= MAX_EVIDENCE_PAGES) {
        complete = false;
        break;
      }
      const r = await this.#page({ account: q.account, payeeRef: q.payeeRef, since: q.since, after });
      if (!r.ok) {
        complete = false;
        break;
      }
      records.push(...r.data);
      if (r.bad > 0) complete = false;
      if (r.next === null) break;
      after = r.next;
    }
    // The simulator list has no parent filter; for the simulator parent_ref is null on payouts, so parentRef is not applied here.
    return { records, complete };
  }

  /** GET /v1/search/payouts?account=&marker= (read key). The simulator's search LAGS by search_lag_ms: an empty answer is never
   *  evidence of absence. Added in task B3 for the investigator's read-only view (search_provider_payments). */
  async searchOperations(q: { account: string; marker: string }): Promise<ProviderObject[]> {
    const params = new URLSearchParams({ account: q.account, marker: q.marker });
    const out = await this.#get(`/v1/search/payouts?${params.toString()}`);
    if (out.kind !== "response") throw new ProviderReadError(`searchOperations: ${out.kind} (${out.detail})`);
    if (out.status === 401 || out.status === 403) throw new ProviderConfigError(`searchOperations: HTTP ${out.status}: check the read key`);
    if (out.status !== 200) throw new ProviderReadError(`searchOperations: HTTP ${out.status}`);
    const p = parseJson(out.text);
    const v = p.ok ? (p.value as { data?: unknown } | null) : null;
    if (!v || !Array.isArray(v.data)) throw new ProviderReadError("searchOperations: body has an unexpected shape");
    const res: ProviderObject[] = [];
    for (const item of v.data) {
      const o = ProviderObject.safeParse(item);
      if (o.success) res.push(o.data);
    }
    return res;
  }

  /** GET /v1/events?account=&since= (read key; Tier 2): delayed and unordered, corroboration only. Added in task B3. */
  async listEvents(q: { account: string; since?: Date }): Promise<{ type: string; object_id: string; at: string }[]> {
    const params = new URLSearchParams({ account: q.account });
    if (q.since !== undefined) params.set("since", q.since.toISOString());
    const out = await this.#get(`/v1/events?${params.toString()}`);
    if (out.kind !== "response") throw new ProviderReadError(`listEvents: ${out.kind} (${out.detail})`);
    if (out.status === 401 || out.status === 403) throw new ProviderConfigError(`listEvents: HTTP ${out.status}: check the read key`);
    if (out.status !== 200) throw new ProviderReadError(`listEvents: HTTP ${out.status}`);
    const p = parseJson(out.text);
    const v = p.ok ? (p.value as { data?: unknown } | null) : null;
    if (!v || !Array.isArray(v.data)) throw new ProviderReadError("listEvents: body has an unexpected shape");
    const res: { type: string; object_id: string; at: string }[] = [];
    for (const e of v.data as { type?: unknown; object_id?: unknown; created_at?: unknown }[]) {
      if (typeof e?.type === "string" && typeof e.object_id === "string" && typeof e.created_at === "string") {
        res.push({ type: e.type, object_id: e.object_id, at: e.created_at });
      }
    }
    return res;
  }

  /** Every object of the account (optionally since a time), page by page. Throws ProviderReadError if a page cannot be read. */
  async *listOperations(scope: { account: string; since?: Date }): AsyncGenerator<ProviderObject> {
    let after: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const q: { account: string; since?: Date; after: string | null } = { account: scope.account, after };
      if (scope.since !== undefined) q.since = scope.since;
      const r = await this.#page(q);
      if (!r.ok) throw new ProviderReadError(`listOperations: ${r.why}`);
      if (r.bad > 0) throw new ProviderReadError(`listOperations: ${r.bad} object(s) did not parse as a ProviderObject`);
      for (const o of r.data) yield o;
      if (r.next === null) return;
      if (seen.has(r.next)) throw new ProviderReadError("listOperations: pagination cursor repeated");
      seen.add(r.next);
      after = r.next;
    }
  }
}
