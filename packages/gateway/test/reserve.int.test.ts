// B2-INT-01 (reserve), AUT-09, the adversarial-proposal case of property P10, and the M5 mutation site.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashFrozenRequest } from "@nt/contracts";
import { propose } from "../src/index.ts";
import { depsFor, freshRun, obligation, proposalFor, seedGrant, startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });

describe("propose (T1)", () => {
  it("happy path: one RESERVED intent with every §8.1 field, one INTENT_RESERVED event, no grant change for a statutory entitlement", async () => {
    const run = freshRun();
    await seedGrant(w.db, run);
    const ob = obligation(run);
    await w.db.obligations.insertOne(ob);
    const barriers: string[] = [];
    const r = await propose(depsFor(w.db, run, { barriers }), proposalFor(ob));
    expect(r.kind).toBe("RESERVED");
    const it = await w.db.intents.findOne({ _id: ob._id });
    expect(it).toMatchObject({
      _id: ob._id, run_id: run, effect_key: ob.effect_key, obligation_id: ob._id, state: "RESERVED", lease: null, lease_epoch: 0,
      attempts: [], draws_on: null, provider: "sim_payout", idempotency_key: ob._id, amount_minor: 70000, currency: "CAD",
      policy_version: ob.policy_version, rule_citation: ob.rule_citation,
    });
    expect(it!.frozen_request_sha256).toBe(hashFrozenRequest(it!.frozen_request));
    expect(it!.frozen_request.metadata.nt_marker).toBe(ob._id);
    const events = await w.db.audit.find({ run_id: run }).toArray();
    expect(events.map((e) => [e.type, e.from_state, e.to_state])).toEqual([["INTENT_RESERVED", null, "RESERVED"]]);
    expect(events[0]!.detail).toMatchObject({ transition: "T1" });
    expect(await w.db.grants.findOne({ _id: `${run}:GOODWILL` })).toMatchObject({ held_minor: 0, settled_minor: 0 });
    expect(barriers).toEqual(["BR_RESERVE_BEFORE_COMMIT", "BR_RESERVE_AFTER_COMMIT"]);
  });

  it("keyless rail: idempotency_key null, provider sim_keyless", async () => {
    const run = freshRun();
    const ob = obligation(run, { rail: "legacy" });
    await w.db.obligations.insertOne(ob);
    const r = await propose(depsFor(w.db, run), proposalFor(ob));
    expect(r.kind === "RESERVED" && r.intent).toMatchObject({ provider: "sim_keyless", idempotency_key: null });
  });

  it("OBLIGATION_NOT_OWED for a missing, NOT_OWED or HELD obligation; nothing reserved, an ANOMALY event each", async () => {
    const run = freshRun();
    const missing = obligation(run);
    const notOwed = obligation(run, { status: "NOT_OWED", amount_minor: 0, reason_code: "DELAY_UNDER_3H" });
    const held = obligation(run, { status: "HELD", reason_code: "PAYEE_CHANGE_REQUESTED" });
    await w.db.obligations.insertMany([notOwed, held]);
    for (const ob of [missing, notOwed, held]) {
      const r = await propose(depsFor(w.db, run), proposalFor(ob, { amount_minor: 70000 }));
      expect(r).toEqual({ kind: "REFUSED", reason: "OBLIGATION_NOT_OWED" });
    }
    expect(await w.db.intents.countDocuments({ run_id: run })).toBe(0);
    expect(await w.db.audit.countDocuments({ run_id: run, type: "ANOMALY", "detail.reason": "OBLIGATION_NOT_OWED" })).toBe(3);
  });

  it("adversarial proposal (P10): a changed amount or payee is PROPOSAL_MISMATCH and nothing is reserved", async () => {
    const run = freshRun();
    const ob = obligation(run);
    await w.db.obligations.insertOne(ob);
    expect(await propose(depsFor(w.db, run), proposalFor(ob, { amount_minor: 100000 }))).toEqual({ kind: "REFUSED", reason: "PROPOSAL_MISMATCH" });
    expect(await propose(depsFor(w.db, run), proposalFor(ob, { payee_ref: "payee_ATTACKER" }))).toEqual({ kind: "REFUSED", reason: "PROPOSAL_MISMATCH" });
    expect(await w.db.intents.countDocuments({ run_id: run })).toBe(0);
    expect(await w.db.audit.countDocuments({ run_id: run, "detail.reason": "PROPOSAL_MISMATCH" })).toBe(2);
    // the correct proposal still reserves, with the obligation's values
    const r = await propose(depsFor(w.db, run), proposalFor(ob));
    expect(r.kind === "RESERVED" && r.intent.frozen_request).toMatchObject({ amount_minor: 70000, payee_ref: ob.payee_ref });
  });

  it("AUT-09: statutory payments are not cap-limited (pool full, K02 70000 reserves; draws_on null; counters unchanged)", async () => {
    const run = freshRun();
    await seedGrant(w.db, run, { held_minor: 50000 });
    const ob = obligation(run);
    await w.db.obligations.insertOne(ob);
    const r = await propose(depsFor(w.db, run), proposalFor(ob));
    expect(r.kind).toBe("RESERVED");
    expect(r.kind === "RESERVED" && r.intent.draws_on).toBeNull();
    expect(await w.db.grants.findOne({ _id: `${run}:GOODWILL` })).toMatchObject({ held_minor: 50000, settled_minor: 0 });
  });

  it("M5 (mutation site in reserve.ts): a second intent for one key becomes possible; effect_key and idempotency_key unchanged", async () => {
    const run = freshRun();
    const ob = obligation(run);
    await w.db.obligations.insertOne(ob);
    const a = await propose(depsFor(w.db, run, { mutation: "M5" }), proposalFor(ob));
    const b = await propose(depsFor(w.db, run, { mutation: "M5" }), proposalFor(ob));
    expect([a.kind, b.kind]).toEqual(["RESERVED", "RESERVED"]);
    const docs = await w.db.intents.find({ run_id: run }).toArray();
    expect(docs).toHaveLength(2);
    for (const d of docs) {
      expect(d._id.startsWith(`${ob._id}#`)).toBe(true);
      expect(d.frozen_request.metadata.nt_marker).toBe(d._id);
      expect(d.effect_key).toBe(ob.effect_key);
      expect(d.idempotency_key).toBe(ob._id);
    }
  });
});
