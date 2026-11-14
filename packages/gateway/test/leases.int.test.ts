// B3-INT-01: T2 mark, takeover (T5 reconciler form), lease acquisition on OUTCOME_UNKNOWN; all on the database clock.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbNow } from "@nt/db";
import { acquireLease, markDispatching, takeOverExpired } from "../src/index.ts";
import { reservedFlow, unknownFlow } from "./support/flow.ts";
import { startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("leases", () => {
  it("T2 stores a lease without an epoch; a second mark and a stale epoch match nothing", async () => {
    const f = await reservedFlow(w);
    const it0 = (await w.db.intents.findOne({ _id: f.id }))!;
    const m = await markDispatching(f.deps, it0, "runner-1");
    expect(m.kind).toBe("MARKED");
    if (m.kind !== "MARKED") return;
    expect(Object.keys(m.intent.lease!).sort()).toEqual(["expires_at", "owner"]);
    expect(m.intent.lease!.expires_at.getTime() - m.intent.first_dispatch_at!.getTime()).toBe(8000);
    expect(m.intent.lease_epoch).toBe(1);
    expect((await markDispatching(f.deps, it0, "runner-2")).kind).toBe("CAS_MISS"); // already DISPATCHING, stale epoch 0
    expect((await w.db.intents.findOne({ _id: f.id }))!.lease!.owner).toBe("runner-1");
  });

  it("takeover only after expiry by the database clock: epoch + 1, lease cleared, next_attempt_at = database now; never reset", async () => {
    const f = await reservedFlow(w, [], {}, { leaseMs: 400 });
    const m = await markDispatching(f.deps, (await w.db.intents.findOne({ _id: f.id }))!, "runner-1");
    if (m.kind !== "MARKED") throw new Error("mark");
    expect(await takeOverExpired(f.deps, f.id, 1)).toBeNull(); // lease still live
    await sleep(700);
    expect(await takeOverExpired(f.deps, f.id, 0)).toBeNull(); // wrong epoch
    const t0 = await dbNow(w.db);
    const t = await takeOverExpired({ ...f.deps, workerId: "reconciler-1" }, f.id, 1);
    const t1 = await dbNow(w.db);
    expect(t).toMatchObject({ state: "OUTCOME_UNKNOWN", lease: null, lease_epoch: 2 });
    expect(t!.next_attempt_at!.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    expect(t!.next_attempt_at!.getTime()).toBeLessThanOrEqual(t1.getTime());
    expect(t!.attempts[0]!.result).toMatchObject({ kind: "LEASE_EXPIRED" });
    const ev = await w.db.audit.findOne({ intent_id: f.id, "detail.transition": "T5" });
    expect(ev).toMatchObject({ actor: { kind: "reconciler", id: "reconciler-1" }, detail: { cause: "LEASE_EXPIRED", lease_epoch_after: 2 } });
  });

  it("acquisition: respects next_attempt_at, writes no audit event, 56 s lease by default, epoch + 1, exclusive", async () => {
    const f = await unknownFlow(w);
    const events = await w.db.audit.countDocuments({ intent_id: f.id });
    await w.db.intents.updateOne({ _id: f.id }, { $set: { next_attempt_at: new Date(Date.now() + 600_000) } });
    expect(await acquireLease(f.deps, f.id, 1)).toBeNull(); // not yet due
    await w.db.intents.updateOne({ _id: f.id }, { $set: { next_attempt_at: new Date(Date.now() - 1000) } });
    const a = await acquireLease({ ...f.deps, workerId: "reconciler-1" }, f.id, 1);
    expect(a).toMatchObject({ state: "OUTCOME_UNKNOWN", lease_epoch: 2, lease: { owner: "reconciler-1" } });
    expect(a!.lease!.expires_at.getTime() - (a as unknown as { updated_at: Date }).updated_at.getTime()).toBe(45_000 + 3_000 + 8_000);
    expect(await w.db.audit.countDocuments({ intent_id: f.id })).toBe(events);
    expect(await acquireLease({ ...f.deps, workerId: "reconciler-2" }, f.id, 2)).toBeNull(); // live lease
    expect(await acquireLease(f.deps, f.id, 1)).toBeNull(); // stale epoch
  });
});
