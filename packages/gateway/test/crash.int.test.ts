// Real kills at barriers (HANDOVER.md §10.5 K2 and K6): a child process dispatches with NT_CRASH_AT and is SIGKILLed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reservedFlow } from "./support/flow.ts";
import { startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });

const child = fileURLToPath(new URL("./support/crash-child.ts", import.meta.url));
function runChild(run: string, id: string, crashAt: string) {
  return spawnSync(process.execPath, [child], {
    env: { ...process.env, NT_CRASH_AT: crashAt, CHILD_URI: w.rs.uri, CHILD_DB: w.rs.dbName, CHILD_RUN: run, CHILD_ID: id },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("crash barriers in a real process", () => {
  it("K2: killed at BR_DISPATCH_AFTER_MARK → DISPATCHING with a lease, nothing sent", async () => {
    const f = await reservedFlow(w);
    const r = runChild(f.run, f.id, `BR_DISPATCH_AFTER_MARK@${f.ob.effect_key}`);
    expect(r.signal).toBe("SIGKILL");
    expect(r.stdout).not.toContain("SENT");
    expect(await w.db.intents.findOne({ _id: f.id })).toMatchObject({ state: "DISPATCHING", lease_epoch: 1, lease: { owner: "runner-child" } });
  }, 90_000);

  it("K6: killed at BR_SETTLE_IN_TXN → still DISPATCHING, grant not moved, no T3 event (the transaction never committed)", async () => {
    const f = await reservedFlow(w, [], { entitlement_type: "GOODWILL" });
    const r = runChild(f.run, f.id, `BR_SETTLE_IN_TXN@${f.ob.effect_key}`);
    expect(r.signal).toBe("SIGKILL");
    expect(r.stdout).toContain("SENT");
    expect((await w.db.intents.findOne({ _id: f.id }))!.state).toBe("DISPATCHING");
    expect(await w.db.grants.findOne({ _id: `${f.run}:GOODWILL` })).toMatchObject({ held_minor: 15000, settled_minor: 0 });
    expect(await w.db.audit.countDocuments({ intent_id: f.id, to_state: "CONFIRMED" })).toBe(0);
  }, 90_000);

  it("without NT_CRASH_AT the same child confirms", async () => {
    const f = await reservedFlow(w);
    const r = runChild(f.run, f.id, "");
    expect(r.stdout).toContain("DONE CONFIRMED");
  }, 90_000);
});
