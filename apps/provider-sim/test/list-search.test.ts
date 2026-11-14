// C1-UNIT-04: pagination (25 objects, three pages), no skip when an object is created between pages,
// search lags then catches up after a clock advance, events are delayed and unordered.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestSim, frozen, ok } from "./support.ts";

let sim: TestSim;
beforeAll(async () => {
  sim = await TestSim.start();
});
afterAll(async () => {
  await sim.stop();
});

async function make(account: string, n: number, payee: string, prefix = "run1:L") {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const marker = `${prefix}${payee}:${i}`;
    ids.push(ok(await sim.pay(frozen({ account, marker, payee_ref: payee }), { idem: marker })).json.id);
  }
  return ids;
}

describe("list", () => {
  it("25 objects for one payee need three pages at the default limit of 10; filters by payee_ref and created_gte", async () => {
    const account = await sim.account();
    const before = new Date(Date.now() - 1000).toISOString();
    const ids = await make(account, 25, "payee_P02");
    await make(account, 5, "payee_decoy");
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `/v1/payouts?account=${account}&payee_ref=payee_P02&created_gte=${encodeURIComponent(before)}` + (cursor ? `&starting_after=${cursor}` : "");
      const r = ok(await sim.get(q, "test-read-key"));
      expect(r.status).toBe(200);
      pages++;
      seen.push(...r.json.data.map((o: any) => o.id));
      expect(r.json.has_more).toBe(pages < 3);
      cursor = r.json.next_cursor;
      expect(cursor === null).toBe(!r.json.has_more);
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(ids); // creation order, none skipped, no decoys
    // created_gte in the future finds nothing
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(ok(await sim.get(`/v1/payouts?account=${account}&created_gte=${encodeURIComponent(future)}`)).json.data).toEqual([]);
  });

  it("an object created between pages appears on a later page; none is skipped; limit is capped at 100", async () => {
    const account = await sim.account();
    const ids = await make(account, 12, "payee_P02");
    const p1 = ok(await sim.get(`/v1/payouts?account=${account}&limit=5`));
    expect(p1.json.data.map((o: any) => o.id)).toEqual(ids.slice(0, 5));
    const [late] = await make(account, 1, "payee_P02", "run1:late");
    const p2 = ok(await sim.get(`/v1/payouts?account=${account}&limit=100&starting_after=${p1.json.next_cursor}`));
    expect(p2.json.data.map((o: any) => o.id)).toEqual([...ids.slice(5), late]);
    expect(p2.json.has_more).toBe(false);
    expect(p2.json.next_cursor).toBeNull();
  });

  it("errors: account required, unknown account 404, bad limit, bad cursor", async () => {
    const account = await sim.account();
    expect(ok(await sim.get("/v1/payouts")).status).toBe(400);
    expect(ok(await sim.get("/v1/payouts?account=acct_nope")).status).toBe(404);
    expect(ok(await sim.get(`/v1/payouts?account=${account}&limit=0`)).status).toBe(400);
    expect(ok(await sim.get(`/v1/payouts?account=${account}&starting_after=po_nope`)).status).toBe(400);
  });
});

describe("search and events lag", () => {
  it("search is missing recent objects (inside search_lag_ms) and catches up after the virtual clock advances; list is immediate", async () => {
    const account = await sim.account({ search_lag_ms: 5000 });
    const marker = "run1:S1";
    const created = ok(await sim.pay(frozen({ account, marker }), { idem: marker })).json;
    expect(ok(await sim.get(`/v1/payouts?account=${account}`)).json.data).toHaveLength(1); // list: immediate
    const early = ok(await sim.get(`/v1/search/payouts?account=${account}&marker=${encodeURIComponent(marker)}`, "test-read-key"));
    expect(early.json).toEqual({ data: [] });
    ok(await sim.admin("POST", "/admin/clock/advance", { account, ms: 5001 }));
    const late = ok(await sim.get(`/v1/search/payouts?account=${account}&marker=${encodeURIComponent(marker)}`));
    expect(late.json.data.map((o: any) => o.id)).toEqual([created.id]);
    // other markers do not match
    expect(ok(await sim.get(`/v1/search/payouts?account=${account}&marker=nope`)).json.data).toEqual([]);
  });

  it("search with a zero lag is immediate", async () => {
    const account = await sim.account({ search_lag_ms: 0 });
    const marker = "run1:S2";
    ok(await sim.pay(frozen({ account, marker }), { idem: marker }));
    expect(ok(await sim.get(`/v1/search/payouts?account=${account}&marker=${marker}`)).json.data).toHaveLength(1);
  });

  it("events are delayed by the lag and not in creation order", async () => {
    const account = await sim.account({ search_lag_ms: 1000 });
    const ids = await make(account, 3, "payee_P02", "run1:EV");
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(ok(await sim.get(`/v1/events?account=${account}&since=${encodeURIComponent(since)}`)).json.data).toEqual([]);
    ok(await sim.admin("POST", "/admin/clock/advance", { account, ms: 1001 }));
    const ev = ok(await sim.get(`/v1/events?account=${account}&since=${encodeURIComponent(since)}`)).json.data;
    expect(ev.map((e: any) => e.object_id)).toEqual([...ids].reverse());
    expect(ev[0]).toMatchObject({ type: "payout.paid" });
    expect(ev[0].id).toMatch(/^ev_/);
  });
});
