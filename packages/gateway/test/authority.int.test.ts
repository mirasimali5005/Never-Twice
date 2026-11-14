// B2-INT-02 and TEST_PLAN AUT-01, AUT-02, AUT-03, AUT-04 (B2 part; AUT-06, -07, -08, -10 need B3's actions).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Obligation } from "@nt/contracts";
import { propose } from "../src/index.ts";
import { depsFor, freshRun, obligation, proposalFor, seedGrant, startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });

const gw = (run: string, amount: number, passenger_id: string) => obligation(run, { entitlement_type: "GOODWILL", amount_minor: amount, passenger_id });
const grantOf = (run: string) => w.db.grants.findOne({ _id: `${run}:GOODWILL` });
const external = Boolean(process.env.NT_TEST_MONGODB_URI);

async function reserveAll(run: string, obs: Obligation[]) {
  for (const ob of obs) expect((await propose(depsFor(w.db, run), proposalFor(ob))).kind).toBe("RESERVED");
}

describe("authority gate", () => {
  it("AUT-01 under cap: RESERVED with draws_on, held 15000, one INTENT_RESERVED event", async () => {
    const run = freshRun();
    await seedGrant(w.db, run);
    const g10 = gw(run, 15000, "G10");
    await w.db.obligations.insertOne(g10);
    const r = await propose(depsFor(w.db, run), proposalFor(g10));
    expect(r.kind === "RESERVED" && r.intent.draws_on).toBe(`${run}:GOODWILL`);
    expect(await grantOf(run)).toMatchObject({ held_minor: 15000, settled_minor: 0 });
    expect(await w.db.audit.countDocuments({ run_id: run, type: "INTENT_RESERVED" })).toBe(1);
  });

  it("AUT-02 exact cap and AUT-03 over cap: AWAITING_BUDGET, no intent, held unchanged, one BUDGET_REFUSED event", async () => {
    const run = freshRun();
    await seedGrant(w.db, run);
    const obs = [gw(run, 15000, "G10"), gw(run, 15000, "G05"), gw(run, 20000, "G01")];
    await w.db.obligations.insertMany(obs);
    await reserveAll(run, obs);
    expect(await grantOf(run)).toMatchObject({ held_minor: 50000 }); // AUT-02: equal to the grant

    const run2 = freshRun();
    await seedGrant(w.db, run2);
    const obs2 = [gw(run2, 15000, "G10"), gw(run2, 15000, "G05"), gw(run2, 15000, "G06")];
    const g01 = gw(run2, 20000, "G01");
    await w.db.obligations.insertMany([...obs2, g01]);
    await reserveAll(run2, obs2);
    expect(await propose(depsFor(w.db, run2), proposalFor(g01))).toEqual({ kind: "REFUSED", reason: "AWAITING_BUDGET" });
    expect(await grantOf(run2)).toMatchObject({ held_minor: 45000 });
    expect(await w.db.intents.countDocuments({ _id: g01._id })).toBe(0);
    expect((await w.db.obligations.findOne({ _id: g01._id }))?.status).toBe("OWED");
    expect(await w.db.audit.countDocuments({ run_id: run2, type: "BUDGET_REFUSED" })).toBe(1);
  });

  it("a frozen grant refuses goodwill the same way", async () => {
    const run = freshRun();
    await seedGrant(w.db, run, { frozen: true });
    const g = gw(run, 15000, "G10");
    await w.db.obligations.insertOne(g);
    expect(await propose(depsFor(w.db, run), proposalFor(g))).toEqual({ kind: "REFUSED", reason: "AWAITING_BUDGET" });
    expect(await grantOf(run)).toMatchObject({ held_minor: 0 });
  });

  const reps = Number(process.env.NT_AUT04_REPS ?? (external ? 5 : 50));
  it(`AUT-04 five concurrent workers over 80000 of goodwill, ${reps} repetitions: never above 50000, held = sum of RESERVED`, async () => {
    const amounts = [15000, 20000, 15000, 20000, 10000]; // 80000 in total
    let awaitingSeen = 0;
    for (let rep = 0; rep < reps; rep++) {
      const run = freshRun();
      await seedGrant(w.db, run);
      const obs = amounts.map((a, i) => gw(run, a, `G${i}`));
      await w.db.obligations.insertMany(obs);
      const results = await Promise.all(obs.map((ob) => propose(depsFor(w.db, run), proposalFor(ob))));
      const g = await grantOf(run);
      const reserved = await w.db.intents.find({ run_id: run, state: "RESERVED" }).toArray();
      const sum = reserved.reduce((s, x) => s + x.amount_minor, 0);
      expect(sum).toBeLessThanOrEqual(50000);
      expect(g!.held_minor).toBe(sum);
      const awaiting = results.flatMap((r, i) => (r.kind === "REFUSED" && r.reason === "AWAITING_BUDGET" ? [amounts[i]!] : []));
      expect(awaiting.length).toBeGreaterThanOrEqual(1);
      for (const a of awaiting) expect(a).toBeGreaterThan(50000 - g!.held_minor); // nothing left waiting would fit
      awaitingSeen += awaiting.length;
    }
    expect(awaitingSeen).toBeGreaterThanOrEqual(reps);
  }, 600_000);

  it("25 concurrent proposals never exceed the grant; under M1 the same test exceeds it", async () => {
    for (const mutation of [undefined, "M1"] as const) {
      const run = freshRun();
      await seedGrant(w.db, run);
      const obs = Array.from({ length: 25 }, (_, i) => gw(run, 15000, `M${i}`));
      await w.db.obligations.insertMany(obs);
      await Promise.all(obs.map((ob) => propose(depsFor(w.db, run, mutation ? { mutation } : {}), proposalFor(ob))));
      const g = await grantOf(run);
      if (mutation) expect(g!.held_minor).toBeGreaterThan(50000);
      else expect(g!.held_minor).toBe(45000);
      expect(await w.db.intents.countDocuments({ run_id: run })).toBe(g!.held_minor / 15000);
    }
  }, 300_000);
});
