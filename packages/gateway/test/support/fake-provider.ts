// A scriptable PaymentProvider for B3 tests. Each createPaymentOrRefund call takes the next scripted step: a DispatchResult,
// "ACCEPT" (an object matching the request, recorded in the ledger), a function of the request, or "THROW". Calls are recorded
// with the exact request and key; an optional onCall hook runs during the call (e.g. to read the intent) and an optional delay
// holds the response (zombie tests).
import type { DispatchResult, FrozenRequest, PaymentProvider, ProviderCapabilities, ProviderId, ProviderObject } from "@nt/contracts";

export type Step = DispatchResult | "ACCEPT" | "THROW" | ((req: FrozenRequest) => DispatchResult);

export type FakeProvider = PaymentProvider & {
  calls: { req: FrozenRequest; idempotencyKey: string | null; timeoutMs: number }[];
  ledger: ProviderObject[];
  script: Step[];
  delayMs: number;
  onCall?: (req: FrozenRequest) => Promise<void>;
};

let seq = 0;
export function objectFor(req: FrozenRequest, o: Partial<ProviderObject> = {}): ProviderObject {
  return {
    id: `po_fake_${++seq}`,
    kind: req.operation === "REFUND" ? "refund" : "payout",
    status: req.provider === "stripe_refund" ? "succeeded" : "paid",
    amount_minor: req.amount_minor,
    currency: req.currency,
    payee_ref: req.payee_ref,
    parent_ref: req.parent_ref,
    metadata: { ...req.metadata },
    created_at: new Date().toISOString(),
    ...o,
  };
}

export function fakeProvider(id: ProviderId, caps: Partial<ProviderCapabilities> = {}, script: Step[] = []): FakeProvider {
  const dedupes = caps.dedupesOnIdempotencyKey ?? id !== "sim_keyless";
  const byKey = new Map<string, ProviderObject>();
  const p: FakeProvider = {
    id,
    capabilities: {
      dedupesOnIdempotencyKey: dedupes,
      keyRetentionMs: caps.keyRetentionMs !== undefined ? caps.keyRetentionMs : dedupes ? 86_400_000 : null,
      declaredMaxInFlightMs: caps.declaredMaxInFlightMs ?? null,
      stronglyConsistentList: caps.stronglyConsistentList ?? true,
    },
    calls: [],
    ledger: [],
    script,
    delayMs: 0,
    async createPaymentOrRefund(req, opts) {
      p.calls.push({ req: structuredClone(req), idempotencyKey: opts.idempotencyKey, timeoutMs: opts.timeoutMs });
      if (p.onCall) await p.onCall(req);
      if (p.delayMs > 0) await new Promise((r) => setTimeout(r, p.delayMs));
      const step = p.script.shift() ?? "ACCEPT";
      if (step === "THROW") throw new Error("fake provider: configuration error after the mark");
      if (typeof step === "function") return step(req);
      if (step !== "ACCEPT") return step;
      const prior = opts.idempotencyKey ? byKey.get(opts.idempotencyKey) : undefined;
      if (prior) return { kind: "ACCEPTED", object: prior, replayed: true };
      const obj = objectFor(req);
      p.ledger.push(obj);
      if (opts.idempotencyKey) byKey.set(opts.idempotencyKey, obj);
      return { kind: "ACCEPTED", object: obj, replayed: false };
    },
    async getOperation(oid) {
      return p.ledger.find((o) => o.id === oid) ?? null;
    },
    async findOperationEvidence(q) {
      return { records: p.ledger.filter((o) => o.payee_ref === q.payeeRef), complete: true };
    },
    async *listOperations() {
      for (const o of p.ledger) yield o;
    },
  };
  return p;
}
