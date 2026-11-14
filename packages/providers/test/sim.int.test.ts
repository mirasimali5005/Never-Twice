// Integration: the real SimPayoutProvider / SimKeylessProvider against the real provider simulator (started as a child process on
// an ephemeral port with test keys). Covers C2-INT-01, C2-INT-02 and the PAY-03/04/07/07b/08a/10/11/12/13 client halves.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCEPTED_STATUSES, hashFrozenRequest } from "@nt/contracts";
import type { FrozenRequest, ProviderObject } from "@nt/contracts";
import { FaultInjectingProvider, ProviderConfigError, SimKeylessProvider, SimPayoutProvider } from "../src/index.ts";
import { SIM_KEYS, SimProcess } from "./support/sim-process.ts";

let sim: SimProcess;
beforeAll(async () => {
  sim = await SimProcess.start();
}, 30_000);
afterAll(async () => {
  await sim.stop();
});

const SHORT = 400; // ms: a client timeout for requests the simulator is meant to leave unanswered

function req(account: string, o: { rail?: "instant" | "legacy"; payee?: string; n?: number; amount?: number; operation?: "PAYOUT" | "REFUND" } = {}): FrozenRequest {
  const rail = o.rail ?? "instant";
  const payee = o.payee ?? "payee_P02";
  const effect = `ZT4H9X.${payee.slice(6)}.NT101-20261110.APPR_DELAY${o.n === undefined ? "" : `.${o.n}`}`.replace(/[^A-Z0-9._-]/g, "X");
  return {
    provider: rail === "instant" ? "sim_payout" : "sim_keyless",
    operation: o.operation ?? "PAYOUT",
    account,
    rail,
    amount_minor: o.amount ?? 70000,
    currency: "CAD",
    payee_ref: payee,
    parent_ref: null,
    metadata: { nt_marker: `r7k2m9qa:${effect}`, nt_effect_key: effect, nt_run_id: "r7k2m9qa", nt_type: "APPR_DELAY" },
  };
}
const markerOf = (r: FrozenRequest) => r.metadata.nt_marker;

async function instant(account: string) {
  return SimPayoutProvider.create({ baseUrl: sim.baseUrl, account, writeKey: SIM_KEYS.write, readKey: SIM_KEYS.read });
}
async function legacy(account: string) {
  return SimKeylessProvider.create({ baseUrl: sim.baseUrl, account, writeKey: SIM_KEYS.write, readKey: SIM_KEYS.read });
}
const evidence = (p: SimPayoutProvider | SimKeylessProvider, account: string, payee: string) =>
  p.findOperationEvidence({ account, payeeRef: payee, parentRef: null, since: new Date(Date.now() - 3_600_000) });

describe("C2-INT-01 sim_payout (rail instant)", () => {
  it("reads capabilities at construction from GET /v1/accounts/:account", async () => {
    const a = await sim.account({ retention_ms: 4000, max_in_flight_ms: 2500, search_lag_ms: 1000 });
    const p = await instant(a);
    expect(p.capabilities).toEqual({ dedupesOnIdempotencyKey: true, keyRetentionMs: 4000, declaredMaxInFlightMs: 2500, stronglyConsistentList: true });
    const d = await legacy(await sim.account());
    expect(d.capabilities).toEqual({ dedupesOnIdempotencyKey: false, keyRetentionMs: null, declaredMaxInFlightMs: null, stronglyConsistentList: true });
  });

  it("an unknown account or a wrong key is a ProviderConfigError", async () => {
    await expect(instant("acct_does_not_exist")).rejects.toBeInstanceOf(ProviderConfigError);
    const a = await sim.account();
    await expect(SimPayoutProvider.create({ baseUrl: sim.baseUrl, account: a, writeKey: SIM_KEYS.write, readKey: "wrong" })).rejects.toBeInstanceOf(ProviderConfigError);
    const p = await SimPayoutProvider.create({ baseUrl: sim.baseUrl, account: a, writeKey: SIM_KEYS.read, readKey: SIM_KEYS.read });
    await expect(p.createPaymentOrRefund(req(a), { idempotencyKey: "k", timeoutMs: 2000 })).rejects.toBeInstanceOf(ProviderConfigError); // a read key never writes
  });

  it("accepted; the request body hash in the simulator's log equals hashFrozenRequest(req); the object matches", async () => {
    const a = await sim.account();
    const p = await instant(a);
    const r = req(a);
    const res = await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: 3000 });
    expect(res.kind).toBe("ACCEPTED");
    if (res.kind !== "ACCEPTED") return;
    expect(res.replayed).toBe(false);
    expect(res.object).toMatchObject({ kind: "payout", status: "paid", amount_minor: 70000, currency: "CAD", payee_ref: "payee_P02", parent_ref: null });
    expect(res.object.id.startsWith("po_")).toBe(true);
    expect(res.object.metadata.nt_marker).toBe(markerOf(r));
    expect(ACCEPTED_STATUSES.sim_payout.has(res.object.status)).toBe(true);
    const log = (await sim.requestLog(a)).filter((e) => e.method === "POST");
    expect(log).toHaveLength(1);
    expect(log[0]!.body_sha256).toBe(hashFrozenRequest(r));
    expect(log[0]!.idempotency_key).toBe(markerOf(r));
    expect(await p.getOperation(res.object.id)).toEqual(res.object);
    expect(await p.getOperation("po_0000000000000000")).toBeNull();
  });

  it("REFUND creates kind refund (rf_)", async () => {
    const a = await sim.account();
    const p = await instant(a);
    const r = req(a, { operation: "REFUND", payee: "payee_P03", amount: 41260 });
    const res = await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: 3000 });
    expect(res.kind === "ACCEPTED" && [res.object.kind, res.object.id.slice(0, 3), res.object.amount_minor]).toEqual(["refund", "rf_", 41260]);
  });

  it("same key and same bytes again: ACCEPTED, same id, replayed true; one object in the ledger", async () => {
    const a = await sim.account();
    const p = await instant(a);
    const r = req(a);
    const first = await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: 3000 });
    const again = await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: 3000 });
    expect(first.kind === "ACCEPTED" && again.kind === "ACCEPTED" && again.object.id === first.object.id && again.replayed && !first.replayed).toBe(true);
    expect((await evidence(p, a, "payee_P02")).records).toHaveLength(1);
    const posts = (await sim.requestLog(a)).filter((e) => e.method === "POST");
    expect(posts.map((e) => e.body_sha256)).toEqual([hashFrozenRequest(r), hashFrozenRequest(r)]);
  });

  it("same key, different bytes: CONTRADICTION KEY_REUSED_DIFFERENT_PARAMS; the ledger still holds one object of 70000 (PAY-08a)", async () => {
    const a = await sim.account();
    const p = await instant(a);
    const r = req(a);
    await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: 3000 });
    const res = await p.createPaymentOrRefund({ ...r, amount_minor: 100000 }, { idempotencyKey: markerOf(r), timeoutMs: 3000 });
    expect(res).toMatchObject({ kind: "CONTRADICTION", code: "KEY_REUSED_DIFFERENT_PARAMS" });
    const ev = await evidence(p, a, "payee_P02");
    expect(ev.records.map((o) => o.amount_minor)).toEqual([70000]);
  });

  it("DROP_RESPONSE_AFTER_APPLY: TIMEOUT now; evidence finds the object; a same-key re-send is ACCEPTED, replayed true, same object", async () => {
    const a = await sim.account();
    const p = await instant(a);
    await sim.faults(a, [{ match: { payee_ref: "payee_P02" }, fault: "DROP_RESPONSE_AFTER_APPLY", times: 1 }]);
    const r = req(a);
    const t0 = Date.now();
    const first = await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: SHORT });
    expect(first).toMatchObject({ kind: "INDETERMINATE", cause: "TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(3000);
    const ev = await evidence(p, a, "payee_P02");
    expect(ev.complete).toBe(true);
    expect(ev.records).toHaveLength(1);
    expect(ev.records[0]!.metadata.nt_marker).toBe(markerOf(r));
    const resend = await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: 3000 });
    expect(resend.kind === "ACCEPTED" && resend.replayed && resend.object.id === ev.records[0]!.id).toBe(true);
    expect((await evidence(p, a, "payee_P02")).records).toHaveLength(1);
  });

  it("DROP_REQUEST: TIMEOUT now; evidence is empty and complete (absence is not proof); a same-key re-send executes anew, replayed false", async () => {
    const a = await sim.account();
    const p = await instant(a);
    await sim.faults(a, [{ match: { payee_ref: "payee_P02" }, fault: "DROP_REQUEST", times: 1 }]);
    const r = req(a);
    expect(await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: SHORT })).toMatchObject({ kind: "INDETERMINATE", cause: "TIMEOUT" });
    expect(await evidence(p, a, "payee_P02")).toEqual({ records: [], complete: true });
    const resend = await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: 3000 });
    expect(resend).toMatchObject({ kind: "ACCEPTED", replayed: false });
    expect((await evidence(p, a, "payee_P02")).records).toHaveLength(1);
    const posts = (await sim.requestLog(a)).filter((e) => e.method === "POST");
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((e) => e.body_sha256)).size).toBe(1); // identical bytes both times
    expect(new Set(posts.map((e) => e.idempotency_key)).size).toBe(1); // same key both times
  });

  it("SERVER_ERROR_AFTER_APPLY: SERVER_ERROR now, replay returns the stored object (replayed true)", async () => {
    const a = await sim.account();
    const p = await instant(a);
    await sim.faults(a, [{ match: {}, fault: "SERVER_ERROR_AFTER_APPLY", times: 1 }]);
    const r = req(a);
    expect(await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: 3000 })).toMatchObject({ kind: "INDETERMINATE", cause: "SERVER_ERROR" });
    expect(await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: 3000 })).toMatchObject({ kind: "ACCEPTED", replayed: true });
  });

  it("IN_PROGRESS(2): two 409s map to IN_PROGRESS_CONFLICT, then ACCEPTED", async () => {
    const a = await sim.account();
    const p = await instant(a);
    await sim.faults(a, [{ match: {}, fault: "IN_PROGRESS", n: 1, times: 2 }]);
    const r = req(a);
    const o = { idempotencyKey: markerOf(r), timeoutMs: 3000 };
    expect(await p.createPaymentOrRefund(r, o)).toMatchObject({ kind: "INDETERMINATE", cause: "IN_PROGRESS_CONFLICT" });
    expect(await p.createPaymentOrRefund(r, o)).toMatchObject({ kind: "INDETERMINATE", cause: "IN_PROGRESS_CONFLICT" });
    expect(await p.createPaymentOrRefund(r, o)).toMatchObject({ kind: "ACCEPTED", replayed: false });
  });

  it("REJECT(payee_closed): REJECTED_DEFINITIVE; the replay is the same rejection with replayed true", async () => {
    const a = await sim.account();
    const p = await instant(a);
    await sim.faults(a, [{ match: {}, fault: "REJECT", code: "payee_closed", times: 1 }]);
    const r = req(a);
    const o = { idempotencyKey: markerOf(r), timeoutMs: 3000 };
    expect(await p.createPaymentOrRefund(r, o)).toMatchObject({ kind: "REJECTED_DEFINITIVE", code: "payee_closed", replayed: false });
    expect(await p.createPaymentOrRefund(r, o)).toMatchObject({ kind: "REJECTED_DEFINITIVE", code: "payee_closed", replayed: true });
    expect((await evidence(p, a, "payee_P02")).records).toHaveLength(0);
  });

  it("LATE_COMMIT_ON_RELEASE: TIMEOUT, then 409 IN_PROGRESS_CONFLICT, then replayed after release", async () => {
    const a = await sim.account();
    const p = await instant(a);
    await sim.faults(a, [{ match: { payee_ref: "payee_P02" }, fault: "LATE_COMMIT_ON_RELEASE", times: 1 }]);
    const r = req(a);
    const o = { idempotencyKey: markerOf(r), timeoutMs: SHORT };
    expect(await p.createPaymentOrRefund(r, o)).toMatchObject({ kind: "INDETERMINATE", cause: "TIMEOUT" });
    expect(await p.createPaymentOrRefund(r, o)).toMatchObject({ kind: "INDETERMINATE", cause: "IN_PROGRESS_CONFLICT" });
    expect(await evidence(p, a, "payee_P02")).toEqual({ records: [], complete: true });
    await sim.release(a, { payee_ref: "payee_P02" });
    expect((await evidence(p, a, "payee_P02")).records).toHaveLength(1);
    expect(await p.createPaymentOrRefund(r, { ...o, timeoutMs: 3000 })).toMatchObject({ kind: "ACCEPTED", replayed: true });
  });

  it("a simulator that is down: INDETERMINATE CONNECTION", async () => {
    const dead = await SimProcess.start();
    const a = await dead.account();
    const p = await SimPayoutProvider.create({ baseUrl: dead.baseUrl, account: a, writeKey: SIM_KEYS.write, readKey: SIM_KEYS.read });
    await dead.stop();
    const r = req(a);
    expect(await p.createPaymentOrRefund(r, { idempotencyKey: markerOf(r), timeoutMs: 2000 })).toMatchObject({ kind: "INDETERMINATE", cause: "CONNECTION" });
    expect(await p.findOperationEvidence({ account: a, payeeRef: "payee_P02", parentRef: null, since: new Date(0) })).toEqual({ records: [], complete: false });
  }, 40_000);
});

describe("C2-INT-02 sim_keyless (rail legacy)", () => {
  it("never sends Idempotency-Key; a second request creates a second payout (double payment); the response has no replay header", async () => {
    const a = await sim.account();
    const k = await legacy(a);
    const r = req(a, { rail: "legacy", payee: "payee_P11", amount: 90000 });
    const one = await k.createPaymentOrRefund(r, { idempotencyKey: null, timeoutMs: 3000 });
    const two = await k.createPaymentOrRefund(r, { idempotencyKey: null, timeoutMs: 3000 });
    expect(one).toMatchObject({ kind: "ACCEPTED", replayed: false });
    expect(two).toMatchObject({ kind: "ACCEPTED", replayed: false });
    expect(one.kind === "ACCEPTED" && two.kind === "ACCEPTED" && one.object.id !== two.object.id).toBe(true);
    const ev = await evidence(k, a, "payee_P11");
    expect(ev.records).toHaveLength(2); // the double payment is visible, and the matcher would call it MULTIPLE_OBJECTS
    expect(ev.records.every((o) => o.metadata.nt_marker === markerOf(r))).toBe(true);
    const posts = (await sim.requestLog(a)).filter((e) => e.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts.every((e) => e.idempotency_key === null)).toBe(true);
    expect(posts.every((e) => e.body_sha256 === hashFrozenRequest(r))).toBe(true);
  });

  it("the simulator ignores a key even when one is forced onto the wire (PAY-13), which is why the client throws instead of sending", async () => {
    const a = await sim.account();
    const k = await legacy(a);
    await expect(k.createPaymentOrRefund(req(a, { rail: "legacy" }), { idempotencyKey: "r7k2m9qa:X", timeoutMs: 1000 })).rejects.toBeInstanceOf(ProviderConfigError);
    expect((await sim.requestLog(a)).filter((e) => e.method === "POST")).toHaveLength(0);
  });

  it("LATE_COMMIT_ON_RELEASE on legacy: TIMEOUT, no object, no 409; blind retry + release gives two objects", async () => {
    const a = await sim.account();
    const k = await legacy(a);
    await sim.faults(a, [{ match: { payee_ref: "payee_P11" }, fault: "LATE_COMMIT_ON_RELEASE", times: 1 }]);
    const r = req(a, { rail: "legacy", payee: "payee_P11", amount: 90000 });
    const o = { idempotencyKey: null, timeoutMs: SHORT };
    expect(await k.createPaymentOrRefund(r, o)).toMatchObject({ kind: "INDETERMINATE", cause: "TIMEOUT" });
    expect(await evidence(k, a, "payee_P11")).toEqual({ records: [], complete: true });
    expect(await k.createPaymentOrRefund(r, { ...o, timeoutMs: 3000 })).toMatchObject({ kind: "ACCEPTED" });
    await sim.release(a, { payee_ref: "payee_P11" });
    expect((await evidence(k, a, "payee_P11")).records).toHaveLength(2);
  });
});

describe("list completeness", () => {
  it("findOperationEvidence reads every page (250 objects for the payee among decoys); listOperations yields all of the account", async () => {
    const a = await sim.account();
    const k = await legacy(a);
    const mine = 250;
    const decoys = 40;
    for (let i = 0; i < mine; i++) {
      const res = await k.createPaymentOrRefund(req(a, { rail: "legacy", payee: "payee_LIST", n: i }), { idempotencyKey: null, timeoutMs: 5000 });
      expect(res.kind).toBe("ACCEPTED");
    }
    for (let i = 0; i < decoys; i++) {
      await k.createPaymentOrRefund(req(a, { rail: "legacy", payee: "payee_DECOY", n: 1000 + i }), { idempotencyKey: null, timeoutMs: 5000 });
    }
    const ev = await evidence(k, a, "payee_LIST");
    expect(ev.complete).toBe(true);
    expect(ev.records).toHaveLength(mine);
    expect(new Set(ev.records.map((o) => o.id)).size).toBe(mine);
    expect(ev.records.every((o) => o.payee_ref === "payee_LIST")).toBe(true);
    const lists = (await sim.requestLog(a)).filter((e) => e.method === "GET" && e.path.startsWith("/v1/payouts?") && e.path.includes("payee_ref=payee_LIST"));
    expect(lists).toHaveLength(3); // 100 + 100 + 50
    const all: ProviderObject[] = [];
    for await (const o of k.listOperations({ account: a })) all.push(o);
    expect(all).toHaveLength(mine + decoys);
    const future = new Date(Date.now() + 60_000);
    const none: ProviderObject[] = [];
    for await (const o of k.listOperations({ account: a, since: future })) none.push(o);
    expect(none).toHaveLength(0);
    expect(await k.findOperationEvidence({ account: a, payeeRef: "payee_LIST", parentRef: null, since: future })).toEqual({ records: [], complete: true });
  }, 60_000);
});

describe("FaultInjectingProvider over the real simulator", () => {
  it("DISCARD_RESPONSE_AFTER_APPLY: the payout exists at the simulator although the caller saw TIMEOUT; the same-key re-send replays it", async () => {
    const a = await sim.account();
    const inner = await instant(a);
    const p = new FaultInjectingProvider(inner, [{ match: {}, fault: "DISCARD_RESPONSE_AFTER_APPLY", times: 1 }]);
    const r = req(a);
    const o = { idempotencyKey: markerOf(r), timeoutMs: 3000 };
    expect(await p.createPaymentOrRefund(r, o)).toMatchObject({ kind: "INDETERMINATE", cause: "TIMEOUT" });
    expect((await p.findOperationEvidence({ account: a, payeeRef: "payee_P02", parentRef: null, since: new Date(Date.now() - 60_000) })).records).toHaveLength(1);
    expect(await p.createPaymentOrRefund(r, o)).toMatchObject({ kind: "ACCEPTED", replayed: true });
  });
});
