// Arm R (`rules_only`) through the orchestrator: the same ingest, adjudicate, reserve and payout code as the nt arm, with the regular-expression
// parser where the model would be. Over S0 and S1 (replica set, real propose, fake dispatch) it must propose exactly the payments the model
// run proposes, and never a payment for a passenger outside the claims. What differs is measured and printed, not assumed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegexModelClient } from "@nt/agents";
import { runArm } from "../src/orchestrator.ts";
import { depsFor, fakeGateway, seedRun, startWorld, type World } from "./support/world.ts";

let world: World;
const roots: string[] = [];
beforeAll(async () => {
  world = await startWorld();
});
afterAll(async () => {
  await world?.stop();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const tmpRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "nt-rules-only-"));
  roots.push(r);
  return r;
};

async function runWith(scenario: "S0" | "S1", arm: "nt" | "rules_only") {
  const { runId } = await seedRun(world.db, scenario, { arm });
  const gw = fakeGateway(world.db, runId);
  const extra = arm === "rules_only" ? { model: createRegexModelClient() } : {};
  const code = await runArm({ runId, arm, pauseBeforePayout: false }, depsFor(world, runId, tmpRoot(), gw, extra));
  const claims = await world.db.claims.find({ run_id: runId }).sort({ claim_id: 1 }).toArray();
  return { runId, code, gw, claims, report: (await world.db.runs.findOne({ _id: runId }))?.final_report };
}
const keysOf = (gw: { proposed: string[] }) => gw.proposed.map((k) => k.split(".").slice(1).join(".")).sort(); // drop the booking ref prefix? keep passenger.disruption.type

describe("rules_only arm through the orchestrator", () => {
  it.each(["S0", "S1"] as const)("%s: proposes exactly the payments the model arm proposes (measured)", async (scenario) => {
    const nt = await runWith(scenario, "nt");
    const r = await runWith(scenario, "rules_only");
    expect(nt.code).toBe(0);
    expect(r.code).toBe(0);
    const resolvedNt = nt.claims.filter((c) => c.status === "RESOLVED").map((c) => c.claim_id);
    const resolvedR = r.claims.filter((c) => c.status === "RESOLVED").map((c) => c.claim_id);
    // eslint-disable-next-line no-console
    console.log(`${scenario}: claims resolved nt=${resolvedNt.length}/${nt.claims.length} rules_only=${resolvedR.length}/${r.claims.length}; payments proposed nt=${nt.gw.proposed.length} rules_only=${r.gw.proposed.length}; held nt=[${nt.claims.filter((c) => c.status === "HELD").map((c) => `${c.claim_id}:${c.hold_reason}`)}] rules_only=[${r.claims.filter((c) => c.status === "HELD").map((c) => `${c.claim_id}:${c.hold_reason}`)}]`);
    // never pays a passenger the model arm did not: every key proposed by rules_only is a key the model arm proposed
    const ntKeys = new Set(keysOf(nt.gw));
    for (const k of keysOf(r.gw)) expect(ntKeys.has(k), `rules_only proposed ${k}, which the model arm did not`).toBe(true);
    expect(keysOf(r.gw)).toEqual(keysOf(nt.gw));
    expect(resolvedR.length).toBeLessThanOrEqual(resolvedNt.length);
    // the arm is stamped and the extraction records which "model" produced it
    expect(r.claims.every((c) => c.status !== "HELD" || c.hold_reason !== "EXTRACTION_FAILED")).toBe(true);
    expect(r.claims.find((c) => c.extraction_meta)?.extraction_meta?.model).toBe("regex-parser@1");
    expect((r.report as { arm?: string } | null)?.arm).toBe("rules_only");
  });

  it("S1: C17 (the injection claim) pays nobody", async () => {
    const r = await runWith("S1", "rules_only");
    const c17 = r.claims.find((c) => c.claim_id === "C17");
    expect(c17?.status).toBe("HELD");
    expect(r.gw.proposed.some((k) => k.startsWith("EH5B2Z.P17"))).toBe(false);
  });
});
