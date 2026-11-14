// C1-UNIT-06: rebuild from the ledger files: same objects, same ids, same replay behaviour, same state hash.
// Held late commits and IN_PROGRESS key records are not persisted: a held request lost in a restart never commits.
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TestSim, frozen, ok, NO_RESPONSE_MS } from "./support.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nt-sim-restart-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("restart", () => {
  it("rebuilds accounts, objects, key records, clock offsets and the request log from the files", async () => {
    let sim = await TestSim.start(dir);
    const account = await sim.account({ retention_ms: 60_000, search_lag_ms: 777, max_in_flight_ms: 20_000 });
    await sim.faults(account, [
      { match: { payee_ref: "payee_P13" }, fault: "REJECT", code: "payee_closed", times: 1 },
      { match: { payee_ref: "payee_P11" }, fault: "LATE_COMMIT_ON_RELEASE", times: 1 },
    ]);

    const bodyA = frozen({ account, marker: "run1:RA", payee_ref: "payee_P02" });
    const a = ok(await sim.pay(bodyA, { idem: "run1:RA" })).json;
    const bodyR = frozen({ account, operation: "REFUND", marker: "run1:RR", payee_ref: "payee_P03", amount_minor: 41260 });
    const r = ok(await sim.pay(bodyR, { idem: "run1:RR" })).json;
    const bodyX = frozen({ account, marker: "run1:RX", payee_ref: "payee_P13" });
    const rejected = ok(await sim.pay(bodyX, { idem: "run1:RX" }));
    expect(rejected.status).toBe(400);
    const legacyBody = frozen({ account, rail: "legacy", marker: "run1:RL", payee_ref: "payee_P05" });
    const l1 = ok(await sim.pay(legacyBody)).json;
    // a held late commit and its IN_PROGRESS key: never persisted
    const heldBody = frozen({ account, marker: "run1:RH", payee_ref: "payee_P11" });
    expect("timeout" in (await sim.pay(heldBody, { idem: "run1:RH", timeoutMs: NO_RESPONSE_MS }))).toBe(true);
    ok(await sim.admin("POST", "/admin/clock/advance", { account, ms: 30_000 }));

    const hashBefore = ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json;
    const listBefore = ok(await sim.get(`/v1/payouts?account=${account}&limit=100`)).json.data;
    const logBefore = ok(await sim.admin("GET", `/admin/request-log?account=${account}`)).json.data;
    expect(hashBefore.objects).toBe(3);

    await sim.stop(false);
    sim = await TestSim.start(dir);

    // account configuration
    expect(ok(await sim.get(`/v1/accounts/${account}`)).json).toEqual({ account, retention_ms: 60_000, max_in_flight_ms: 20_000, search_lag_ms: 777 });
    // same objects, same ids, same state hash
    expect(ok(await sim.get(`/v1/payouts?account=${account}&limit=100`)).json.data).toEqual(listBefore);
    expect(ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json).toEqual(hashBefore);
    expect(ok(await sim.get(`/v1/payouts/${a.id}`)).json).toEqual(a);
    expect(ok(await sim.get(`/v1/payouts/${r.id}`)).json.kind).toBe("refund");
    // request log survived and its sequence continues
    const logAfter = ok(await sim.admin("GET", `/admin/request-log?account=${account}`)).json.data;
    expect(logAfter.slice(0, logBefore.length)).toEqual(logBefore);

    // same replay behaviour
    const replayA = ok(await sim.pay(bodyA, { idem: "run1:RA" }));
    expect(replayA.status).toBe(201);
    expect(replayA.headers.get("idempotent-replayed")).toBe("true");
    expect(replayA.json).toEqual(a);
    const replayX = ok(await sim.pay(bodyX, { idem: "run1:RX" }));
    expect(replayX.status).toBe(400);
    expect(replayX.headers.get("idempotent-replayed")).toBe("true");
    expect(ok(await sim.pay(frozen({ account, marker: "run1:RA", amount_minor: 5 }), { idem: "run1:RA" })).status).toBe(422);
    // the legacy object is still there and the legacy rail still ignores keys
    expect(ok(await sim.get(`/v1/payouts/${l1.id}`)).status).toBe(200);

    // the held late commit is gone: releasing commits nothing, and its key was never stored
    expect(ok(await sim.admin("POST", "/admin/faults/release", { account })).json.released).toEqual([]);
    const heldRetry = ok(await sim.pay(heldBody, { idem: "run1:RH" }));
    expect(heldRetry.status).toBe(201);
    expect(heldRetry.headers.get("idempotent-replayed")).toBe("false");

    // the virtual clock offset (30 s) was rebuilt: advancing another 30 s expires the 60 s retention of keys stored earlier
    const adv = ok(await sim.admin("POST", "/admin/clock/advance", { account, ms: 30_001 }));
    expect(adv.json.offset_ms).toBe(60_001);
    const expired = ok(await sim.pay(bodyA, { idem: "run1:RA" }));
    expect(expired.headers.get("idempotent-replayed")).toBe("false");
    expect(expired.json.id).not.toBe(a.id);

    // a new object after restart gets a fresh sequence number (no id collision)
    const ids = ok(await sim.get(`/v1/payouts?account=${account}&limit=100`)).json.data.map((o: any) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    await sim.stop(false);
  });

  it("ignores a partial last line left by a kill", async () => {
    let sim = await TestSim.start(dir);
    const account = await sim.account();
    const created = ok(await sim.pay(frozen({ account, marker: "run1:PL" }), { idem: "run1:PL" })).json;
    await sim.stop(false);
    fs.appendFileSync(path.join(dir, `${account}.ledger.jsonl`), '{"seq":99,"type":"payout_cre');
    sim = await TestSim.start(dir);
    const list = ok(await sim.get(`/v1/payouts?account=${account}`)).json.data;
    expect(list.map((o: any) => o.id)).toEqual([created.id]);
    await sim.stop(false);
  });
});
