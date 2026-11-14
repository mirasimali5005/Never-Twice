// C4-UNIT: NotifySim, the keyless tool (HANDOVER.md §12.2, §11.4). Auth, keyless behaviour, list pagination (limit capped at 20),
// lagging search, state hash, admin plant, faults, rebuild from the ledger after a restart.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEYS, NO_RESPONSE_MS, TestSim, ok } from "./support.ts";

let sim: TestSim;
beforeAll(async () => {
  sim = await TestSim.start();
});
afterAll(async () => {
  await sim.stop();
});

const msgBody = (account: string, o: { recipient?: string; marker?: string } = {}) => ({
  account,
  recipient: o.recipient ?? "payee_P02",
  template: "decision_letter_v1",
  amount_minor: 70000,
  currency: "CAD",
  metadata: { nt_marker: o.marker ?? "run1:LETTER.P02", nt_run_id: "run1" },
});

function send(account: string, o: { recipient?: string; marker?: string; key?: string | null; idem?: string; timeoutMs?: number } = {}) {
  return sim.call("POST", "/v1/messages", { body: msgBody(account, o), key: o.key, idem: o.idem, timeoutMs: o.timeoutMs });
}

describe("NotifySim send and read", () => {
  it("POST needs the write key; GET accepts read keys; a read key never writes", async () => {
    const account = await sim.account();
    expect(ok(await send(account, { key: KEYS.read })).status).toBe(401);
    expect(ok(await send(account, { key: null })).status).toBe(401);
    expect(ok(await send(account, { key: KEYS.admin })).status).toBe(401);
    const r = ok(await send(account));
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ object: "message", status: "sent", recipient: "payee_P02", amount_minor: 70000, currency: "CAD" });
    expect(r.json.id).toMatch(/^msg_[0-9a-f]{16}$/);
    expect(r.headers.get("X-Simulator")).toBe("never-twice-provider-sim");
    const g = ok(await sim.get(`/v1/messages/${r.json.id}`, KEYS.read));
    expect(g.json).toEqual(r.json);
    expect(ok(await sim.get(`/v1/messages/${r.json.id}`, KEYS.evalRead)).status).toBe(200);
    expect(ok(await sim.get(`/v1/messages/msg_nope`, KEYS.read)).status).toBe(404);
    expect(ok(await sim.get(`/v1/messages?account=${account}`, null)).status).toBe(401);
  });

  it("is keyless: the same Idempotency-Key and body twice creates two messages and no Idempotent-Replayed header", async () => {
    const account = await sim.account();
    const a = ok(await send(account, { idem: "k1" }));
    const b = ok(await send(account, { idem: "k1" }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.json.id).not.toBe(b.json.id);
    expect(b.headers.get("Idempotent-Replayed")).toBeNull();
    expect(ok(await sim.get(`/v1/messages?account=${account}`)).json.data).toHaveLength(2);
  });

  it("validates the body", async () => {
    const account = await sim.account();
    expect(ok(await sim.call("POST", "/v1/messages", { body: "nope" })).status).toBe(400);
    expect(ok(await sim.call("POST", "/v1/messages", { body: { account, template: "t" } })).status).toBe(400);
    expect(ok(await sim.call("POST", "/v1/messages", { body: { account: "acct_nope", recipient: "x", template: "t" } })).status).toBe(400);
    expect(ok(await sim.call("POST", "/v1/messages", { body: { account, recipient: "x", template: "t", metadata: { a: 1 } } })).status).toBe(400);
  });
});

describe("NotifySim list and search", () => {
  it("list is immediate, filters by recipient and created_gte, and caps limit at 20 so 31 messages need the cursor", async () => {
    const account = await sim.account();
    const before = new Date(Date.now() - 1000).toISOString();
    const ids: string[] = [];
    for (let i = 0; i < 31; i++) ids.push(ok(await send(account, { marker: `run1:D${i}` })).json.id);
    ok(await send(account, { recipient: "payee_other" }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `/v1/messages?account=${account}&recipient=payee_P02&created_gte=${encodeURIComponent(before)}&limit=100` + (cursor ? `&starting_after=${cursor}` : "");
      const r = ok(await sim.get(q, KEYS.read));
      expect(r.json.data.length).toBeLessThanOrEqual(20);
      seen.push(...r.json.data.map((m: any) => m.id));
      cursor = r.json.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(2);
    expect(seen).toEqual(ids);
    const def = ok(await sim.get(`/v1/messages?account=${account}`));
    expect(def.json.data).toHaveLength(10);
    expect(def.json.has_more).toBe(true);
    expect(ok(await sim.get(`/v1/messages?account=${account}&limit=0`)).status).toBe(400);
    expect(ok(await sim.get(`/v1/messages?account=${account}&starting_after=msg_nope`)).status).toBe(400);
    expect(ok(await sim.get(`/v1/messages`)).status).toBe(400);
    expect(ok(await sim.get(`/v1/messages?account=acct_nope`)).status).toBe(404);
  });

  it("search lags: a message just sent is missing, then appears after the virtual clock passes the lag", async () => {
    const account = await sim.account({ search_lag_ms: 5000 });
    const marker = "run1:LAG";
    const m = ok(await send(account, { marker })).json;
    expect(ok(await sim.get(`/v1/messages?account=${account}`)).json.data).toHaveLength(1);
    expect(ok(await sim.get(`/v1/search/messages?account=${account}&marker=${encodeURIComponent(marker)}`, KEYS.read)).json).toEqual({ data: [] });
    ok(await sim.admin("POST", "/admin/clock/advance", { account, ms: 5001 }));
    expect(ok(await sim.get(`/v1/search/messages?account=${account}&marker=${encodeURIComponent(marker)}`)).json.data.map((x: any) => x.id)).toEqual([m.id]);
    expect(ok(await sim.get(`/v1/search/messages?account=${account}&marker=other`)).json.data).toEqual([]);
  });
});

describe("NotifySim state hash, admin plant, request log", () => {
  it("a message changes the state hash; GETs do not; admin can plant a message; reset clears messages", async () => {
    const account = await sim.account();
    const h0 = ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json.state_hash;
    const p = ok(await sim.admin("POST", "/admin/messages", { account, recipient: "payee_canary", metadata: { nt_marker: "canary:1" } }));
    expect(p.status).toBe(201);
    expect(p.json).toMatchObject({ object: "message", recipient: "payee_canary", template: "planted" });
    const h1 = ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json.state_hash;
    expect(h1).not.toBe(h0);
    ok(await sim.get(`/v1/messages?account=${account}`, KEYS.read));
    ok(await sim.get(`/v1/search/messages?account=${account}`, KEYS.read));
    expect(ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json.state_hash).toBe(h1);
    expect(ok(await sim.call("POST", "/admin/messages", { key: KEYS.write, body: { account, recipient: "x" } })).status).toBe(401);
    ok(await sim.admin("POST", "/admin/reset", { account }));
    expect(ok(await sim.get(`/v1/messages?account=${account}`)).json.data).toEqual([]);
    expect(ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json.state_hash).toBe(h0);
  });

  it("requests are logged with their path and outcome", async () => {
    const account = await sim.account();
    ok(await send(account));
    ok(await sim.get(`/v1/messages?account=${account}`));
    const log = ok(await sim.admin("GET", `/admin/request-log?account=${account}`)).json.data;
    expect(log.map((l: any) => [l.method, l.path.split("?")[0], l.outcome])).toEqual([
      ["POST", "/v1/messages", "EXECUTED"],
      ["GET", "/v1/messages", "READ"],
    ]);
  });
});

describe("NotifySim faults", () => {
  it("DROP_RESPONSE_AFTER_APPLY commits without answering; DROP_REQUEST commits nothing; REJECT answers 400 and commits nothing", async () => {
    const account = await sim.account();
    await sim.faults(account, [
      { match: { marker: "run1:A" }, fault: "DROP_RESPONSE_AFTER_APPLY" },
      { match: { marker: "run1:B" }, fault: "DROP_REQUEST" },
      { match: { marker: "run1:C" }, fault: "REJECT", code: "recipient_unknown" },
    ]);
    expect(await send(account, { marker: "run1:A", timeoutMs: NO_RESPONSE_MS })).toEqual({ timeout: true });
    expect(await send(account, { marker: "run1:B", timeoutMs: NO_RESPONSE_MS })).toEqual({ timeout: true });
    const rej = ok(await send(account, { marker: "run1:C" }));
    expect(rej.status).toBe(400);
    expect(rej.json.error.code).toBe("recipient_unknown");
    const markers = ok(await sim.get(`/v1/messages?account=${account}`)).json.data.map((m: any) => m.metadata.nt_marker);
    expect(markers).toEqual(["run1:A"]);
    // times: 1, so the next send with marker A is served normally (keyless: a second message)
    expect(ok(await send(account, { marker: "run1:A" })).status).toBe(201);
  });

  it("SERVER_ERROR_AFTER_APPLY commits and answers 500; IN_PROGRESS answers 409 without committing", async () => {
    const account = await sim.account();
    await sim.faults(account, [
      { match: { marker: "run1:E" }, fault: "SERVER_ERROR_AFTER_APPLY" },
      { match: { marker: "run1:F" }, fault: "IN_PROGRESS", n: 1 },
    ]);
    expect(ok(await send(account, { marker: "run1:E" })).status).toBe(500);
    expect(ok(await send(account, { marker: "run1:F" })).status).toBe(409);
    expect(ok(await sim.get(`/v1/messages?account=${account}`)).json.data.map((m: any) => m.metadata.nt_marker)).toEqual(["run1:E"]);
  });
});

describe("NotifySim restart", () => {
  it("messages are rebuilt from the ledger after a restart; the state hash is unchanged", async () => {
    const t = await TestSim.start();
    const account = await t.account();
    const m = ok(await t.call("POST", "/v1/messages", { body: msgBody(account) })).json;
    const h = ok(await t.admin("GET", `/admin/state-hash?account=${account}`)).json.state_hash;
    await t.stop(false);
    const t2 = await TestSim.start(t.dir);
    try {
      expect(ok(await t2.get(`/v1/messages/${m.id}`)).json).toEqual(m);
      expect(ok(await t2.admin("GET", `/admin/state-hash?account=${account}`)).json.state_hash).toBe(h);
      const m2 = ok(await t2.call("POST", "/v1/messages", { body: msgBody(account) })).json;
      expect(m2.id).not.toBe(m.id);
    } finally {
      await t2.stop();
    }
  });
});
