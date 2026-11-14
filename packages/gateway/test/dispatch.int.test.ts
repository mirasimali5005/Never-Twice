// B3-INT-02 (dispatch with the fake provider) and the T2 part of B3-INT-01. TEST_PLAN AUT-08 (settlement moves held to settled).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Obligation } from "@nt/contracts";
import { dbNow } from "@nt/db";
import { keyExpiresAt } from "@nt/recovery/pure";
import { dispatch, propose } from "../src/index.ts";
import { fakeProvider, objectFor, type FakeProvider, type Step } from "./support/fake-provider.ts";
import { depsFor, freshRun, obligation, proposalFor, seedGrant, startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });

async function reserved(script: Step[], o: Partial<Obligation> = {}, opts: { mutation?: string } = {}) {
  const run = freshRun();
  await seedGrant(w.db, run);
  const fp: Record<string, FakeProvider> = {
    sim_payout: fakeProvider("sim_payout", {}, script),
    sim_keyless: fakeProvider("sim_keyless", {}, script),
    stripe_refund: fakeProvider("stripe_refund", {}, script),
  };
  const barriers: string[] = [];
  const deps = depsFor(w.db, run, { providers: fp, barriers, ...opts });
  const ob = obligation(run, o);
  await w.db.obligations.insertOne(ob);
  const r = await propose(deps, proposalFor(ob));
  if (r.kind !== "RESERVED") throw new Error("setup: not reserved");
  return { run, deps, ob, id: r.intent._id, fp, barriers, provider: fp[r.intent.provider]! };
}
const grant = (run: string) => w.db.grants.findOne({ _id: `${run}:GOODWILL` });
const transitions = async (run: string) =>
  (await w.db.audit.find({ run_id: run, type: "TRANSITION" }).sort({ _id: 1 }).toArray()).map((e) => `${e.detail["transition"]}:${e.from_state}->${e.to_state}`);

describe("dispatch", () => {
  it("ACCEPTED + MATCH → CONFIRMED (T2 then T3): every T2 field, evidence, one send of the frozen bytes under the marker", async () => {
    const { run, deps, id, provider, barriers } = await reserved(["ACCEPT"]);
    const t0 = await dbNow(w.db);
    const it = await dispatch(deps, id);
    expect(it.state).toBe("CONFIRMED");
    expect(it.lease).toBeNull();
    expect(it.lease_epoch).toBe(1);
    expect(it.first_dispatch_at!.getTime()).toBeGreaterThanOrEqual(t0.getTime() - 1000);
    expect(it.key_expires_at!.getTime()).toBe(keyExpiresAt(it.first_dispatch_at!, provider.capabilities, 60000)!.getTime());
    expect(it.attempts).toHaveLength(1);
    expect(it.attempts[0]).toMatchObject({ n: 1, licence: "FIRST_SEND", request_sha256: it.frozen_request_sha256, epoch: 1,
      result: { kind: "ACCEPTED", replayed: false, provider_object_id: provider.ledger[0]!.id } });
    expect(it.evidence).toMatchObject({ source: "RESPONSE", provider_object_id: provider.ledger[0]!.id, status: "paid", amount_minor: 70000, currency: "CAD", payee_ref: it.payee_ref, marker: id });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.req).toEqual(it.frozen_request);
    expect(provider.calls[0]!.idempotencyKey).toBe(id);
    expect(provider.calls[0]!.timeoutMs).toBe(3000);
    expect(await transitions(run)).toEqual(["T2:RESERVED->DISPATCHING", "T3:DISPATCHING->CONFIRMED"]);
    expect(barriers).toEqual(["BR_RESERVE_BEFORE_COMMIT", "BR_RESERVE_AFTER_COMMIT", "BR_DISPATCH_AFTER_MARK", "BR_DISPATCH_RESPONSE_RECEIVED", "BR_SETTLE_IN_TXN", "BR_SETTLE_AFTER_COMMIT"]);
    // a second dispatch sends nothing
    expect((await dispatch(deps, id)).state).toBe("CONFIRMED");
    expect(provider.calls).toHaveLength(1);
  });

  it("AUT-08: goodwill settlement moves held to settled in the same transaction", async () => {
    const { run, deps, id } = await reserved(["ACCEPT"], { entitlement_type: "GOODWILL" });
    expect(await grant(run)).toMatchObject({ held_minor: 15000, settled_minor: 0 });
    expect((await dispatch(deps, id)).state).toBe("CONFIRMED");
    expect(await grant(run)).toMatchObject({ held_minor: 0, settled_minor: 15000 });
  });

  it("ACCEPTED with a wrong amount → QUARANTINED CONTRADICTORY_EVIDENCE (T13); goodwill stays held", async () => {
    const { run, deps, id } = await reserved([(req) => ({ kind: "ACCEPTED", object: objectFor(req, { amount_minor: 1 }), replayed: false })], { entitlement_type: "GOODWILL" });
    const it = await dispatch(deps, id);
    expect(it).toMatchObject({ state: "QUARANTINED", lease: null, quarantine: { reason: "CONTRADICTORY_EVIDENCE" } });
    expect(it.attempts[0]!.result).toMatchObject({ kind: "ACCEPTED" });
    expect(await grant(run)).toMatchObject({ held_minor: 15000, settled_minor: 0 });
    expect(await transitions(run)).toEqual(["T2:RESERVED->DISPATCHING", "T13:DISPATCHING->QUARANTINED"]);
  });

  it("REJECTED_DEFINITIVE → FAILED_NO_EFFECT (T4); goodwill returned", async () => {
    const { run, deps, id } = await reserved([{ kind: "REJECTED_DEFINITIVE", code: "PAYEE_CLOSED", message: "closed", replayed: false }], { entitlement_type: "GOODWILL" });
    const it = await dispatch(deps, id);
    expect(it).toMatchObject({ state: "FAILED_NO_EFFECT", lease: null, rejection: { code: "PAYEE_CLOSED", message: "closed", replayed: false } });
    expect(it.attempts[0]!.result).toMatchObject({ kind: "REJECTED_DEFINITIVE", code: "PAYEE_CLOSED" });
    expect(await grant(run)).toMatchObject({ held_minor: 0, settled_minor: 0 });
  });

  it("INDETERMINATE → OUTCOME_UNKNOWN (T5): same epoch, lease cleared, next_attempt_at = database now, still held", async () => {
    const { run, deps, id } = await reserved([{ kind: "INDETERMINATE", cause: "TIMEOUT", detail: "no response" }], { entitlement_type: "GOODWILL" });
    const t0 = await dbNow(w.db);
    const it = await dispatch(deps, id);
    const t1 = await dbNow(w.db);
    expect(it).toMatchObject({ state: "OUTCOME_UNKNOWN", lease: null, lease_epoch: 1 });
    expect(it.next_attempt_at!.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    expect(it.next_attempt_at!.getTime()).toBeLessThanOrEqual(t1.getTime());
    expect(it.attempts[0]!.result).toMatchObject({ kind: "INDETERMINATE", cause: "TIMEOUT" });
    expect(await grant(run)).toMatchObject({ held_minor: 15000 });
  });

  it("a provider that throws after the mark (e.g. ProviderConfigError) → OUTCOME_UNKNOWN, never stuck, never released", async () => {
    const { deps, id } = await reserved(["THROW"]);
    const it = await dispatch(deps, id);
    expect(it.state).toBe("OUTCOME_UNKNOWN");
    expect(it.attempts[0]!.result).toMatchObject({ kind: "INDETERMINATE", cause: "CONNECTION" });
  });

  it("CONTRADICTION → QUARANTINED (T13)", async () => {
    const { deps, id } = await reserved([{ kind: "CONTRADICTION", code: "KEY_REUSED_DIFFERENT_PARAMS", detail: "x" }]);
    expect(await dispatch(deps, id)).toMatchObject({ state: "QUARANTINED", quarantine: { reason: "CONTRADICTORY_EVIDENCE" } });
  });

  it("a tampered frozen_request sends nothing and is quarantined FROZEN_REQUEST_HASH_MISMATCH", async () => {
    const { deps, id, provider } = await reserved(["ACCEPT"]);
    await w.db.intents.updateOne({ _id: id }, { $set: { "frozen_request.amount_minor": 99999 } });
    const it = await dispatch(deps, id);
    expect(it).toMatchObject({ state: "QUARANTINED", quarantine: { reason: "CONTRADICTORY_EVIDENCE", detail: "FROZEN_REQUEST_HASH_MISMATCH" } });
    expect(provider.calls).toHaveLength(0);
  });

  it("obligation moved to HELD: PAYEE_CHANGE_REQUESTED before dispatch → T11 PAYEE_CHANGED, nothing sent, nothing marked", async () => {
    const { run, deps, id, ob, provider } = await reserved(["ACCEPT"]);
    await w.db.obligations.updateOne({ _id: ob._id }, { $set: { status: "HELD", reason_code: "PAYEE_CHANGE_REQUESTED" } });
    const it = await dispatch(deps, id);
    expect(it).toMatchObject({ state: "QUARANTINED", lease_epoch: 0, quarantine: { reason: "PAYEE_CHANGED" } });
    expect(provider.calls).toHaveLength(0);
    expect(await transitions(run)).toEqual(["T11:RESERVED->QUARANTINED"]);
  });

  it("grant frozen before dispatch → T11 AUTHORITY_REVOKED for a goodwill intent; held unchanged", async () => {
    const { run, deps, id, provider } = await reserved(["ACCEPT"], { entitlement_type: "GOODWILL" });
    await w.db.grants.updateOne({ _id: `${run}:GOODWILL` }, { $set: { frozen: true } });
    expect(await dispatch(deps, id)).toMatchObject({ state: "QUARANTINED", quarantine: { reason: "AUTHORITY_REVOKED" } });
    expect(provider.calls).toHaveLength(0);
    expect(await grant(run)).toMatchObject({ held_minor: 15000 });
  });

  it("two concurrent dispatches of one intent: one mark, one send", async () => {
    const { deps, id, provider } = await reserved(["ACCEPT", "ACCEPT"]);
    const [a, b] = await Promise.all([dispatch(deps, id, "runner-a"), dispatch(deps, id, "runner-b")]);
    expect(provider.calls).toHaveLength(1);
    expect([a.state, b.state].sort()).toContain("CONFIRMED");
    expect((await w.db.intents.findOne({ _id: id }))!.attempts).toHaveLength(1);
  });

  it("keyless rail: no key sent, key_expires_at null", async () => {
    const { deps, id, provider } = await reserved(["ACCEPT"], { rail: "legacy" });
    const it = await dispatch(deps, id);
    expect(it).toMatchObject({ state: "CONFIRMED", idempotency_key: null, key_expires_at: null, provider: "sim_keyless" });
    expect(provider.calls[0]!.idempotencyKey).toBeNull();
  });

  it("M2 (site in markUnknown): an unknown outcome is marked CONFIRMED with provider_object_id MUTANT_NO_EVIDENCE", async () => {
    const { deps, id } = await reserved([{ kind: "INDETERMINATE", cause: "TIMEOUT", detail: "x" }], {}, { mutation: "M2" });
    const it = await dispatch(deps, id);
    expect(it).toMatchObject({ state: "CONFIRMED", evidence: { provider_object_id: "MUTANT_NO_EVIDENCE", marker: id } });
  });
});
