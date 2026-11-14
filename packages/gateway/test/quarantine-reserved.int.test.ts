// B2-INT-04: T11 RESERVED → QUARANTINED keeps the reservation held, for each of its three reasons; refused from any other state.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTENT_STATES } from "@nt/contracts";
import { propose, quarantineReserved, type T11Reason } from "../src/index.ts";
import { depsFor, freshRun, obligation, proposalFor, seedGrant, startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });

async function reservedGoodwill(passenger_id: string) {
  const run = freshRun();
  await seedGrant(w.db, run);
  const g = obligation(run, { entitlement_type: "GOODWILL", passenger_id });
  await w.db.obligations.insertOne(g);
  const r = await propose(depsFor(w.db, run), proposalFor(g));
  if (r.kind !== "RESERVED") throw new Error("setup failed");
  return { run, id: r.intent._id };
}

describe("quarantineReserved (T11)", () => {
  for (const reason of ["PAYEE_CHANGED", "AUTHORITY_REVOKED", "DECISION_DIVERGENCE"] as T11Reason[]) {
    it(`${reason}: QUARANTINED with the reason, lease_epoch unchanged, held stays 15000, one T11 TRANSITION event`, async () => {
      const { run, id } = await reservedGoodwill(`Q${reason.length}`);
      const q = await quarantineReserved(depsFor(w.db, run), id, reason, "test");
      expect(q).toMatchObject({ state: "QUARANTINED", lease_epoch: 0, lease: null, quarantine: { reason, detail: "test" } });
      expect(q!.quarantine!.at).toBeInstanceOf(Date);
      expect(await w.db.grants.findOne({ _id: `${run}:GOODWILL` })).toMatchObject({ held_minor: 15000, settled_minor: 0 });
      const ev = await w.db.audit.find({ run_id: run, type: "TRANSITION" }).toArray();
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ intent_id: id, from_state: "RESERVED", to_state: "QUARANTINED", detail: { transition: "T11", reason, epoch: 0 } });
    });
  }

  it("fails (null, nothing written) from every state but RESERVED", async () => {
    for (const state of INTENT_STATES.filter((s) => s !== "RESERVED")) {
      const { run, id } = await reservedGoodwill(`S${state.length}`);
      await w.db.intents.updateOne({ _id: id }, { $set: { state } });
      expect(await quarantineReserved(depsFor(w.db, run), id, "AUTHORITY_REVOKED", "x")).toBeNull();
      expect((await w.db.intents.findOne({ _id: id }))?.state).toBe(state);
      expect(await w.db.audit.countDocuments({ run_id: run, type: "TRANSITION" })).toBe(0);
    }
  });

  it("a live lease blocks T11; an expired one does not (database clock)", async () => {
    const { run, id } = await reservedGoodwill("L1");
    await w.db.intents.updateOne({ _id: id }, { $set: { lease: { owner: "w", expires_at: new Date(Date.now() + 600_000) } } });
    expect(await quarantineReserved(depsFor(w.db, run), id, "PAYEE_CHANGED", "x")).toBeNull();
    await w.db.intents.updateOne({ _id: id }, { $set: { lease: { owner: "w", expires_at: new Date(Date.now() - 600_000) } } });
    expect((await quarantineReserved(depsFor(w.db, run), id, "PAYEE_CHANGED", "x"))?.state).toBe("QUARANTINED");
  });

  it("an unknown intent id returns null", async () => {
    expect(await quarantineReserved(depsFor(w.db, freshRun()), "r0000000:NOPE", "PAYEE_CHANGED", "x")).toBeNull();
  });
});
