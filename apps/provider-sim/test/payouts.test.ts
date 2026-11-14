// C1-UNIT-01: create, get, validation, auth scopes, healthz, accounts, request-log body hash, simulator header.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { KEYS, TestSim, frozen, ok } from "./support.ts";
import { loadKeysFromEnv } from "../src/auth.ts";

let sim: TestSim;
beforeAll(async () => {
  sim = await TestSim.start();
});
afterAll(async () => {
  await sim.stop();
});

describe("create and get", () => {
  it("PAYOUT creates po_ and REFUND creates rf_, status paid, then GET by id and 404", async () => {
    const account = await sim.account();
    const p = ok(await sim.pay(frozen({ account, payee_ref: "payee_P02", marker: "run1:A" }), { idem: "run1:A" }));
    expect(p.status).toBe(201);
    expect(p.json.id).toMatch(/^po_[0-9a-f]{16}$/);
    expect(p.json).toMatchObject({ kind: "payout", status: "paid", amount_minor: 70000, currency: "CAD", payee_ref: "payee_P02", parent_ref: null });
    expect(p.json.metadata.nt_marker).toBe("run1:A");
    expect(p.headers.get("x-simulator")).toBe("never-twice-provider-sim");
    expect(p.headers.get("idempotent-replayed")).toBe("false");

    const r = ok(await sim.pay(frozen({ account, operation: "REFUND", payee_ref: "payee_P03", amount_minor: 41260, marker: "run1:B" }), { idem: "run1:B" }));
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^rf_[0-9a-f]{16}$/);
    expect(r.json.kind).toBe("refund");

    const g = ok(await sim.get(`/v1/payouts/${p.json.id}`));
    expect(g.status).toBe(200);
    expect(g.json).toEqual(p.json);
    const nf = ok(await sim.get("/v1/payouts/po_0000000000000000"));
    expect(nf.status).toBe(404);
    expect(nf.json.error.code).toBe("not_found");
  });

  it("validation: amount_invalid, invalid_request", async () => {
    const account = await sim.account();
    const bad = async (mutate: (o: any) => void) => {
      const o = JSON.parse(frozen({ account }));
      mutate(o);
      return ok(await sim.pay(JSON.stringify(o)));
    };
    expect((await bad((o) => (o.amount_minor = 0))).json.error.code).toBe("amount_invalid");
    expect((await bad((o) => (o.amount_minor = 700.5))).json.error.code).toBe("amount_invalid");
    expect((await bad((o) => (o.currency = "USD"))).json.error.code).toBe("amount_invalid");
    expect((await bad((o) => (o.account = "acct_nope"))).json.error.code).toBe("invalid_request");
    expect((await bad((o) => (o.rail = "wire"))).json.error.code).toBe("invalid_request");
    expect((await bad((o) => (o.operation = "TRANSFER"))).json.error.code).toBe("invalid_request");
    expect((await bad((o) => delete o.payee_ref)).json.error.code).toBe("invalid_request");
    expect((await bad((o) => delete o.amount_minor)).json.error.code).toBe("invalid_request");
    const notJson = ok(await sim.pay("not json"));
    expect(notJson.status).toBe(400);
    expect(notJson.json.error.code).toBe("invalid_request");
    expect((await bad((o) => (o.amount_minor = 0))).status).toBe(400);
    // nothing was created
    const list = ok(await sim.get(`/v1/payouts?account=${account}`));
    expect(list.json.data).toHaveLength(0);
  });

  it("request log body hash equals the SHA-256 of the raw canonical body", async () => {
    const account = await sim.account();
    const body = frozen({ account, marker: "run1:H" });
    ok(await sim.pay(body, { idem: "run1:H" }));
    const log = ok(await sim.admin("GET", `/admin/request-log?account=${account}`));
    const post = log.json.data.find((e: any) => e.method === "POST");
    expect(post.body_sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(post).toMatchObject({ path: "/v1/payouts", idempotency_key: "run1:H", fault: null, outcome: "EXECUTED", status: 201 });
  });
});

describe("authentication", () => {
  it("healthz needs no key; accounts need a read or write key; unknown account 404", async () => {
    const h = ok(await sim.get("/healthz", null));
    expect(h.status).toBe(200);
    expect(h.json).toEqual({ ok: true, simulator: true });
    const account = await sim.account({ retention_ms: 4000, search_lag_ms: 1234 });
    for (const k of [KEYS.write, KEYS.read, KEYS.evalRead]) {
      const a = ok(await sim.get(`/v1/accounts/${account}`, k));
      expect(a.status).toBe(200);
      expect(a.json).toEqual({ account, retention_ms: 4000, max_in_flight_ms: null, search_lag_ms: 1234 });
    }
    expect(ok(await sim.get(`/v1/accounts/${account}`, null)).status).toBe(401);
    expect(ok(await sim.get(`/v1/accounts/${account}`, "wrong")).status).toBe(401);
    expect(ok(await sim.get(`/v1/accounts/${account}`, KEYS.admin)).status).toBe(401);
    const nf = ok(await sim.get("/v1/accounts/acct_missing"));
    expect(nf.status).toBe(404);
  });

  it("read keys never write; write key reads; admin only on /admin/*", async () => {
    const account = await sim.account();
    const body = frozen({ account });
    for (const k of [KEYS.read, KEYS.evalRead, KEYS.admin, null]) {
      const r = ok(await sim.pay(body, { key: k }));
      expect(r.status).toBe(401);
      expect(r.json.error.code).toBe("unauthorized");
    }
    expect(ok(await sim.get(`/v1/payouts?account=${account}`, KEYS.write)).status).toBe(200);
    expect(ok(await sim.get(`/v1/payouts?account=${account}`, KEYS.read)).status).toBe(200);
    expect(ok(await sim.get(`/v1/payouts?account=${account}`, KEYS.evalRead)).status).toBe(200);
    expect(ok(await sim.get(`/v1/payouts?account=${account}`, KEYS.admin)).status).toBe(401);
    for (const k of [KEYS.write, KEYS.read, KEYS.evalRead, null]) {
      expect(ok(await sim.call("GET", `/admin/state-hash?account=${account}`, { key: k })).status).toBe(401);
    }
    expect(ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).status).toBe(200);
    // the 401s are logged as UNAUTHORIZED against the account
    const log = ok(await sim.admin("GET", `/admin/request-log?account=${account}`));
    expect(log.json.data.filter((e: any) => e.outcome === "UNAUTHORIZED").length).toBeGreaterThan(0);
  });

  it("refuses to start without all four keys", () => {
    expect(() => loadKeysFromEnv({ NT_SIM_WRITE_KEY: "a", NT_SIM_READ_KEY: "b", NT_SIM_ADMIN_KEY: "d" })).toThrow(/NT_SIM_EVAL_READ_KEY/);
    expect(() => loadKeysFromEnv({})).toThrow(/refuses to start/);
    expect(loadKeysFromEnv({ NT_SIM_WRITE_KEY: "a", NT_SIM_READ_KEY: "b", NT_SIM_EVAL_READ_KEY: "c", NT_SIM_ADMIN_KEY: "d" }).evalRead).toBe("c");
  });
});
