// B3-INT-07 (invariant scan) and B3-INT-03 (settle refusal, T12 watcher).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProgrammerError, confirmQuarantined, dispatch, propose, quarantine, scanInvariants, settle } from "../src/index.ts";
import { objectFor } from "./support/fake-provider.ts";
import { reservedFlow, unknownFlow } from "./support/flow.ts";
import { depsFor, obligation, proposalFor, startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });

describe("scanInvariants", () => {
  it("a clean run scans green (confirmed, unknown, failed, goodwill)", async () => {
    const a = await reservedFlow(w, ["ACCEPT", { kind: "REJECTED_DEFINITIVE", code: "X", message: "x", replayed: false }], { entitlement_type: "GOODWILL" });
    await dispatch(a.deps, a.id);
    const b = await reservedFlow(w, [], {}, { run: a.run });
    a.provider.script.push({ kind: "REJECTED_DEFINITIVE", code: "X", message: "x", replayed: false });
    await dispatch({ ...a.deps }, b.id);
    await unknownFlow(w, {}, { run: a.run });
    const r = await scanInvariants(a.deps, a.run);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("M5 second intent → P1; counter drift → P2; missing audit event → P9; CONFIRMED without evidence → P3", async () => {
    const f = await reservedFlow(w, [], { entitlement_type: "GOODWILL" }, { mutation: "M5" });
    await propose(f.deps, proposalFor(f.ob)); // second intent for the same key under M5
    await w.db.grants.updateOne({ _id: `${f.run}:GOODWILL` }, { $inc: { held_minor: 1 } });
    await w.db.audit.deleteOne({ intent_id: f.id, type: "INTENT_RESERVED" });
    const g = await reservedFlow(w, [], {}, { run: f.run });
    await w.db.intents.updateOne({ _id: g.id }, { $set: { state: "CONFIRMED" } });
    const codes = (await scanInvariants(f.deps, f.run)).violations.map((v) => v.code);
    expect(codes).toContain("P1_MULTIPLE_INTENTS_PER_KEY");
    expect(codes).toContain("P2_COUNTER_DRIFT");
    expect(codes).toContain("P9_REPLAY_MISMATCH");
    expect(codes).toContain("P3_CONFIRMED_WITHOUT_EVIDENCE");
  });

  it("a provider object with the run's id and no intent → UNMATCHED_PROVIDER_OBJECT and one ANOMALY event, read via listOperations only", async () => {
    const f = await reservedFlow(w, ["ACCEPT"]);
    await dispatch(f.deps, f.id);
    const stray = objectFor({ ...f.provider.calls[0]!.req, metadata: { ...f.provider.calls[0]!.req.metadata, nt_marker: `${f.run}:STRAY` } });
    f.provider.ledger.push(stray);
    const r1 = await scanInvariants(f.deps, f.run);
    const r2 = await scanInvariants(f.deps, f.run);
    expect(r1.violations.map((v) => v.code)).toEqual(["UNMATCHED_PROVIDER_OBJECT"]);
    expect(r2.ok).toBe(false);
    expect(await w.db.audit.countDocuments({ run_id: f.run, type: "ANOMALY", "detail.provider_object_id": stray.id })).toBe(1);
  });
});

describe("settle and the watcher", () => {
  it("settle refuses an object matchEvidence does not accept", async () => {
    const f = await unknownFlow(w);
    await expect(settle(f.deps, f.it, { source: "PROBE", object: objectFor(f.it.frozen_request, { amount_minor: 1 }) })).rejects.toBeInstanceOf(ProgrammerError);
  });

  it("T6 from a probe keeps attempts unchanged; T12 only for absence-class reasons, quarantine kept, goodwill settled", async () => {
    const p = await unknownFlow(w);
    const t6 = await settle(p.deps, p.it, { source: "PROBE", object: objectFor(p.it.frozen_request) });
    expect(t6).toMatchObject({ state: "CONFIRMED", evidence: { source: "PROBE" } });
    expect(t6!.attempts).toEqual(p.it.attempts);

    const a = await unknownFlow(w, { entitlement_type: "GOODWILL" });
    const qa = (await quarantine(a.deps, a.it, "NO_DEDUPE_NO_EVIDENCE", "nothing found"))!;
    const c = await confirmQuarantined(a.deps, qa, objectFor(qa.frozen_request));
    expect(c).toMatchObject({ state: "CONFIRMED", quarantine: { reason: "NO_DEDUPE_NO_EVIDENCE" }, evidence: { source: "PROBE" } });
    expect(await w.db.grants.findOne({ _id: `${a.run}:GOODWILL` })).toMatchObject({ held_minor: 0, settled_minor: 15000 });

    const b = await unknownFlow(w);
    const qb = (await quarantine(b.deps, b.it, "CONTRADICTORY_EVIDENCE", "x"))!;
    expect(await confirmQuarantined(b.deps, qb, objectFor(qb.frozen_request))).toBeNull();
  });

  it("an adversarial run id mismatch is refused before any write", async () => {
    const f = await reservedFlow(w);
    const other = obligation(f.run);
    await expect(propose(depsFor(w.db, "rzzzzzzz"), proposalFor(other))).rejects.toThrow(/run/);
  });
});
