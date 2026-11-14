// C1-UNIT-02: the five key cases, stored rejection (K5), legacy rail ignores the key, expiry on the virtual clock.
// Covers PAY-07, PAY-08a, PAY-09a, PAY-13.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { TestSim, frozen, ok, NO_RESPONSE_MS } from "./support.ts";

let sim: TestSim;
beforeAll(async () => {
  sim = await TestSim.start();
});
afterAll(async () => {
  await sim.stop();
});

const listAll = async (account: string) => ok(await sim.get(`/v1/payouts?account=${account}&limit=100`)).json.data;

describe("idempotency on rail instant", () => {
  it("PAY-07: same key and body replays the stored object with Idempotent-Replayed: true; one object; two log entries, one hash", async () => {
    const account = await sim.account();
    const body = frozen({ account, marker: "run1:K13", payee_ref: "payee_P13" });
    const first = ok(await sim.pay(body, { idem: "run1:K13" }));
    const second = ok(await sim.pay(body, { idem: "run1:K13" }));
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBe("false");
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.json).toEqual(first.json);
    expect(await listAll(account)).toHaveLength(1);

    const log = ok(await sim.admin("GET", `/admin/request-log?account=${account}`)).json.data.filter((e: any) => e.method === "POST");
    expect(log).toHaveLength(2);
    const sha = createHash("sha256").update(body).digest("hex");
    expect(log.map((e: any) => e.body_sha256)).toEqual([sha, sha]);
    expect(log.map((e: any) => e.outcome)).toEqual(["EXECUTED", "REPLAYED"]);
  });

  it("K5: a stored definitive rejection is replayed as the same 400 with Idempotent-Replayed: true; no object ever exists", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: { payee_ref: "payee_P13" }, fault: "REJECT", code: "payee_closed", times: 1 }]);
    const body = frozen({ account, marker: "run1:K5", payee_ref: "payee_P13" });
    const first = ok(await sim.pay(body, { idem: "run1:K5" }));
    expect(first.status).toBe(400);
    expect(first.json.error.code).toBe("payee_closed");
    expect(first.headers.get("idempotent-replayed")).toBe("false");
    // the fault is spent, but the key keeps the rejection: the replay is the same 400, not a fresh execution
    const replay = ok(await sim.pay(body, { idem: "run1:K5" }));
    expect(replay.status).toBe(400);
    expect(replay.json).toEqual(first.json);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await listAll(account)).toHaveLength(0);
  });

  it("PAY-08a: the same key with a different body is 422 idempotency_key_reuse and nothing executes", async () => {
    const account = await sim.account();
    const body = frozen({ account, marker: "run1:K13b" });
    const first = ok(await sim.pay(body, { idem: "run1:K13b" }));
    const changed = frozen({ account, marker: "run1:K13b", amount_minor: 100000 });
    const r = ok(await sim.pay(changed, { idem: "run1:K13b" }));
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("idempotency_key_reuse");
    const data = await listAll(account);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(first.json.id);
    expect(data[0].amount_minor).toBe(70000);
    // and a 422 is also what a stored rejection gives for a changed body
  });

  it("a request on instant with no key executes without deduplication", async () => {
    const account = await sim.account();
    const body = frozen({ account });
    ok(await sim.pay(body));
    ok(await sim.pay(body));
    expect(await listAll(account)).toHaveLength(2);
  });

  it("409 request_in_progress while the same key is held by a late commit; replay returns the committed object after release (replayed true)", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: { payee_ref: "payee_P11" }, fault: "LATE_COMMIT_ON_RELEASE", times: 1 }]);
    const body = frozen({ account, marker: "run1:K11", payee_ref: "payee_P11" });
    expect("timeout" in (await sim.pay(body, { idem: "run1:K11", timeoutMs: NO_RESPONSE_MS }))).toBe(true);
    const conflict = ok(await sim.pay(body, { idem: "run1:K11" }));
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("request_in_progress");
    expect(await listAll(account)).toHaveLength(0);
    const rel = ok(await sim.admin("POST", "/admin/faults/release", { account, payee_ref: "payee_P11" }));
    expect(rel.json.released).toHaveLength(1);
    const replay = ok(await sim.pay(body, { idem: "run1:K11" }));
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.id).toBe(rel.json.released[0].id);
    expect(await listAll(account)).toHaveLength(1);
  });
});

describe("rail legacy", () => {
  it("PAY-13: the Idempotency-Key is ignored: two POSTs, two payouts, no replay header", async () => {
    const account = await sim.account();
    const body = frozen({ account, rail: "legacy", marker: "run1:K11L", payee_ref: "payee_P11", amount_minor: 90000 });
    const a = ok(await sim.pay(body, { idem: "run1:K11L" }));
    const b = ok(await sim.pay(body, { idem: "run1:K11L" }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.json.id).not.toBe(b.json.id);
    expect(a.headers.get("idempotent-replayed")).toBeNull();
    expect(b.headers.get("idempotent-replayed")).toBeNull();
    expect(await listAll(account)).toHaveLength(2);
    // a different body under the same header is not a 422 either
    const c = ok(await sim.pay(frozen({ account, rail: "legacy", marker: "run1:K11L", payee_ref: "payee_P11", amount_minor: 1 }), { idem: "run1:K11L" }));
    expect(c.status).toBe(201);
    expect(await listAll(account)).toHaveLength(3);
  });
});

describe("retention on the virtual clock", () => {
  it("PAY-09a: after advancing past retention_ms the key is forgotten and a second object is created", async () => {
    const account = await sim.account({ retention_ms: 86_400_000 });
    const body = frozen({ account, marker: "run1:K13c" });
    const first = ok(await sim.pay(body, { idem: "run1:K13c" }));
    const adv = ok(await sim.admin("POST", "/admin/clock/advance", { account, ms: 86_400_001 }));
    expect(adv.json.offset_ms).toBe(86_400_001);
    const again = ok(await sim.pay(body, { idem: "run1:K13c" }));
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("false");
    expect(again.json.id).not.toBe(first.json.id);
    expect(await listAll(account)).toHaveLength(2);
  });

  it("a key younger than retention_ms is still remembered after a smaller advance", async () => {
    const account = await sim.account({ retention_ms: 10_000 });
    const body = frozen({ account, marker: "run1:K13d" });
    const first = ok(await sim.pay(body, { idem: "run1:K13d" }));
    ok(await sim.admin("POST", "/admin/clock/advance", { account, ms: 5_000 }));
    const again = ok(await sim.pay(body, { idem: "run1:K13d" }));
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.json.id).toBe(first.json.id);
    ok(await sim.admin("POST", "/admin/clock/advance", { account, ms: 5_000 }));
    const third = ok(await sim.pay(body, { idem: "run1:K13d" }));
    expect(third.headers.get("idempotent-replayed")).toBe("false");
  });

  it("the clock only increases", async () => {
    const account = await sim.account();
    expect(ok(await sim.admin("POST", "/admin/clock/advance", { account, ms: -5 })).status).toBe(400);
    expect(ok(await sim.admin("POST", "/admin/clock/advance", { account, ms: 0 })).status).toBe(400);
  });
});
