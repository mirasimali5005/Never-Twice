// C1-UNIT-03: each fault, matching by payee_ref / marker / ordinal, times, outcome faults not consumed by a replay,
// release of a held commit, separate counters per account.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestSim, frozen, ok, NO_RESPONSE_MS } from "./support.ts";

let sim: TestSim;
beforeAll(async () => {
  sim = await TestSim.start();
});
afterAll(async () => {
  await sim.stop();
});

const objects = async (account: string) => ok(await sim.get(`/v1/payouts?account=${account}&limit=100`)).json.data as any[];
const silent = async (p: ReturnType<TestSim["pay"]>) => expect("timeout" in (await p)).toBe(true);

describe("transport and outcome faults", () => {
  it("DROP_RESPONSE_AFTER_APPLY: committed, no response; a same-key replay returns the stored object (replayed true)", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: { payee_ref: "payee_P02" }, fault: "DROP_RESPONSE_AFTER_APPLY", times: 1 }]);
    const body = frozen({ account, marker: "run1:A" });
    await silent(sim.pay(body, { idem: "run1:A", timeoutMs: NO_RESPONSE_MS }));
    const stored = await objects(account);
    expect(stored).toHaveLength(1); // committed and visible to the list at once
    const replay = ok(await sim.pay(body, { idem: "run1:A" }));
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json).toEqual(stored[0]);
    expect(await objects(account)).toHaveLength(1);
    const log = ok(await sim.admin("GET", `/admin/request-log?account=${account}`)).json.data.filter((e: any) => e.method === "POST");
    expect(log[0]).toMatchObject({ fault: "DROP_RESPONSE_AFTER_APPLY", outcome: "EXECUTED", status: null });
    expect(log[1]).toMatchObject({ fault: null, outcome: "REPLAYED", status: 201 });
  });

  it("SERVER_ERROR_AFTER_APPLY: 500, committed; replay returns 201 with the stored object and the replay header", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: { payee_ref: "payee_P02" }, fault: "SERVER_ERROR_AFTER_APPLY", times: 1 }]);
    const body = frozen({ account, marker: "run1:B" });
    const r = ok(await sim.pay(body, { idem: "run1:B" }));
    expect(r.status).toBe(500);
    expect(r.json.error.code).toBe("internal");
    expect(await objects(account)).toHaveLength(1);
    const replay = ok(await sim.pay(body, { idem: "run1:B" }));
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect((await objects(account))[0].id).toBe(replay.json.id);
  });

  it("DROP_REQUEST: nothing committed, no key stored, no response; the retry executes fresh (times: 1)", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: { payee_ref: "payee_P13" }, fault: "DROP_REQUEST", times: 1 }]);
    const body = frozen({ account, marker: "run1:C", payee_ref: "payee_P13" });
    await silent(sim.pay(body, { idem: "run1:C", timeoutMs: NO_RESPONSE_MS }));
    expect(await objects(account)).toHaveLength(0);
    const retry = ok(await sim.pay(body, { idem: "run1:C" }));
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("false");
    expect(await objects(account)).toHaveLength(1);
    const log = ok(await sim.admin("GET", `/admin/request-log?account=${account}`)).json.data.filter((e: any) => e.method === "POST");
    expect(log[0]).toMatchObject({ fault: "DROP_REQUEST", outcome: "DROPPED", status: null });
    expect(log[0].body_sha256).toBe(log[1].body_sha256);
  });

  it("LATE_COMMIT_ON_RELEASE: nothing committed until /admin/faults/release; then exactly one object", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: { payee_ref: "payee_P11" }, fault: "LATE_COMMIT_ON_RELEASE", times: 1 }]);
    const body = frozen({ account, rail: "legacy", marker: "run1:D", payee_ref: "payee_P11", amount_minor: 90000 });
    await silent(sim.pay(body, { timeoutMs: NO_RESPONSE_MS }));
    expect(await objects(account)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 150));
    expect(await objects(account)).toHaveLength(0); // still not committed
    // release of a non-matching payee leaves it held
    expect(ok(await sim.admin("POST", "/admin/faults/release", { account, payee_ref: "payee_other" })).json.released).toEqual([]);
    expect(await objects(account)).toHaveLength(0);
    const rel = ok(await sim.admin("POST", "/admin/faults/release", { account, payee_ref: "payee_P11" }));
    expect(rel.json.released).toHaveLength(1);
    expect(rel.json.released[0].marker).toBe("run1:D");
    const after = await objects(account);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(rel.json.released[0].id);
    // releasing again commits nothing more
    expect(ok(await sim.admin("POST", "/admin/faults/release", { account })).json.released).toEqual([]);
    expect(await objects(account)).toHaveLength(1);
  });

  it("legacy rail: blind retry plus release gives two objects (the control-arm double payment)", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: { payee_ref: "payee_P11" }, fault: "LATE_COMMIT_ON_RELEASE", times: 1 }]);
    const body = frozen({ account, rail: "legacy", marker: "run1:D2", payee_ref: "payee_P11" });
    await silent(sim.pay(body, { timeoutMs: NO_RESPONSE_MS }));
    expect(ok(await sim.pay(body)).status).toBe(201); // blind retry executes (times spent)
    ok(await sim.admin("POST", "/admin/faults/release", { account, marker: "run1:D2" }));
    expect(await objects(account)).toHaveLength(2);
  });

  it("LATE_COMMIT_AFTER_MS commits by itself after ms of real time", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: {}, fault: "LATE_COMMIT_AFTER_MS", ms: 400, times: 1 }]);
    await silent(sim.pay(frozen({ account, marker: "run1:E" }), { idem: "run1:E", timeoutMs: NO_RESPONSE_MS }));
    expect(await objects(account)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 450));
    expect(await objects(account)).toHaveLength(1);
    const replay = ok(await sim.pay(frozen({ account, marker: "run1:E" }), { idem: "run1:E" }));
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
  });

  it("REJECT(code): 400 with that code, no object; a different code is carried through", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: {}, fault: "REJECT", code: "payee_closed", times: 1 }]);
    const r = ok(await sim.pay(frozen({ account, marker: "run1:F" }), { idem: "run1:F" }));
    expect(r.status).toBe(400);
    expect(r.json.error).toEqual({ code: "payee_closed", message: "payee account closed" });
    expect(await objects(account)).toHaveLength(0);
    // next, different key: normal service
    expect(ok(await sim.pay(frozen({ account, marker: "run1:F2" }), { idem: "run1:F2" })).status).toBe(201);
  });

  it("IN_PROGRESS(2): 409 request_in_progress twice with nothing executed, then normal", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: { payee_ref: "payee_P02" }, fault: "IN_PROGRESS", n: 2, times: 1 }]);
    const body = frozen({ account, marker: "run1:G" });
    for (let i = 0; i < 2; i++) {
      const r = ok(await sim.pay(body, { idem: "run1:G" }));
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe("request_in_progress");
    }
    expect(await objects(account)).toHaveLength(0);
    expect(ok(await sim.pay(body, { idem: "run1:G" })).status).toBe(201);
  });

  it("HOLD_RESPONSE_MS: committed at once, answered after ms; a replay during the hold already sees the object", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: {}, fault: "HOLD_RESPONSE_MS", ms: 600, times: 1 }]);
    const t0 = Date.now();
    const slow = sim.pay(frozen({ account, marker: "run1:H" }), { idem: "run1:H" });
    await new Promise((r) => setTimeout(r, 150));
    expect(await objects(account)).toHaveLength(1); // already committed
    const r = ok(await slow);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    expect(r.status).toBe(201);
    // a client that gave up before ms gets a timeout, and the replay returns the object
    await sim.faults(account, [{ match: {}, fault: "HOLD_RESPONSE_MS", ms: 600, times: 1 }]);
    await silent(sim.pay(frozen({ account, marker: "run1:H2" }), { idem: "run1:H2", timeoutMs: NO_RESPONSE_MS }));
    const replay = ok(await sim.pay(frozen({ account, marker: "run1:H2" }), { idem: "run1:H2" }));
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
  });
});

describe("matching", () => {
  it("matches by payee_ref, marker and ordinal; ordinals count the account's payout requests including this one", async () => {
    const account = await sim.account();
    await sim.faults(account, [
      { match: { marker: "run1:M2" }, fault: "REJECT", code: "payee_closed", times: 1 },
      { match: { ordinal: 4 }, fault: "REJECT", code: "amount_invalid", times: 1 },
      { match: { payee_ref: "payee_X", ordinal: 5 }, fault: "REJECT", code: "no_match_expected", times: 1 },
    ]);
    const send = async (marker: string, payee = "payee_P02") => ok(await sim.pay(frozen({ account, marker, payee_ref: payee }), { idem: marker }));
    expect((await send("run1:M1")).status).toBe(201); // ordinal 1: no match
    expect((await send("run1:M2")).json.error.code).toBe("payee_closed"); // ordinal 2: marker match
    expect((await send("run1:M3")).status).toBe(201); // ordinal 3
    expect((await send("run1:M4")).json.error.code).toBe("amount_invalid"); // ordinal 4
    expect((await send("run1:M5", "payee_Y")).status).toBe(201); // ordinal 5 but payee differs
  });

  it("times counts matching requests; afterwards service is normal; fault order decides when two entries match", async () => {
    const account = await sim.account();
    await sim.faults(account, [
      { match: { payee_ref: "payee_P02" }, fault: "REJECT", code: "first", times: 2 },
      { match: { payee_ref: "payee_P02" }, fault: "REJECT", code: "second", times: 1 },
    ]);
    const send = async (marker: string) => ok(await sim.pay(frozen({ account, marker }), { idem: marker }));
    expect((await send("run1:T1")).json.error.code).toBe("first");
    expect((await send("run1:T2")).json.error.code).toBe("first");
    expect((await send("run1:T3")).json.error.code).toBe("second");
    expect((await send("run1:T4")).status).toBe(201);
  });

  it("outcome faults are not consumed by a replay; transport faults are", async () => {
    const account = await sim.account();
    const body = frozen({ account, marker: "run1:R" });
    ok(await sim.pay(body, { idem: "run1:R" })); // object exists, key stored
    await sim.faults(account, [
      { match: { payee_ref: "payee_P02" }, fault: "REJECT", code: "payee_closed", times: 1 },
      { match: { payee_ref: "payee_P02" }, fault: "SERVER_ERROR_AFTER_APPLY", times: 1 },
    ]);
    // the replay skips REJECT (outcome fault) and is hit by the transport fault behind it
    const r = ok(await sim.pay(body, { idem: "run1:R" }));
    expect(r.status).toBe(500);
    // REJECT is still unspent: the next fresh request on that payee gets it
    const fresh = ok(await sim.pay(frozen({ account, marker: "run1:R2" }), { idem: "run1:R2" }));
    expect(fresh.status).toBe(400);
    expect(fresh.json.error.code).toBe("payee_closed");
  });

  it("each account has its own counters (the same schedule installed on two accounts fires once on each)", async () => {
    const a1 = await sim.account();
    const a2 = await sim.account();
    const schedule = [{ match: { payee_ref: "payee_P13" }, fault: "DROP_REQUEST", times: 1 }];
    await sim.faults(a1, schedule);
    await sim.faults(a2, schedule);
    for (const account of [a1, a2]) {
      const body = frozen({ account, marker: `run1:${account}`, payee_ref: "payee_P13" });
      await silent(sim.pay(body, { idem: `run1:${account}`, timeoutMs: NO_RESPONSE_MS }));
      expect(ok(await sim.pay(body, { idem: `run1:${account}` })).status).toBe(201);
    }
    expect(await objects(a1)).toHaveLength(1);
    expect(await objects(a2)).toHaveLength(1);
  });

  it("POST /admin/faults replaces the schedule and rejects malformed entries", async () => {
    const account = await sim.account();
    expect(ok(await sim.admin("POST", "/admin/faults", { account, faults: [{ fault: "NOPE" }] })).status).toBe(400);
    expect(ok(await sim.admin("POST", "/admin/faults", { account, faults: [{ fault: "REJECT" }] })).status).toBe(400);
    expect(ok(await sim.admin("POST", "/admin/faults", { account, faults: [{ fault: "HOLD_RESPONSE_MS" }] })).status).toBe(400);
    expect(ok(await sim.admin("POST", "/admin/faults", { account, faults: [{ fault: "DROP_REQUEST", times: 0 }] })).status).toBe(400);
    const good = ok(await sim.admin("POST", "/admin/faults", { account, faults: [{ fault: "DROP_REQUEST", match: { payee_ref: "payee_Z" } }, { fault: "DROP_REQUEST", match: { payee_ref: "payee_Z" } }] }));
    expect(good.json).toEqual({ account, installed: 2 });
    expect(ok(await sim.admin("POST", "/admin/faults", { account, faults: [] })).json.installed).toBe(0);
    expect(ok(await sim.pay(frozen({ account, payee_ref: "payee_Z" }))).status).toBe(201); // schedule was replaced by []
  });
});
