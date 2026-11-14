// B2-INT-03 and TEST_PLAN AUT-05a, AUT-05b: adoption, divergence, concurrent proposals, unknown commit result.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoServerError, type ClientSession } from "mongodb";
import type { NtDb } from "@nt/db";
import { propose } from "../src/index.ts";
import { depsFor, freshRun, obligation, proposalFor, seedGrant, startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });

const types = async (run: string) => (await w.db.audit.find({ run_id: run }).sort({ _id: 1 }).toArray()).map((e) => e.type);

/** A db whose sessions end withTransaction with UnknownTransactionCommitResult, either after committing or without running. */
function unknownCommitDb(db: NtDb, mode: "after-commit" | "before-commit", times = 1): NtDb {
  let left = times;
  const client = new Proxy(db.client, {
    get(target, prop, recv) {
      if (prop !== "startSession") return Reflect.get(target, prop, recv);
      return (...args: Parameters<typeof target.startSession>) => {
        const s: ClientSession = target.startSession(...args);
        const orig = s.withTransaction.bind(s);
        s.withTransaction = (async (fn: never, opts: never) => {
          if (left <= 0) return orig(fn, opts);
          left--;
          if (mode === "after-commit") await orig(fn, opts);
          throw new MongoServerError({ message: "simulated", code: 50, errorLabels: ["UnknownTransactionCommitResult"] });
        }) as typeof s.withTransaction;
        return s;
      };
    },
  });
  return { ...db, client };
}

describe("adoption (§9.4)", () => {
  it("AUT-05a: the same decision twice → RESERVED then ADOPTED; one document; INTENT_RESERVED then INTENT_ADOPTED", async () => {
    const run = freshRun();
    const k02 = obligation(run, { passenger_id: "K02" });
    await w.db.obligations.insertOne(k02);
    const a = await propose(depsFor(w.db, run), proposalFor(k02));
    const b = await propose(depsFor(w.db, run), proposalFor(k02));
    expect(a.kind).toBe("RESERVED");
    expect(b.kind).toBe("ADOPTED");
    expect(b.kind === "ADOPTED" && b.intent._id).toBe(k02._id);
    expect(await w.db.intents.countDocuments({ run_id: run })).toBe(1);
    expect(await types(run)).toEqual(["INTENT_RESERVED", "INTENT_ADOPTED"]);
  });

  it("AUT-05b: a stored intent with a different hash → DIVERGED, DECISION_DIVERGENCE, RESERVED becomes QUARANTINED; goodwill stays held", async () => {
    const run = freshRun();
    await seedGrant(w.db, run);
    const g = obligation(run, { entitlement_type: "GOODWILL", passenger_id: "G10" });
    await w.db.obligations.insertOne(g);
    expect((await propose(depsFor(w.db, run), proposalFor(g))).kind).toBe("RESERVED");
    await w.db.intents.updateOne({ _id: g._id }, { $set: { frozen_request_sha256: "b".repeat(64) } }); // a resumed agent's other decision
    const r = await propose(depsFor(w.db, run), proposalFor(g));
    expect(r.kind).toBe("DIVERGED");
    expect(r.kind === "DIVERGED" && r.intent).toMatchObject({ state: "QUARANTINED", quarantine: { reason: "DECISION_DIVERGENCE" } });
    expect(await w.db.intents.countDocuments({ run_id: run })).toBe(1);
    expect(await types(run)).toEqual(["INTENT_RESERVED", "DECISION_DIVERGENCE", "TRANSITION"]);
    const t = await w.db.audit.findOne({ run_id: run, type: "TRANSITION" });
    expect(t).toMatchObject({ from_state: "RESERVED", to_state: "QUARANTINED", detail: { transition: "T11", reason: "DECISION_DIVERGENCE" } });
    expect(await w.db.grants.findOne({ _id: `${run}:GOODWILL` })).toMatchObject({ held_minor: 15000 }); // counted once, still held
  });

  it("divergence on an intent no longer RESERVED: DIVERGED, event only, no state change", async () => {
    const run = freshRun();
    const ob = obligation(run);
    await w.db.obligations.insertOne(ob);
    await propose(depsFor(w.db, run), proposalFor(ob));
    await w.db.intents.updateOne({ _id: ob._id }, { $set: { state: "DISPATCHING", frozen_request_sha256: "c".repeat(64) } });
    const r = await propose(depsFor(w.db, run), proposalFor(ob));
    expect(r.kind === "DIVERGED" && r.intent.state).toBe("DISPATCHING");
    expect(await types(run)).toEqual(["INTENT_RESERVED", "DECISION_DIVERGENCE"]);
  });

  it("five concurrent proposals for one key (two claims, two runners): one RESERVED, four ADOPTED, held once", async () => {
    const run = freshRun();
    await seedGrant(w.db, run);
    const g = obligation(run, { entitlement_type: "GOODWILL", passenger_id: "G20" });
    await w.db.obligations.insertOne(g);
    const rs = await Promise.all(Array.from({ length: 5 }, () => propose(depsFor(w.db, run), proposalFor(g))));
    expect(rs.filter((r) => r.kind === "RESERVED")).toHaveLength(1);
    expect(rs.filter((r) => r.kind === "ADOPTED")).toHaveLength(4);
    expect(await w.db.intents.countDocuments({ run_id: run })).toBe(1);
    expect(await w.db.grants.findOne({ _id: `${run}:GOODWILL` })).toMatchObject({ held_minor: 15000 });
    expect(await w.db.audit.countDocuments({ run_id: run, type: "INTENT_RESERVED" })).toBe(1);
  }, 120_000);

  it("unknown commit result, transaction committed: RESERVED (found by the pre-minted audit event), no adoption event", async () => {
    const run = freshRun();
    const ob = obligation(run);
    await w.db.obligations.insertOne(ob);
    const r = await propose(depsFor(unknownCommitDb(w.db, "after-commit"), run), proposalFor(ob));
    expect(r.kind).toBe("RESERVED");
    expect(await w.db.intents.countDocuments({ run_id: run })).toBe(1);
    expect(await types(run)).toEqual(["INTENT_RESERVED"]);
  });

  it("unknown commit result, nothing committed: propose runs the reserve again and reserves once", async () => {
    const run = freshRun();
    await seedGrant(w.db, run);
    const g = obligation(run, { entitlement_type: "GOODWILL", passenger_id: "G30" });
    await w.db.obligations.insertOne(g);
    const r = await propose(depsFor(unknownCommitDb(w.db, "before-commit"), run), proposalFor(g));
    expect(r.kind).toBe("RESERVED");
    expect(await w.db.intents.countDocuments({ run_id: run })).toBe(1);
    expect(await w.db.grants.findOne({ _id: `${run}:GOODWILL` })).toMatchObject({ held_minor: 15000 });
  });

  it("unknown commit result three times with nothing committed: propose throws, nothing reserved", async () => {
    const run = freshRun();
    const ob = obligation(run);
    await w.db.obligations.insertOne(ob);
    await expect(propose(depsFor(unknownCommitDb(w.db, "before-commit", 3), run), proposalFor(ob))).rejects.toThrow(/did not commit/);
    expect(await w.db.intents.countDocuments({ run_id: run })).toBe(0);
  });
});
