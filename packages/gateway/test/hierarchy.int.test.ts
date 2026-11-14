// AUTH-H (Tier 3, CP-AUTH-1): hierarchical authority. Airline pool → desk sub-pools → per-agent limits. A goodwill reservation must
// fit EVERY level, enforced by guarded $inc on each level inside the reserve transaction. N=25 concurrent proposals never exceed any
// level; settle and definitive failure move every level; freezing the airline pool revokes the agents under it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Obligation } from "@nt/contracts";
import { dispatch, propose, scanInvariants, seedGrantTree, type GatewayDeps, type GrantNode } from "../src/index.ts";
import { fakeProvider } from "./support/fake-provider.ts";
import { depsFor, freshRun, obligation, proposalFor, startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });

const TREE: GrantNode[] = [
  { id: "GOODWILL", parent: null, grant_minor: 150000 }, // airline pool: 10 × 15000
  { id: "GOODWILL/DESK_A", parent: "GOODWILL", grant_minor: 90000 }, // 6
  { id: "GOODWILL/DESK_B", parent: "GOODWILL", grant_minor: 90000 }, // 6
  { id: "GOODWILL/DESK_A/AGENT_1", parent: "GOODWILL/DESK_A", grant_minor: 45000 }, // 3
  { id: "GOODWILL/DESK_A/AGENT_2", parent: "GOODWILL/DESK_A", grant_minor: 60000 }, // 4
  { id: "GOODWILL/DESK_B/AGENT_3", parent: "GOODWILL/DESK_B", grant_minor: 30000 }, // 2
  { id: "GOODWILL/DESK_B/AGENT_4", parent: "GOODWILL/DESK_B", grant_minor: 60000 }, // 4
];
const AGENTS = ["GOODWILL/DESK_A/AGENT_1", "GOODWILL/DESK_A/AGENT_2", "GOODWILL/DESK_B/AGENT_3", "GOODWILL/DESK_B/AGENT_4"];

let pax = 0;
const gw = (run: string): Obligation => obligation(run, { entitlement_type: "GOODWILL", amount_minor: 15000, passenger_id: `H${String(++pax).padStart(3, "0")}` });
function agentDeps(run: string, leaf: string | null, providers?: GatewayDeps["providers"], mutation?: string): GatewayDeps {
  const d = depsFor(w.db, run, { workerId: `runner-${leaf ?? "pool"}`, ...(providers ? { providers } : {}), ...(mutation ? { mutation } : {}) });
  return { ...d, config: { ...d.config, authorityGrantId: leaf } };
}
const grants = async (run: string) => Object.fromEntries((await w.db.grants.find({ run_id: run }).toArray()).map((g) => [g._id.slice(run.length + 1), g]));

describe("hierarchical authority", () => {
  it("N=25 concurrent proposals across four agents: no level is exceeded, the pool fills exactly, counters equal the intents", async () => {
    const run = freshRun();
    await seedGrantTree(w.db, run, TREE);
    const obs = Array.from({ length: 25 }, () => gw(run));
    await w.db.obligations.insertMany(obs);
    const results = await Promise.all(obs.map((ob, i) => propose(agentDeps(run, AGENTS[i % 4]!), proposalFor(ob))));
    const reserved = results.filter((r) => r.kind === "RESERVED");
    expect(results.every((r) => r.kind === "RESERVED" || (r.kind === "REFUSED" && r.reason === "AWAITING_BUDGET"))).toBe(true);

    const g = await grants(run);
    for (const n of TREE) expect(g[n.id]!.held_minor + g[n.id]!.settled_minor, n.id).toBeLessThanOrEqual(n.grant_minor);
    // Desk A can hold 6 and desk B 6, so the airline pool (10) is the binding level: it must be exactly full.
    expect(reserved).toHaveLength(10);
    expect(g["GOODWILL"]!.held_minor).toBe(150000);
    const intents = await w.db.intents.find({ run_id: run }).toArray();
    expect(intents).toHaveLength(10);
    for (const a of AGENTS) {
      const mine = intents.filter((i) => i.draws_on === `${run}:${a}`);
      expect(g[a]!.held_minor).toBe(mine.length * 15000);
      for (const i of mine) expect(i.frozen_request.metadata.nt_authority).toBe(a);
    }
    expect(g["GOODWILL/DESK_A"]!.held_minor).toBe(g["GOODWILL/DESK_A/AGENT_1"]!.held_minor + g["GOODWILL/DESK_A/AGENT_2"]!.held_minor);
    const scan = await scanInvariants(agentDeps(run, null), run);
    expect(scan.violations.filter((v) => v.code.startsWith("P2"))).toEqual([]);
    expect(await w.db.audit.countDocuments({ run_id: run, type: "BUDGET_REFUSED" })).toBe(15);
  }, 120_000);

  it("the test bites: under mutation M1 (cap clause omitted) the same 25 proposals exceed levels and the scan reports P2_CAP_EXCEEDED", async () => {
    const run = freshRun();
    await seedGrantTree(w.db, run, TREE);
    const obs = Array.from({ length: 25 }, () => gw(run));
    await w.db.obligations.insertMany(obs);
    await Promise.all(obs.map((ob, i) => propose(agentDeps(run, AGENTS[i % 4]!, undefined, "M1"), proposalFor(ob))));
    const codes = (await scanInvariants(agentDeps(run, null), run)).violations.map((v) => v.code);
    expect(codes).toContain("P2_CAP_EXCEEDED");
  }, 120_000);

  it("a per-agent limit refuses before the desk or pool is full; the refusal leaves no level incremented", async () => {
    const run = freshRun();
    await seedGrantTree(w.db, run, TREE);
    const obs = [gw(run), gw(run), gw(run)];
    await w.db.obligations.insertMany(obs);
    const d = agentDeps(run, "GOODWILL/DESK_B/AGENT_3"); // 2 × 15000
    expect((await propose(d, proposalFor(obs[0]!))).kind).toBe("RESERVED");
    expect((await propose(d, proposalFor(obs[1]!))).kind).toBe("RESERVED");
    expect(await propose(d, proposalFor(obs[2]!))).toEqual({ kind: "REFUSED", reason: "AWAITING_BUDGET" });
    const g = await grants(run);
    expect([g["GOODWILL/DESK_B/AGENT_3"]!.held_minor, g["GOODWILL/DESK_B"]!.held_minor, g["GOODWILL"]!.held_minor]).toEqual([30000, 30000, 30000]);
    expect(g["GOODWILL/DESK_A"]!.held_minor).toBe(0);
  });

  it("settle moves held → settled on every level; a definitive rejection returns the hold on every level", async () => {
    const run = freshRun();
    await seedGrantTree(w.db, run, TREE);
    const [a, b] = [gw(run), gw(run)];
    await w.db.obligations.insertMany([a, b]);
    const fp = { sim_payout: fakeProvider("sim_payout", {}, ["ACCEPT", { kind: "REJECTED_DEFINITIVE", code: "payee_closed", message: "x", replayed: false }]) };
    const d = agentDeps(run, "GOODWILL/DESK_A/AGENT_1", fp);
    const ra = await propose(d, proposalFor(a));
    const rb = await propose(d, proposalFor(b));
    expect((await dispatch(d, ra.kind === "RESERVED" ? ra.intent._id : "")).state).toBe("CONFIRMED");
    expect((await dispatch(d, rb.kind === "RESERVED" ? rb.intent._id : "")).state).toBe("FAILED_NO_EFFECT");
    const g = await grants(run);
    for (const id of ["GOODWILL/DESK_A/AGENT_1", "GOODWILL/DESK_A", "GOODWILL"]) expect(g[id], id).toMatchObject({ held_minor: 0, settled_minor: 15000 });
    expect(g["GOODWILL/DESK_B"]).toMatchObject({ held_minor: 0, settled_minor: 0 });
    expect((await scanInvariants(d, run)).violations.filter((v) => v.code.startsWith("P2") || v.code.startsWith("P9"))).toEqual([]);
  });

  it("freezing the airline pool revokes an agent's reservation at dispatch (T11 AUTHORITY_REVOKED) and refuses new ones; nothing sent", async () => {
    const run = freshRun();
    await seedGrantTree(w.db, run, TREE);
    const [a, b] = [gw(run), gw(run)];
    await w.db.obligations.insertMany([a, b]);
    const fp = { sim_payout: fakeProvider("sim_payout") };
    const d = agentDeps(run, "GOODWILL/DESK_B/AGENT_4", fp);
    const ra = await propose(d, proposalFor(a));
    await w.db.grants.updateOne({ _id: `${run}:GOODWILL` }, { $set: { frozen: true } });
    const after = await dispatch(d, ra.kind === "RESERVED" ? ra.intent._id : "");
    expect(after.state).toBe("QUARANTINED");
    expect(after.quarantine?.reason).toBe("AUTHORITY_REVOKED");
    expect(fp.sim_payout.calls).toHaveLength(0);
    expect(await propose(d, proposalFor(b))).toEqual({ kind: "REFUSED", reason: "AWAITING_BUDGET" });
  });

  it("the default (no leaf configured) still draws on the single pool with unchanged frozen requests", async () => {
    const run = freshRun();
    await seedGrantTree(w.db, run, TREE);
    const a = gw(run);
    await w.db.obligations.insertOne(a);
    const r = await propose(agentDeps(run, null), proposalFor(a));
    expect(r.kind === "RESERVED" && r.intent.draws_on).toBe(`${run}:GOODWILL`);
    expect(r.kind === "RESERVED" && "nt_authority" in r.intent.frozen_request.metadata).toBe(false);
    const g = await grants(run);
    expect([g["GOODWILL"]!.held_minor, g["GOODWILL/DESK_A"]!.held_minor]).toEqual([15000, 0]);
  });

  it("seedGrantTree rejects a tree whose root is not the run's pool or whose parent is unknown", async () => {
    const run = freshRun();
    await expect(seedGrantTree(w.db, run, [{ id: "OTHER", parent: null, grant_minor: 1 }])).rejects.toThrow(/root/);
    await expect(seedGrantTree(w.db, run, [{ id: "GOODWILL", parent: null, grant_minor: 1 }, { id: "X", parent: "Y", grant_minor: 1 }])).rejects.toThrow(/parent/);
  });
});
