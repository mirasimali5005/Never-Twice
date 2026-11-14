// B3-INT-06 (K8): a dispatcher paused past its lease. The reconciler takes over (epoch + 1); when the original call returns,
// its settle fails the epoch check. Uses test-only settings that break dispatch timeout < lease on purpose.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, takeOverExpired } from "../src/index.ts";
import { reservedFlow } from "./support/flow.ts";
import { startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });

describe("zombie dispatcher (K8)", () => {
  it("the held response cannot write after takeover; the provider object stays and is evidence for the reconciler", async () => {
    const f = await reservedFlow(w, ["ACCEPT"], { entitlement_type: "GOODWILL" }, { leaseMs: 300 });
    f.provider.delayMs = 1500; // the provider holds the response longer than the lease
    const running = dispatch(f.deps, f.id, "runner-zombie");
    await new Promise((r) => setTimeout(r, 900));
    const taken = await takeOverExpired({ ...f.deps, workerId: "reconciler-1" }, f.id, 1);
    expect(taken).toMatchObject({ state: "OUTCOME_UNKNOWN", lease_epoch: 2 });
    const fromZombie = await running;
    expect(fromZombie).toMatchObject({ state: "OUTCOME_UNKNOWN", lease_epoch: 2 }); // its T3 matched nothing
    expect(f.provider.ledger).toHaveLength(1);
    expect(await w.db.audit.countDocuments({ intent_id: f.id, to_state: "CONFIRMED" })).toBe(0);
    expect(await w.db.grants.findOne({ _id: `${f.run}:GOODWILL` })).toMatchObject({ held_minor: 15000, settled_minor: 0 });
  }, 30_000);
});
