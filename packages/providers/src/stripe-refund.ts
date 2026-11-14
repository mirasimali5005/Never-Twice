// StripeRefundProvider: the Stripe TEST-MODE ticket-refund leg (task C3; HANDOVER §12.3; ARCHITECTURE.md §8). Tier 1, never cut.
// Only the ticket-refund leg uses Stripe; compensation stays on the simulator. Only the gateway calls createPaymentOrRefund.
// Safety: the constructor refuses any key that is not ^(sk|rk)_test_ ; the key is never logged, never put in an error message.
//
// Stripe facts relied on (HANDOVER §12.3) and how this adapter honours them:
//   - v1 idempotency keys are kept >= 24 h; the same key with different parameters is an idempotency error -> CONTRADICTION.
//   - there is no lookup by idempotency key; the marker travels in metadata.nt_marker and evidence is `refunds.list`, never Search.
//   - top-level list endpoints are immediately consistent -> stronglyConsistentList true.
//   - a 5xx or a timeout is indeterminate; the SDK must not retry on its own (maxNetworkRetries 0, plus the hidden-retry guard below).
import Stripe from "stripe";
import { ProviderObject, STRIPE_TEST_KEY_RE } from "@nt/contracts";
import type { DispatchResult, FrozenRequest, PaymentProvider, ProviderCapabilities } from "@nt/contracts";
import { ProviderConfigError, ProviderReadError } from "./http.ts";

type SdkConfig = NonNullable<ConstructorParameters<typeof Stripe>[1]>;
type SdkHttpClient = NonNullable<SdkConfig["httpClient"]>;
type Refund = Stripe.Refund;

export const STRIPE_CAPABILITIES: ProviderCapabilities = {
  dedupesOnIdempotencyKey: true,
  keyRetentionMs: 86_400_000,
  declaredMaxInFlightMs: null,
  stronglyConsistentList: true,
};

/** Pages of `refunds.list` read for one payment intent before evidence is declared incomplete. */
export const MAX_REFUND_LIST_PAGES = 10;

/** Throws ProviderConfigError unless the key is a Stripe TEST-mode secret or restricted key. Never echoes the key. */
export function assertStripeTestKey(secretKey: string): void {
  if (typeof secretKey !== "string" || !STRIPE_TEST_KEY_RE.test(secretKey)) {
    throw new ProviderConfigError("Stripe key refused: it must be a test-mode key (prefix sk_test_ or rk_test_). Live keys are never accepted.");
  }
}

/** The parameter object of `stripe.refunds.create`, built deterministically from the frozen request. "Identical bytes" for Stripe means
 *  this identical object (HANDOVER §9.3). A Stripe refund has no payee field, so the payee travels as metadata.nt_payee_ref. */
export function buildRefundParams(req: FrozenRequest): Stripe.RefundCreateParams {
  if (req.parent_ref === null || !req.parent_ref.startsWith("pi_")) {
    throw new ProviderConfigError("stripe_refund needs parent_ref = a PaymentIntent id (pi_...)");
  }
  return {
    payment_intent: req.parent_ref,
    amount: req.amount_minor,
    reason: "requested_by_customer",
    metadata: {
      nt_marker: req.metadata.nt_marker,
      nt_effect_key: req.metadata.nt_effect_key,
      nt_run_id: req.metadata.nt_run_id,
      nt_payee_ref: req.payee_ref,
    },
  };
}

/** Maps a Stripe refund to a ProviderObject. payee_ref comes from metadata.nt_payee_ref ("" if absent, which the matcher will reject);
 *  parent_ref from payment_intent; currency is upper-cased. */
export function mapRefund(r: Refund): ProviderObject {
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.metadata ?? {})) if (typeof v === "string") metadata[k] = v;
  const pi = r.payment_intent;
  return {
    id: r.id,
    kind: "refund",
    status: r.status ?? "",
    amount_minor: r.amount,
    currency: r.currency.toUpperCase(),
    payee_ref: metadata["nt_payee_ref"] ?? "",
    parent_ref: pi === null || pi === undefined ? null : typeof pi === "string" ? pi : pi.id,
    metadata,
    created_at: new Date(r.created * 1000).toISOString(),
  };
}

/** The SDK retries a request once on ECONNRESET/EPIPE even when maxNetworkRetries is 0 (stripe 23.1.0, RequestSender._shouldRetry). That
 *  would be a second transmission the gateway never recorded. Rewriting the error code on the way out makes the SDK treat it as an
 *  ordinary connection error, so the gateway alone decides whether anything is sent again. */
function noHiddenRetry(base: SdkHttpClient): SdkHttpClient {
  return {
    getClientName: () => base.getClientName(),
    makeRequest: async (...args) => {
      try {
        return await base.makeRequest(...args);
      } catch (e) {
        const x = e as { code?: string } | null;
        if (x && (x.code === "ECONNRESET" || x.code === "EPIPE")) {
          (x as { code?: string; ntOriginalCode?: string }).ntOriginalCode = x.code;
          x.code = "NT_CONNECTION_CLOSED";
        }
        throw e;
      }
    },
  } as SdkHttpClient;
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

type Classified =
  | { kind: "INDETERMINATE"; cause: "TIMEOUT" | "CONNECTION" | "SERVER_ERROR" | "IN_PROGRESS_CONFLICT"; detail: string }
  | { kind: "CONTRADICTION"; code: "KEY_REUSED_DIFFERENT_PARAMS"; detail: string }
  | { kind: "OTHER_4XX"; code: string; message: string; replayed: boolean };

/** Maps an SDK error to an outcome class. Never includes a key or a request body in `detail`. */
function classify(err: unknown): Classified {
  if (!(err instanceof Stripe.errors.StripeError)) {
    // Not a Stripe API error (an SDK-internal failure). It is not provably a rejection, so it is an unknown outcome.
    const name = err instanceof Error ? err.name : typeof err;
    return { kind: "INDETERMINATE", cause: "CONNECTION", detail: `non-Stripe error ${name}` };
  }
  if (err instanceof Stripe.errors.StripeConnectionError) {
    const code = (err.detail as { code?: string } | undefined)?.code;
    const timedOut = code === "ETIMEDOUT" || /timeout/i.test(err.message);
    return { kind: "INDETERMINATE", cause: timedOut ? "TIMEOUT" : "CONNECTION", detail: timedOut ? "Stripe request timed out" : "Stripe connection error" };
  }
  if (err instanceof Stripe.errors.StripeIdempotencyError) {
    return { kind: "CONTRADICTION", code: "KEY_REUSED_DIFFERENT_PARAMS", detail: `Stripe idempotency error: ${err.message}`.slice(0, 300) };
  }
  const status = err.statusCode;
  if (status === 409) return { kind: "INDETERMINATE", cause: "IN_PROGRESS_CONFLICT", detail: "Stripe HTTP 409 (request with this key in progress)" };
  if (status === 429 || err instanceof Stripe.errors.StripeRateLimitError) {
    // Rate limiting means the request was not processed and may be retried under the same key: never a definitive rejection.
    return { kind: "INDETERMINATE", cause: "SERVER_ERROR", detail: "Stripe HTTP 429 (rate limited)" };
  }
  if (status === undefined || status >= 500) {
    return { kind: "INDETERMINATE", cause: "SERVER_ERROR", detail: `Stripe HTTP ${status ?? "unknown"}` };
  }
  return {
    kind: "OTHER_4XX",
    code: err.code ?? err.type,
    message: err.message.slice(0, 300),
    replayed: headerOf(err.headers, "idempotent-replayed") === "true",
  };
}

export type StripeRefundOptions = {
  secretKey: string;
  /** Default timeout of every SDK request, ms (a per-call `timeoutMs` overrides it for the refund POST). */
  timeoutMs: number;
  /** listOperations keeps only refunds whose metadata.nt_run_id equals this; unset keeps every refund that carries an nt_marker. */
  runId?: string;
  /** TEST ONLY: send SDK traffic to a loopback stub instead of api.stripe.com. Refused for any non-loopback host. */
  testTransport?: { host: "127.0.0.1" | "localhost" | "::1"; port: number; protocol: "http" };
};

export class StripeRefundProvider implements PaymentProvider {
  readonly id = "stripe_refund" as const;
  readonly capabilities: ProviderCapabilities = { ...STRIPE_CAPABILITIES };
  readonly #stripe: Stripe;
  readonly #timeoutMs: number;
  readonly #runId: string | undefined;

  constructor(o: StripeRefundOptions) {
    assertStripeTestKey(o.secretKey);
    if (!Number.isSafeInteger(o.timeoutMs) || o.timeoutMs < 1) throw new ProviderConfigError("StripeRefundProvider needs an explicit timeoutMs >= 1");
    const cfg: SdkConfig = {
      maxNetworkRetries: 0,
      timeout: o.timeoutMs,
      telemetry: false,
      httpClient: noHiddenRetry(Stripe.createNodeHttpClient()),
    };
    if (o.testTransport !== undefined) {
      if (!["127.0.0.1", "localhost", "::1"].includes(o.testTransport.host)) throw new ProviderConfigError("testTransport must be loopback");
      cfg.host = o.testTransport.host;
      cfg.port = o.testTransport.port;
      cfg.protocol = o.testTransport.protocol;
    }
    this.#stripe = new Stripe(o.secretKey, cfg);
    this.#timeoutMs = o.timeoutMs;
    this.#runId = o.runId;
  }

  // ---------------------------------------------------------------- the one write

  async createPaymentOrRefund(req: FrozenRequest, opts: { idempotencyKey: string | null; timeoutMs: number }): Promise<DispatchResult> {
    if (req.provider !== "stripe_refund") throw new ProviderConfigError(`stripe_refund client given a request for provider ${req.provider}`);
    if (req.operation !== "REFUND") throw new ProviderConfigError("stripe_refund only performs REFUND operations");
    if (opts.idempotencyKey === null || opts.idempotencyKey === "") throw new ProviderConfigError("stripe_refund requires a non-null idempotencyKey (the marker)");
    const params = buildRefundParams(req); // throws on a bad parent_ref (programmer error) before anything is sent
    try {
      const refund = await this.#stripe.refunds.create(params, {
        idempotencyKey: opts.idempotencyKey,
        timeout: opts.timeoutMs,
        maxNetworkRetries: 0,
      });
      const replayed = headerOf(refund.lastResponse?.headers, "idempotent-replayed") === "true";
      const parsed = ProviderObject.safeParse(mapRefund(refund));
      if (!parsed.success) return { kind: "CONTRADICTION", code: "UNEXPECTED_OBJECT", detail: "Stripe refund does not map to a ProviderObject" };
      return { kind: "ACCEPTED", object: parsed.data, replayed };
    } catch (e) {
      const c = classify(e);
      if (c.kind === "INDETERMINATE" || c.kind === "CONTRADICTION") return c;
      return this.#afterOther4xx(req, params.payment_intent as string, c);
    }
  }

  /** Any other 4xx is REJECTED_DEFINITIVE only after a complete evidence list shows no refund carrying the marker (HANDOVER §12.3). */
  async #afterOther4xx(req: FrozenRequest, paymentIntent: string, c: Extract<Classified, { kind: "OTHER_4XX" }>): Promise<DispatchResult> {
    const ev = await this.findOperationEvidence({ account: req.account, payeeRef: req.payee_ref, parentRef: paymentIntent, since: new Date(0) });
    const marker = req.metadata.nt_marker;
    const hits = ev.records.filter((r) => r.metadata["nt_marker"] === marker);
    if (hits.length === 1) return { kind: "ACCEPTED", object: hits[0]!, replayed: true };
    if (hits.length > 1) {
      return { kind: "CONTRADICTION", code: "UNEXPECTED_OBJECT", detail: `${hits.length} Stripe refunds carry the marker after a 4xx` };
    }
    if (!ev.complete) {
      return { kind: "INDETERMINATE", cause: "SERVER_ERROR", detail: "Stripe returned a 4xx and the evidence list could not be read completely" };
    }
    return { kind: "REJECTED_DEFINITIVE", code: c.code, message: c.message, replayed: c.replayed };
  }

  // ---------------------------------------------------------------- reads (list / retrieve only; never mutate)

  async getOperation(providerObjectId: string): Promise<ProviderObject | null> {
    try {
      const r = await this.#stripe.refunds.retrieve(providerObjectId, undefined, { timeout: this.#timeoutMs, maxNetworkRetries: 0 });
      return mapRefund(r);
    } catch (e) {
      if (e instanceof Stripe.errors.StripeError && e.statusCode === 404) return null;
      if (e instanceof Stripe.errors.StripeAuthenticationError || e instanceof Stripe.errors.StripePermissionError) {
        throw new ProviderConfigError("getOperation: Stripe refused the key (check STRIPE_SECRET_KEY)");
      }
      throw new ProviderReadError(`getOperation: ${classify(e).kind === "OTHER_4XX" ? "Stripe rejected the read" : "Stripe read failed"}`);
    }
  }

  /** `refunds.list({ payment_intent, limit: 100 })` (top-level list: immediately consistent; never the Search API), following pages up to
   *  MAX_REFUND_LIST_PAGES. Every refund of the payment intent is returned (the fixed matcher filters on the marker). `complete` is true only
   *  if the last page had no more; on any failure it returns what was read with `complete: false`. */
  async findOperationEvidence(q: { account: string; payeeRef: string; parentRef: string | null; since: Date }): Promise<{ records: ProviderObject[]; complete: boolean }> {
    if (q.parentRef === null) return { records: [], complete: false }; // no payment intent: nothing can be listed, and absence is not proof
    const records: ProviderObject[] = [];
    let after: string | undefined;
    try {
      for (let page = 0; page < MAX_REFUND_LIST_PAGES; page++) {
        const params: Stripe.RefundListParams = { payment_intent: q.parentRef, limit: 100 };
        if (after !== undefined) params.starting_after = after;
        const list = await this.#stripe.refunds.list(params, { timeout: this.#timeoutMs, maxNetworkRetries: 0 });
        for (const r of list.data) records.push(mapRefund(r));
        if (!list.has_more) return { records, complete: true };
        const last = list.data[list.data.length - 1];
        if (last === undefined) return { records, complete: false };
        after = last.id;
      }
      return { records, complete: false };
    } catch {
      return { records, complete: false };
    }
  }

  /** `refunds.list({ limit: 100 })`, auto-paginated, keeping refunds whose metadata.nt_run_id is the run's (constructor `runId`; without
   *  it, every refund that carries an nt_marker). Used by the invariant scan only. Throws ProviderReadError if a page cannot be read. */
  async *listOperations(scope: { account: string; since?: Date }): AsyncGenerator<ProviderObject> {
    const params: Stripe.RefundListParams = { limit: 100 };
    if (scope.since !== undefined) params.created = { gte: Math.floor(scope.since.getTime() / 1000) };
    try {
      for await (const r of this.#stripe.refunds.list(params, { timeout: this.#timeoutMs, maxNetworkRetries: 0 })) {
        const o = mapRefund(r);
        const mine = this.#runId !== undefined ? o.metadata["nt_run_id"] === this.#runId : o.metadata["nt_marker"] !== undefined;
        if (mine) yield o;
      }
    } catch (e) {
      throw new ProviderReadError(`listOperations: ${e instanceof Stripe.errors.StripeError ? `Stripe HTTP ${e.statusCode ?? "?"}` : "read failed"}`);
    }
  }
}
