// PAY-07b: the simulator contract of HANDOVER 12.2 in one place.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEYS, TestSim, frozen, ok, NO_RESPONSE_MS } from "./support.ts";

let sim: TestSim;
let account: string;
beforeAll(async () => {
  sim = await TestSim.start();
  account = await sim.account({ retention_ms: 4000 });
});
afterAll(async () => {
  await sim.stop();
});

describe("PAY-07b simulator contract", () => {
  it("/healthz without auth", async () => {
    const r = ok(await sim.call("GET", "/healthz", { key: null }));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, simulator: true });
    expect(r.headers.get("x-simulator")).toBe("never-twice-provider-sim");
  });

  it("accounts with each key; read keys refused on POST; write key refused on /admin/*", async () => {
    for (const k of [KEYS.write, KEYS.read, KEYS.evalRead]) {
      expect(ok(await sim.get(`/v1/accounts/${account}`, k)).json).toEqual({ account, retention_ms: 4000, max_in_flight_ms: null, search_lag_ms: 5000 });
    }
    for (const k of [KEYS.read, KEYS.evalRead]) expect(ok(await sim.pay(frozen({ account }), { key: k })).status).toBe(401);
    expect(ok(await sim.call("POST", "/admin/clock/advance", { key: KEYS.write, body: { account, ms: 1 } })).status).toBe(401);
    expect(ok(await sim.call("GET", `/admin/request-log?account=${account}`, { key: KEYS.read })).status).toBe(401);
  });

  it("REFUND creates kind refund (rf_), PAYOUT creates po_", async () => {
    const p = ok(await sim.pay(frozen({ account, operation: "PAYOUT", marker: "run1:C1" }), { idem: "run1:C1" }));
    const r = ok(await sim.pay(frozen({ account, operation: "REFUND", marker: "run1:C2" }), { idem: "run1:C2" }));
    expect([p.json.kind, p.json.id.slice(0, 3)]).toEqual(["payout", "po_"]);
    expect([r.json.kind, r.json.id.slice(0, 3)]).toEqual(["refund", "rf_"]);
  });

  it("replay after an applied-then-lost response (DROP_RESPONSE_AFTER_APPLY and SERVER_ERROR_AFTER_APPLY) returns 201 with the stored object", async () => {
    await sim.faults(account, [
      { match: { payee_ref: "payee_A" }, fault: "DROP_RESPONSE_AFTER_APPLY", times: 1 },
      { match: { payee_ref: "payee_B" }, fault: "SERVER_ERROR_AFTER_APPLY", times: 1 },
    ]);
    const a = frozen({ account, payee_ref: "payee_A", marker: "run1:CA" });
    expect("timeout" in (await sim.pay(a, { idem: "run1:CA", timeoutMs: NO_RESPONSE_MS }))).toBe(true);
    const ra = ok(await sim.pay(a, { idem: "run1:CA" }));
    expect([ra.status, ra.headers.get("idempotent-replayed")]).toEqual([201, "true"]);
    const b = frozen({ account, payee_ref: "payee_B", marker: "run1:CB" });
    expect(ok(await sim.pay(b, { idem: "run1:CB" })).status).toBe(500);
    const rb = ok(await sim.pay(b, { idem: "run1:CB" }));
    expect([rb.status, rb.headers.get("idempotent-replayed")]).toEqual([201, "true"]);
    const pa = ok(await sim.get(`/v1/payouts?account=${account}&payee_ref=payee_A`)).json.data;
    const pb = ok(await sim.get(`/v1/payouts?account=${account}&payee_ref=payee_B`)).json.data;
    expect([pa.length, pb.length]).toEqual([1, 1]);
    expect(pa[0].id).toBe(ra.json.id);
    expect(pb[0].id).toBe(rb.json.id);
  });

  it("after DROP_REQUEST the replay executes anew (nothing was stored)", async () => {
    await sim.faults(account, [{ match: { payee_ref: "payee_D" }, fault: "DROP_REQUEST", times: 1 }]);
    const d = frozen({ account, payee_ref: "payee_D", marker: "run1:CD" });
    expect("timeout" in (await sim.pay(d, { idem: "run1:CD", timeoutMs: NO_RESPONSE_MS }))).toBe(true);
    const r = ok(await sim.pay(d, { idem: "run1:CD" }));
    expect([r.status, r.headers.get("idempotent-replayed")]).toEqual([201, "false"]);
    expect(ok(await sim.get(`/v1/payouts?account=${account}&payee_ref=payee_D`)).json.data).toHaveLength(1);
  });

  it("a fault with times: 2 affects exactly two matching requests, then normal service", async () => {
    await sim.faults(account, [{ match: { payee_ref: "payee_E" }, fault: "DROP_REQUEST", times: 2 }]);
    const e = (n: number) => frozen({ account, payee_ref: "payee_E", marker: `run1:CE${n}` });
    expect("timeout" in (await sim.pay(e(1), { idem: "run1:CE1", timeoutMs: NO_RESPONSE_MS }))).toBe(true);
    expect("timeout" in (await sim.pay(e(2), { idem: "run1:CE2", timeoutMs: NO_RESPONSE_MS }))).toBe(true);
    expect(ok(await sim.pay(e(3), { idem: "run1:CE3" })).status).toBe(201);
    expect(ok(await sim.pay(e(4), { idem: "run1:CE4" })).status).toBe(201);
    expect(ok(await sim.get(`/v1/payouts?account=${account}&payee_ref=payee_E`)).json.data).toHaveLength(2);
  });

  it("a key is forgotten after retention_ms (4000) on the account's clock", async () => {
    const acct = await sim.account({ retention_ms: 4000 });
    const body = frozen({ account: acct, marker: "run1:CK" });
    const first = ok(await sim.pay(body, { idem: "run1:CK" }));
    ok(await sim.admin("POST", "/admin/clock/advance", { account: acct, ms: 4001 }));
    const second = ok(await sim.pay(body, { idem: "run1:CK" }));
    expect(second.json.id).not.toBe(first.json.id);
  });
});
