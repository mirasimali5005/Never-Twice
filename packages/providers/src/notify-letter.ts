// NotifyLetterProvider: provider id "notify_letter" (Tier 3, change proposal CP-LETTER-1). Sends a claim's DECISION LETTER through
// NotifySim (POST /v1/messages, write key). NotifySim is KEYLESS: it ignores any idempotency key, so this client never sends one and
// recovery can never licence a re-send (capabilities.dedupesOnIdempotencyKey is false). Only an admitted generated probe, or this
// client's strongly consistent list, can show a lost letter was sent. A letter is never a payment: amount_minor is 0.
import { ProviderObject } from "@nt/contracts";
import type { DispatchResult, FrozenRequest, PaymentProvider, ProviderCapabilities } from "@nt/contracts";
import { ProviderConfigError, ProviderReadError, httpRequest, parseJson } from "./http.ts";
import type { HttpOutcome } from "./http.ts";

export type NotifyLetterOptions = { baseUrl: string; account: string; writeKey: string; readKey: string; readTimeoutMs?: number };

export const LETTER_TEMPLATE = "decision_letter_v1";
const PAGE_LIMIT = 20; // NotifySim's page cap
const MAX_PAGES = 50;

/** NotifySim message → ProviderObject (kind "message"; recipient → payee_ref). null when the body is not a message. */
export function messageToObject(v: unknown): ProviderObject | null {
  if (v === null || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  if (m.object !== "message" || typeof m.id !== "string" || typeof m.recipient !== "string") return null;
  const md: Record<string, string> = {};
  if (m.metadata && typeof m.metadata === "object") for (const [k, x] of Object.entries(m.metadata as object)) if (typeof x === "string") md[k] = x;
  const o = ProviderObject.safeParse({
    id: m.id,
    kind: "message",
    status: typeof m.status === "string" ? m.status : "unknown",
    amount_minor: typeof m.amount_minor === "number" ? m.amount_minor : 0,
    currency: typeof m.currency === "string" ? m.currency : "",
    payee_ref: m.recipient,
    parent_ref: null,
    metadata: md,
    created_at: typeof m.created_at === "string" ? m.created_at : "",
  });
  return o.success ? o.data : null;
}

/** The exact NotifySim body for a frozen letter request (deterministic; built only from the frozen request). */
export function letterBody(req: FrozenRequest): string {
  return JSON.stringify({
    account: req.account,
    recipient: req.payee_ref,
    template: LETTER_TEMPLATE,
    amount_minor: req.amount_minor,
    currency: req.currency,
    metadata: req.metadata,
  });
}

export class NotifyLetterProvider implements PaymentProvider {
  readonly id = "notify_letter" as const;
  readonly capabilities: ProviderCapabilities = { dedupesOnIdempotencyKey: false, keyRetentionMs: null, declaredMaxInFlightMs: null, stronglyConsistentList: true };
  readonly account: string;
  readonly #base: string;
  readonly #writeKey: string;
  readonly #readKey: string;
  readonly #readTimeoutMs: number;

  constructor(o: NotifyLetterOptions) {
    this.account = o.account;
    this.#base = o.baseUrl.replace(/\/+$/, "");
    this.#writeKey = o.writeKey;
    this.#readKey = o.readKey;
    this.#readTimeoutMs = o.readTimeoutMs ?? 5000;
  }

  async createPaymentOrRefund(req: FrozenRequest, opts: { idempotencyKey: string | null; timeoutMs: number }): Promise<DispatchResult> {
    if (req.provider !== "notify_letter" || req.operation !== "NOTIFY") throw new ProviderConfigError(`notify_letter client given ${req.provider}/${req.operation}`);
    if (req.account !== this.account) throw new ProviderConfigError(`client is bound to account ${this.account}, request names ${req.account}`);
    if (opts.idempotencyKey !== null) throw new ProviderConfigError("notify_letter is keyless; idempotencyKey must be null");
    const out = await httpRequest(`${this.#base}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#writeKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: Buffer.from(letterBody(req), "utf8"),
      timeoutMs: opts.timeoutMs,
    });
    return this.#mapPost(out);
  }

  #mapPost(out: HttpOutcome): DispatchResult {
    if (out.kind === "timeout") return { kind: "INDETERMINATE", cause: "TIMEOUT", detail: out.detail };
    if (out.kind === "connection") return { kind: "INDETERMINATE", cause: "CONNECTION", detail: out.detail };
    const { status } = out;
    if (status === 201) {
      const p = parseJson(out.text);
      const obj = p.ok ? messageToObject(p.value) : null;
      if (!obj) return { kind: "CONTRADICTION", code: "UNEXPECTED_OBJECT", detail: "HTTP 201 body is not a NotifySim message" };
      return { kind: "ACCEPTED", object: obj, replayed: false };
    }
    if (status === 400) {
      const p = parseJson(out.text);
      const e = (p.ok ? (p.value as { error?: { code?: unknown; message?: unknown } })?.error : undefined) ?? {};
      return { kind: "REJECTED_DEFINITIVE", code: typeof e.code === "string" ? e.code : "unknown", message: typeof e.message === "string" ? e.message : "", replayed: false };
    }
    if (status === 409) return { kind: "INDETERMINATE", cause: "IN_PROGRESS_CONFLICT", detail: "HTTP 409" };
    if (status === 401 || status === 403 || status === 404) throw new ProviderConfigError(`NotifySim refused the POST with HTTP ${status}: check the write key and URL`);
    return { kind: "INDETERMINATE", cause: "SERVER_ERROR", detail: `HTTP ${status}` };
  }

  async #get(path: string): Promise<HttpOutcome> {
    return httpRequest(`${this.#base}${path}`, { method: "GET", headers: { Authorization: `Bearer ${this.#readKey}`, Accept: "application/json" }, timeoutMs: this.#readTimeoutMs });
  }

  async getOperation(id: string): Promise<ProviderObject | null> {
    const out = await this.#get(`/v1/messages/${encodeURIComponent(id)}`);
    if (out.kind !== "response") throw new ProviderReadError(`getOperation: ${out.kind}`);
    if (out.status === 404) return null;
    if (out.status !== 200) throw new ProviderReadError(`getOperation: HTTP ${out.status}`);
    const p = parseJson(out.text);
    return p.ok ? messageToObject(p.value) : null;
  }

  async #page(q: { account: string; payeeRef?: string; since?: Date; after: string | null }): Promise<{ ok: true; data: ProviderObject[]; next: string | null } | { ok: false; why: string }> {
    const params = new URLSearchParams({ account: q.account, limit: String(PAGE_LIMIT) });
    if (q.payeeRef !== undefined) params.set("recipient", q.payeeRef);
    if (q.since !== undefined) params.set("created_gte", q.since.toISOString());
    if (q.after !== null) params.set("starting_after", q.after);
    const out = await this.#get(`/v1/messages?${params.toString()}`);
    if (out.kind !== "response") return { ok: false, why: out.kind };
    if (out.status !== 200) return { ok: false, why: `HTTP ${out.status}` };
    const p = parseJson(out.text);
    const v = p.ok ? (p.value as { data?: unknown; next_cursor?: unknown } | null) : null;
    if (!v || !Array.isArray(v.data)) return { ok: false, why: "unexpected list shape" };
    const data = v.data.map(messageToObject).filter((x): x is ProviderObject => x !== null);
    return { ok: true, data, next: typeof v.next_cursor === "string" && v.next_cursor !== "" ? v.next_cursor : null };
  }

  /** The strongly consistent list by recipient (used by the invariant scan and as a fallback; recovery of a letter uses the admitted probe). */
  async findOperationEvidence(q: { account: string; payeeRef: string; parentRef: string | null; since: Date }): Promise<{ records: ProviderObject[]; complete: boolean }> {
    const records: ProviderObject[] = [];
    let after: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await this.#page({ account: q.account, payeeRef: q.payeeRef, since: q.since, after });
      if (!r.ok) return { records, complete: false };
      records.push(...r.data);
      if (r.next === null) return { records, complete: true };
      after = r.next;
    }
    return { records, complete: false };
  }

  async *listOperations(scope: { account: string; since?: Date }): AsyncGenerator<ProviderObject> {
    let after: string | null = null;
    for (let i = 0; i < 10_000; i++) {
      const r = await this.#page({ account: scope.account, ...(scope.since ? { since: scope.since } : {}), after });
      if (!r.ok) throw new ProviderReadError(`listOperations: ${r.why}`);
      for (const o of r.data) yield o;
      if (r.next === null) return;
      after = r.next;
    }
  }
}
