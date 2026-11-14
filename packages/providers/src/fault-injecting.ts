// FaultInjectingProvider: a client-side wrapper that injects faults into createPaymentOrRefund (task C2; AGENT_TASKS C2).
// It exists for Stripe, where faults cannot be scheduled on the server (HANDOVER §12.3). Read methods pass through untouched.
//   DISCARD_RESPONSE_AFTER_APPLY: call the inner provider (the effect happens), then return INDETERMINATE TIMEOUT whatever it answered.
//   FAIL_BEFORE_SEND:             do not call the inner provider; return INDETERMINATE CONNECTION.
// Matching mirrors the simulator's: the first entry with `times` left whose every present match field equals the call applies.
//   marker  = req.metadata.nt_marker
//   ordinal = this wrapper's count of createPaymentOrRefund calls, including this one (1-based)
import type { DispatchResult, FrozenRequest, PaymentProvider, ProviderObject } from "@nt/contracts";

export type ClientFaultName = "DISCARD_RESPONSE_AFTER_APPLY" | "FAIL_BEFORE_SEND";
export type ClientFault = { match: { marker?: string; ordinal?: number }; fault: ClientFaultName; times: number };

export class FaultInjectingProvider implements PaymentProvider {
  readonly #inner: PaymentProvider;
  readonly #faults: Array<ClientFault & { remaining: number }>;
  #ordinal = 0;

  constructor(inner: PaymentProvider, faults: ClientFault[]) {
    this.#inner = inner;
    this.#faults = faults.map((f) => {
      if (!Number.isSafeInteger(f.times) || f.times < 1) throw new RangeError("ClientFault.times must be an integer >= 1");
      return { match: { ...f.match }, fault: f.fault, times: f.times, remaining: f.times };
    });
  }

  get id(): PaymentProvider["id"] {
    return this.#inner.id;
  }
  get capabilities(): PaymentProvider["capabilities"] {
    return this.#inner.capabilities;
  }

  /** Faults still to be applied, per entry (for tests and the demo's status line). */
  get remaining(): number[] {
    return this.#faults.map((f) => f.remaining);
  }

  async createPaymentOrRefund(req: FrozenRequest, opts: { idempotencyKey: string | null; timeoutMs: number }): Promise<DispatchResult> {
    this.#ordinal += 1;
    const ordinal = this.#ordinal;
    const marker = req.metadata.nt_marker;
    const hit = this.#faults.find(
      (f) =>
        f.remaining > 0 &&
        (f.match.marker === undefined || f.match.marker === marker) &&
        (f.match.ordinal === undefined || f.match.ordinal === ordinal),
    );
    if (!hit) return this.#inner.createPaymentOrRefund(req, opts);
    hit.remaining -= 1;
    if (hit.fault === "FAIL_BEFORE_SEND") {
      return { kind: "INDETERMINATE", cause: "CONNECTION", detail: "fault injected: FAIL_BEFORE_SEND (nothing was sent)" };
    }
    const inner = await this.#inner.createPaymentOrRefund(req, opts);
    return {
      kind: "INDETERMINATE",
      cause: "TIMEOUT",
      detail: `fault injected: DISCARD_RESPONSE_AFTER_APPLY (the inner provider answered ${inner.kind}; the response was discarded)`,
    };
  }

  getOperation(providerObjectId: string): Promise<ProviderObject | null> {
    return this.#inner.getOperation(providerObjectId);
  }
  findOperationEvidence(q: Parameters<PaymentProvider["findOperationEvidence"]>[0]): ReturnType<PaymentProvider["findOperationEvidence"]> {
    return this.#inner.findOperationEvidence(q);
  }
  listOperations(scope: { account: string; since?: Date }): AsyncIterable<ProviderObject> {
    return this.#inner.listOperations(scope);
  }
}
