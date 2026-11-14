// C2-UNIT-02: both client faults, pass-through of reads, `times`, marker and ordinal matching.
import { describe, expect, it } from "vitest";
import type { DispatchResult, FrozenRequest, PaymentProvider, ProviderObject } from "@nt/contracts";
import { FaultInjectingProvider } from "../src/index.ts";
import { frozenReq, providerObject } from "./support/stub-http.ts";

class Recording implements PaymentProvider {
  readonly id = "sim_payout" as const;
  readonly capabilities = { dedupesOnIdempotencyKey: true, keyRetentionMs: 1000, declaredMaxInFlightMs: null, stronglyConsistentList: true };
  creates: FrozenRequest[] = [];
  reads: string[] = [];
  async createPaymentOrRefund(req: FrozenRequest): Promise<DispatchResult> {
    this.creates.push(req);
    return { kind: "ACCEPTED", object: providerObject({ marker: req.metadata.nt_marker }), replayed: false };
  }
  async getOperation(id: string): Promise<ProviderObject | null> {
    this.reads.push(`get:${id}`);
    return providerObject({ id });
  }
  async findOperationEvidence(): Promise<{ records: ProviderObject[]; complete: boolean }> {
    this.reads.push("find");
    return { records: [providerObject()], complete: true };
  }
  async *listOperations(): AsyncGenerator<ProviderObject> {
    this.reads.push("list");
    yield providerObject();
  }
}

const opts = { idempotencyKey: "k", timeoutMs: 1000 };
const M1 = "r7k2m9qa:A.P01.F-20261110.APPR_DELAY";
const M2 = "r7k2m9qa:A.P02.F-20261110.APPR_DELAY";

describe("FaultInjectingProvider", () => {
  it("DISCARD_RESPONSE_AFTER_APPLY calls the inner provider, then answers INDETERMINATE TIMEOUT; times: 1 then pass-through", async () => {
    const inner = new Recording();
    const p = new FaultInjectingProvider(inner, [{ match: {}, fault: "DISCARD_RESPONSE_AFTER_APPLY", times: 1 }]);
    const r1 = await p.createPaymentOrRefund(frozenReq(), opts);
    expect(r1).toMatchObject({ kind: "INDETERMINATE", cause: "TIMEOUT" });
    expect(inner.creates).toHaveLength(1);
    const r2 = await p.createPaymentOrRefund(frozenReq(), opts);
    expect(r2.kind).toBe("ACCEPTED");
    expect(inner.creates).toHaveLength(2);
  });

  it("DISCARD_RESPONSE_AFTER_APPLY discards whatever the inner answered, including a rejection", async () => {
    const inner = new Recording();
    inner.createPaymentOrRefund = async () => ({ kind: "REJECTED_DEFINITIVE", code: "payee_closed", message: "m", replayed: false });
    const p = new FaultInjectingProvider(inner, [{ match: {}, fault: "DISCARD_RESPONSE_AFTER_APPLY", times: 1 }]);
    expect(await p.createPaymentOrRefund(frozenReq(), opts)).toMatchObject({ kind: "INDETERMINATE", cause: "TIMEOUT" });
  });

  it("FAIL_BEFORE_SEND does not call the inner provider and answers INDETERMINATE CONNECTION", async () => {
    const inner = new Recording();
    const p = new FaultInjectingProvider(inner, [{ match: {}, fault: "FAIL_BEFORE_SEND", times: 2 }]);
    expect(await p.createPaymentOrRefund(frozenReq(), opts)).toMatchObject({ kind: "INDETERMINATE", cause: "CONNECTION" });
    expect(await p.createPaymentOrRefund(frozenReq(), opts)).toMatchObject({ kind: "INDETERMINATE", cause: "CONNECTION" });
    expect(inner.creates).toHaveLength(0);
    expect((await p.createPaymentOrRefund(frozenReq(), opts)).kind).toBe("ACCEPTED");
    expect(inner.creates).toHaveLength(1);
    expect(p.remaining).toEqual([0]);
  });

  it("match.marker applies the fault only to that marker and is not consumed by others", async () => {
    const inner = new Recording();
    const p = new FaultInjectingProvider(inner, [{ match: { marker: M2 }, fault: "FAIL_BEFORE_SEND", times: 1 }]);
    expect((await p.createPaymentOrRefund(frozenReq({ marker: M1 }), opts)).kind).toBe("ACCEPTED");
    expect(p.remaining).toEqual([1]);
    expect((await p.createPaymentOrRefund(frozenReq({ marker: M2 }), opts)).kind).toBe("INDETERMINATE");
    expect((await p.createPaymentOrRefund(frozenReq({ marker: M2 }), opts)).kind).toBe("ACCEPTED");
  });

  it("match.ordinal counts this wrapper's create calls (1-based, faulted or not)", async () => {
    const inner = new Recording();
    const p = new FaultInjectingProvider(inner, [{ match: { ordinal: 2 }, fault: "DISCARD_RESPONSE_AFTER_APPLY", times: 1 }]);
    expect((await p.createPaymentOrRefund(frozenReq(), opts)).kind).toBe("ACCEPTED");
    expect((await p.createPaymentOrRefund(frozenReq(), opts)).kind).toBe("INDETERMINATE");
    expect((await p.createPaymentOrRefund(frozenReq(), opts)).kind).toBe("ACCEPTED");
  });

  it("entries are tried in order; the first with times left and a matching request applies", async () => {
    const inner = new Recording();
    const p = new FaultInjectingProvider(inner, [
      { match: { marker: M1 }, fault: "FAIL_BEFORE_SEND", times: 1 },
      { match: {}, fault: "DISCARD_RESPONSE_AFTER_APPLY", times: 1 },
    ]);
    expect(await p.createPaymentOrRefund(frozenReq({ marker: M1 }), opts)).toMatchObject({ cause: "CONNECTION" });
    expect(await p.createPaymentOrRefund(frozenReq({ marker: M1 }), opts)).toMatchObject({ cause: "TIMEOUT" });
    expect((await p.createPaymentOrRefund(frozenReq({ marker: M1 }), opts)).kind).toBe("ACCEPTED");
  });

  it("id, capabilities and the three read methods pass through untouched and are never faulted", async () => {
    const inner = new Recording();
    const p = new FaultInjectingProvider(inner, [{ match: {}, fault: "FAIL_BEFORE_SEND", times: 5 }]);
    expect(p.id).toBe("sim_payout");
    expect(p.capabilities).toBe(inner.capabilities);
    expect(await p.getOperation("po_1")).toEqual(providerObject({ id: "po_1" }));
    expect((await p.findOperationEvidence({ account: "a", payeeRef: "x", parentRef: null, since: new Date(0) })).complete).toBe(true);
    const seen: string[] = [];
    for await (const o of p.listOperations({ account: "a" })) seen.push(o.id);
    expect(seen).toEqual([providerObject().id]);
    expect(inner.reads).toEqual(["get:po_1", "find", "list"]);
    expect(p.remaining).toEqual([5]);
  });

  it("rejects an entry whose times is not a positive integer", () => {
    expect(() => new FaultInjectingProvider(new Recording(), [{ match: {}, fault: "FAIL_BEFORE_SEND", times: 0 }])).toThrow(RangeError);
  });
});
