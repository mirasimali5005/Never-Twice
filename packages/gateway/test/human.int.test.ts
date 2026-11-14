// B3-INT-08 and TEST_PLAN AUT-06, AUT-07, AUT-10: releaseReserved (T10), freezeGrant, unresolved reservations stay held.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, freezeGrant, propose, quarantine, releaseReserved } from "../src/index.ts";
import { reservedFlow, unknownFlow } from "./support/flow.ts";
import { obligation, proposalFor, startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });
const grant = (run: string) => w.db.grants.findOne({ _id: `${run}:GOODWILL` });

describe("human actions", () => {
  it("AUT-06: release G10 (T10, human actor) returns 15000; G01 then fits exactly", async () => {
    const g10 = await reservedFlow(w, [], { entitlement_type: "GOODWILL", passenger_id: "G10" });
    const run = g10.run;
    await reservedFlow(w, [], { entitlement_type: "GOODWILL", passenger_id: "G05" }, { run });
    await reservedFlow(w, [], { entitlement_type: "GOODWILL", passenger_id: "G06" }, { run });
    expect(await grant(run)).toMatchObject({ held_minor: 45000 });
    const r = await releaseReserved(g10.deps, g10.id, "agent-supervisor");
    expect(r).toMatchObject({ state: "RELEASED" });
    expect(await w.db.audit.findOne({ intent_id: g10.id, to_state: "RELEASED" })).toMatchObject({ actor: { kind: "human", id: "agent-supervisor" }, detail: { transition: "T10" } });
    expect(await grant(run)).toMatchObject({ held_minor: 30000 });
    const g01 = obligation(run, { entitlement_type: "GOODWILL", passenger_id: "G01", amount_minor: 20000 });
    await w.db.obligations.insertOne(g01);
    expect((await propose(g10.deps, proposalFor(g01))).kind).toBe("RESERVED");
    expect(await grant(run)).toMatchObject({ held_minor: 50000 });
  });

  it("releaseReserved fails from any state but RESERVED (never after dispatch)", async () => {
    const f = await unknownFlow(w, { entitlement_type: "GOODWILL" });
    expect(await releaseReserved(f.deps, f.id, "x")).toBeNull();
    expect(await grant(f.run)).toMatchObject({ held_minor: 15000 });
  });

  it("AUT-07: OUTCOME_UNKNOWN and QUARANTINED amounts stay held; G01 awaits budget", async () => {
    const u = await unknownFlow(w, { entitlement_type: "GOODWILL", passenger_id: "G10" });
    const run = u.run;
    const q = await unknownFlow(w, { entitlement_type: "GOODWILL", passenger_id: "G05" }, { run });
    await quarantine(q.deps, q.it, "KEY_WINDOW_EXPIRED", "test");
    await reservedFlow(w, [], { entitlement_type: "GOODWILL", passenger_id: "G06" }, { run });
    expect(await grant(run)).toMatchObject({ held_minor: 45000 });
    const g01 = obligation(run, { entitlement_type: "GOODWILL", passenger_id: "G01", amount_minor: 20000 });
    await w.db.obligations.insertOne(g01);
    expect(await propose(u.deps, proposalFor(g01))).toEqual({ kind: "REFUSED", reason: "AWAITING_BUDGET" });
    expect(await grant(run)).toMatchObject({ held_minor: 45000 });
  });

  it("AUT-10: freezeGrant → goodwill propose awaits budget; a reserved goodwill intent's dispatch applies T11 AUTHORITY_REVOKED", async () => {
    const g05 = await reservedFlow(w, ["ACCEPT"], { entitlement_type: "GOODWILL", passenger_id: "G05" });
    await freezeGrant(g05.deps, g05.run, "supervisor");
    expect(await grant(g05.run)).toMatchObject({ frozen: true, held_minor: 15000 });
    expect(await w.db.audit.countDocuments({ run_id: g05.run, type: "GRANT_FROZEN" })).toBe(1);
    const g10 = obligation(g05.run, { entitlement_type: "GOODWILL", passenger_id: "G10" });
    await w.db.obligations.insertOne(g10);
    expect(await propose(g05.deps, proposalFor(g10))).toEqual({ kind: "REFUSED", reason: "AWAITING_BUDGET" });
    expect(await dispatch(g05.deps, g05.id)).toMatchObject({ state: "QUARANTINED", quarantine: { reason: "AUTHORITY_REVOKED" } });
    expect(g05.provider.calls).toHaveLength(0);
    expect(await grant(g05.run)).toMatchObject({ held_minor: 15000 });
  });
});
