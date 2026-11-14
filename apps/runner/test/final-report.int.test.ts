// E4: the final report derived from MongoDB state alone (HANDOVER.md §14; AGENT_TASKS.md E field 12). Real S1 adjudication on an in-memory
// replica set, then intents pushed into each state by direct writes (what the gateway and the reconciler would do).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FinalReport, RELEASED_BEFORE_SEND } from "@nt/contracts";
import { buildFinalReport, rewriteReport } from "../src/final-report.ts";
import { runArm } from "../src/orchestrator.ts";
import { depsFor, fakeGateway, seedRun, startWorld, type World } from "./support/world.ts";

let world: World;
beforeAll(async () => {
  world = await startWorld();
});
afterAll(async () => {
  await world?.stop();
});

const listsOf = (r: FinalReport) => ({
  paid: r.paid.map((x) => x.effect_key),
  refused: r.refused.map((x) => x.effect_key),
  parked: r.parked.map((x) => x.effect_key ?? `claim:${x.claim_id}`),
  awaiting_budget: r.awaiting_budget.map((x) => x.effect_key),
  failed_no_effect: r.failed_no_effect.map((x) => x.effect_key),
  unresolved: r.unresolved.map((x) => x.effect_key),
});
const where = (r: FinalReport, key: string) => Object.entries(listsOf(r)).filter(([, v]) => v.includes(key)).map(([k]) => k);

describe("buildFinalReport", () => {
  it("puts every claim and obligation in exactly one list, with parked rules, RELEASED_BEFORE_SEND and the complete flag", async () => {
    const { runId, groupId } = await seedRun(world.db, "S1", { arm: "nt" });
    const root = mkdtempSync(join(tmpdir(), "nt-report-"));
    await runArm({ runId, pauseBeforePayout: false }, depsFor(world, runId, root, fakeGateway(world.db, runId)));

    const base = await buildFinalReport(world.db, runId);
    expect(FinalReport.parse(base)).toEqual(base);
    expect(base).toMatchObject({ run_id: runId, group_id: groupId, arm: "nt", scenario: "S1", complete: true });
    expect(base.paid).toHaveLength(13);
    expect(base.paid.every((p) => p.marker === `${runId}:${p.effect_key}` && p.provider_object_id.startsWith("po_"))).toBe(true);
    expect(base.awaiting_budget).toHaveLength(2);
    expect(base.awaiting_budget.every((a) => a.amount_minor === 15000)).toBe(true);
    // parked: three obligation holds (reason set, amount null, no claim id) and the claim-level hold of C17 (no effect key)
    expect(base.parked).toContainEqual({ effect_key: null, claim_id: "C17", reason_code: "BOOKING_UNRESOLVED", amount_minor: null });
    expect(base.parked.filter((p) => p.effect_key !== null && p.claim_id === null && p.amount_minor === null)).toHaveLength(3);
    // arrays are sorted by effect_key
    const sorted = (xs: string[]) => [...xs].sort();
    expect(base.paid.map((p) => p.effect_key)).toEqual(sorted(base.paid.map((p) => p.effect_key)));

    // every obligation in exactly one list; every claim-level hold in parked; every resolved claim reaches the report through its obligations
    const obligations = await world.db.obligations.find({ run_id: runId }).toArray();
    for (const o of obligations) expect(where(base, o.effect_key), o.effect_key).toHaveLength(1);
    const all = Object.values(listsOf(base)).flat();
    expect(all.filter((k) => !k.startsWith("claim:")).length).toBe(obligations.length);
    const claims = await world.db.claims.find({ run_id: runId }).toArray();
    for (const c of claims) {
      if (c.status === "HELD") expect(where(base, `claim:${c.claim_id}`)).toEqual(["parked"]);
      else for (const k of c.effect_keys) expect(where(base, k), `${c.claim_id} ${k}`).toHaveLength(1);
    }

    // push intents into the other states, as the gateway and the reconciler would
    const key = (pax: string, type: string) => obligations.find((o) => o.passenger_id === pax && o.entitlement_type === type)!.effect_key;
    const set = (k: string, s: Record<string, unknown>) => world.db.intents.updateOne({ _id: `${runId}:${k}` }, { $set: s });
    const quarKey = key("P01", "APPR_DELAY");
    const failKey = key("P02", "APPR_DELAY");
    const relKey = key("P05", "APPR_DELAY");
    const unkKey = key("P11", "APPR_DENIED_BOARDING");
    const resKey = key("P13", "APPR_DELAY");
    await set(quarKey, { state: "QUARANTINED", evidence: null, quarantine: { reason: "NO_DEDUPE_NO_EVIDENCE", detail: "t", at: new Date() } });
    await set(failKey, { state: "FAILED_NO_EFFECT", evidence: null, rejection: { code: "payee_closed", message: "closed", replayed: false, at: new Date() } });
    await set(relKey, { state: "RELEASED", evidence: null });
    await set(unkKey, { state: "OUTCOME_UNKNOWN", evidence: null });
    await set(resKey, { state: "RESERVED", evidence: null });
    // a held obligation that also has an intent (payee change after reservation): the intent decides, it is listed once
    const heldWithIntent = key("P10", "APPR_DENIED_BOARDING");
    await set(heldWithIntent, { state: "QUARANTINED", evidence: null, quarantine: { reason: "PAYEE_CHANGED", detail: "t", at: new Date() } });
    await world.db.obligations.updateOne({ _id: `${runId}:${heldWithIntent}` }, { $set: { status: "HELD", reason_code: "PAYEE_CHANGE_REQUESTED" } });

    const r = await buildFinalReport(world.db, runId);
    expect(r.parked).toContainEqual({ effect_key: quarKey, claim_id: null, reason_code: "NO_DEDUPE_NO_EVIDENCE", amount_minor: 70000 });
    expect(r.parked).toContainEqual({ effect_key: heldWithIntent, claim_id: null, reason_code: "PAYEE_CHANGED", amount_minor: 180000 });
    expect(r.failed_no_effect).toContainEqual({ effect_key: failKey, code: "payee_closed" });
    expect(r.failed_no_effect).toContainEqual({ effect_key: relKey, code: RELEASED_BEFORE_SEND });
    expect(r.unresolved).toEqual(expect.arrayContaining([{ effect_key: unkKey, state: "OUTCOME_UNKNOWN" }, { effect_key: resKey, state: "RESERVED" }]));
    for (const o of obligations) expect(where(r, o.effect_key), o.effect_key).toHaveLength(1);
    expect(r.paid).toHaveLength(13 - 6);
    expect(r.complete).toBe(false);

    // an owed obligation with no intent and no budget refusal is unresolved NO_INTENT; with a budget refusal it is awaiting budget
    await world.db.intents.deleteOne({ _id: `${runId}:${key("P03", "APPR_REFUND_COMP")}` });
    const r2 = await buildFinalReport(world.db, runId);
    expect(r2.unresolved).toContainEqual({ effect_key: key("P03", "APPR_REFUND_COMP"), state: "NO_INTENT" });

    // complete is true again only when nothing is unresolved and every claim is adjudicated
    await set(unkKey, { state: "CONFIRMED", evidence: { source: "PROBE", provider_object_id: "po_x", status: "paid", amount_minor: 90000, currency: "CAD", payee_ref: "payee_P11", marker: `${runId}:${unkKey}`, retrieved_at: new Date() } });
    await set(resKey, { state: "CONFIRMED", evidence: { source: "RESPONSE", provider_object_id: "po_y", status: "paid", amount_minor: 70000, currency: "CAD", payee_ref: "payee_P13", marker: `${runId}:${resKey}`, retrieved_at: new Date() } });
    await world.db.intents.deleteOne({ _id: `${runId}:${key("P03", "APPR_REFUND_COMP")}` });
    await world.db.obligations.deleteOne({ _id: `${runId}:${key("P03", "APPR_REFUND_COMP")}` });
    expect((await buildFinalReport(world.db, runId)).complete).toBe(true);
    await world.db.claims.updateOne({ _id: `${runId}:C01` }, { $set: { status: "EXTRACTED" } }); // an unadjudicated claim blocks completion
    expect((await buildFinalReport(world.db, runId)).complete).toBe(false);
    await world.db.claims.updateOne({ _id: `${runId}:C01` }, { $set: { status: "RESOLVED" } });

    // rewrite: file and execution_runs.final_report agree, status untouched
    const rewritten = await rewriteReport(world.db, runId, join(root, "out", "reports"));
    expect(JSON.parse(readFileSync(join(root, "out", "reports", `${runId}.final-report.json`), "utf8"))).toEqual(JSON.parse(JSON.stringify(rewritten)));
    expect((await world.db.runs.findOne({ _id: runId }))?.final_report).toEqual(JSON.parse(JSON.stringify(rewritten)));
  });

  it("lists a goodwill obligation with no intent and a BUDGET_REFUSED event under awaiting_budget, and nothing else", async () => {
    const { runId } = await seedRun(world.db, "S1");
    await runArm({ runId, pauseBeforePayout: false }, depsFor(world, runId, mkdtempSync(join(tmpdir(), "nt-report-"))));
    const r = await buildFinalReport(world.db, runId);
    const awaiting = r.awaiting_budget.map((a) => a.effect_key);
    expect(awaiting).toHaveLength(2);
    for (const k of awaiting) expect(await world.db.intents.countDocuments({ _id: `${runId}:${k}` })).toBe(0);
    expect(await world.db.audit.countDocuments({ run_id: runId, type: "BUDGET_REFUSED" })).toBe(2);
    expect(r.unresolved).toEqual([]);
  });
});
