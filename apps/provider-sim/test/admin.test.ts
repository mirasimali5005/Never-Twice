// C1-UNIT-05: account creation, reset, state hash unchanged by any GET, request-log entries with body hash.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { KEYS, TestSim, frozen, ok } from "./support.ts";

let sim: TestSim;
beforeAll(async () => {
  sim = await TestSim.start();
});
afterAll(async () => {
  await sim.stop();
});

describe("accounts", () => {
  it("creates with defaults (201); repeating the same call is harmless (200); a different config is 409; bad input 400", async () => {
    const account = "acct_admin_1";
    const a = ok(await sim.admin("POST", "/admin/accounts", { account }));
    expect(a.status).toBe(201);
    expect(a.json).toEqual({ account, retention_ms: 86_400_000, max_in_flight_ms: null, search_lag_ms: 5000 });
    const again = ok(await sim.admin("POST", "/admin/accounts", { account }));
    expect(again.status).toBe(200);
    expect(again.json).toEqual(a.json);
    expect(ok(await sim.admin("POST", "/admin/accounts", { account, retention_ms: 4000 })).status).toBe(409);
    expect(ok(await sim.admin("POST", "/admin/accounts", { account: "../evil" })).status).toBe(400);
    expect(ok(await sim.admin("POST", "/admin/accounts", { account: "acct_admin_2", retention_ms: -1 })).status).toBe(400);
    expect(ok(await sim.admin("POST", "/admin/accounts", { account: "acct_admin_3", max_in_flight_ms: 20000 })).json.max_in_flight_ms).toBe(20000);
    expect(ok(await sim.call("POST", "/admin/accounts", { key: KEYS.write, body: { account: "acct_admin_4" } })).status).toBe(401);
  });
});

describe("state hash, request log, reset", () => {
  it("state hash is unchanged by GETs, changes with a new object; request log carries key and body hash; reset truncates", async () => {
    const account = await sim.account();
    const h0 = ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json;
    expect(h0).toMatchObject({ account, objects: 0 });
    expect(h0.state_hash).toMatch(/^[0-9a-f]{64}$/);

    ok(await sim.pay(frozen({ account, marker: "run1:AD1" }), { idem: "run1:AD1" }));
    const h1 = ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json;
    expect(h1.objects).toBe(1);
    expect(h1.state_hash).not.toBe(h0.state_hash);

    // every kind of GET leaves it unchanged
    await sim.get(`/v1/payouts?account=${account}`);
    await sim.get(`/v1/search/payouts?account=${account}&marker=x`);
    await sim.get(`/v1/events?account=${account}`);
    await sim.get(`/v1/accounts/${account}`);
    await sim.admin("GET", `/admin/request-log?account=${account}`);
    expect(ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json).toEqual(h1);

    const log = ok(await sim.admin("GET", `/admin/request-log?account=${account}`)).json.data;
    expect(log[0]).toMatchObject({ method: "POST", path: "/v1/payouts", idempotency_key: "run1:AD1", outcome: "EXECUTED", status: 201, fault: null });
    expect(log[0].body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(log.filter((e: any) => e.outcome === "READ").length).toBeGreaterThanOrEqual(4);
    expect(log.every((e: any, i: number) => e.seq === i + 1)).toBe(true);
    // credentials never appear in the log
    expect(JSON.stringify(log)).not.toContain(KEYS.write);

    // reset: the only operation that truncates; config kept; the key is forgotten
    const files = fs.readdirSync(sim.dir).filter((f) => f.startsWith(account));
    expect(files.sort()).toEqual([`${account}.ledger.jsonl`, `${account}.requests.jsonl`]);
    expect(ok(await sim.admin("POST", "/admin/reset", { account })).json).toEqual({ account, reset: true });
    expect(ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json.objects).toBe(0);
    expect(ok(await sim.admin("GET", `/admin/request-log?account=${account}`)).json.data).toEqual([]);
    expect(ok(await sim.get(`/v1/accounts/${account}`)).status).toBe(200);
    const again = ok(await sim.pay(frozen({ account, marker: "run1:AD1" }), { idem: "run1:AD1" }));
    expect(again.headers.get("idempotent-replayed")).toBe("false");
    // ledger on disk holds the re-created account line and the new payout only
    const lines = fs.readFileSync(path.join(sim.dir, `${account}.ledger.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["account_created", "payout_created", "key_stored"]);
    expect(ok(await sim.admin("POST", "/admin/reset", { account: "acct_nope" })).status).toBe(404);
  });

  it("ledger and request-log lines follow the documented shape", async () => {
    const account = await sim.account();
    await sim.faults(account, [{ match: { payee_ref: "payee_P02" }, fault: "REJECT", code: "payee_closed", times: 1 }]);
    ok(await sim.pay(frozen({ account, marker: "run1:LL1" }), { idem: "run1:LL1" }));
    ok(await sim.pay(frozen({ account, marker: "run1:LL2" }), { idem: "run1:LL2" }));
    const lines = fs.readFileSync(path.join(sim.dir, `${account}.ledger.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["account_created", "key_stored", "payout_created", "key_stored"]);
    expect(lines[0]).toMatchObject({ seq: 1, account, retention_ms: 86_400_000, search_lag_ms: 5000 });
    expect(lines[1].result).toMatchObject({ status: 400, error: { code: "payee_closed" } });
    expect(lines[2].object.id).toMatch(/^po_/);
    expect(lines[3].result).toEqual({ status: 201, object_id: lines[2].object.id });
    for (const l of lines) {
      expect(typeof l.at).toBe("string");
      expect(typeof l.vt).toBe("string");
    }
    expect(new Set(lines.map((l) => l.seq)).size).toBe(lines.length);
  });

  it("an unknown account on admin endpoints is 404; non-JSON body is 400", async () => {
    expect(ok(await sim.admin("GET", "/admin/state-hash?account=acct_nope")).status).toBe(404);
    expect(ok(await sim.admin("GET", "/admin/request-log")).status).toBe(400);
    expect(ok(await sim.call("POST", "/admin/faults", { key: KEYS.admin, body: "not json" })).status).toBe(400);
  });
});
