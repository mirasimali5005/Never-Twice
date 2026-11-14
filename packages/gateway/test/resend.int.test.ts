// B3-INT-05: recordLicence before any byte, same key and bytes, applyResendResult paths, backoff, budget and key window.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Intent } from "@nt/contracts";
import { ProgrammerError, acquireLease, applyResendResult, recordLicence, resend } from "../src/index.ts";
import { objectFor } from "./support/fake-provider.ts";
import { unknownFlow } from "./support/flow.ts";
import { startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });

async function leased(o = {}, opts: Parameters<typeof unknownFlow>[2] = {}) {
  const f = await unknownFlow(w, o, opts);
  const a = await acquireLease({ ...f.deps, workerId: "reconciler-1" }, f.id, f.it.lease_epoch);
  if (!a) throw new Error("lease");
  return { ...f, it: a as Intent };
}

describe("licensed re-send", () => {
  it("recordLicence is committed before the provider is called; same bytes, same key; ACCEPTED + MATCH → T6 REDISPATCH", async () => {
    const f = await leased({ entitlement_type: "GOODWILL" });
    const it2 = await recordLicence(f.deps, f.it, "L1_SAME_KEY");
    expect(it2!.attempts).toHaveLength(2);
    expect(it2!.attempts[1]).toMatchObject({ n: 2, licence: "L1_SAME_KEY", request_sha256: f.it.frozen_request_sha256, epoch: 2, result: null });
    let seenDuringCall: unknown;
    f.provider.onCall = async () => { seenDuringCall = (await w.db.intents.findOne({ _id: f.id }))!.attempts[1]; };
    const res = await resend(f.deps, it2!);
    expect(seenDuringCall).toMatchObject({ licence: "L1_SAME_KEY", result: null });
    expect(f.provider.calls).toHaveLength(2);
    expect(f.provider.calls[1]!.req).toEqual(f.provider.calls[0]!.req);
    expect(f.provider.calls[1]!.idempotencyKey).toBe(f.id);
    const done = await applyResendResult(f.deps, it2!, res);
    expect(done).toMatchObject({ state: "CONFIRMED", lease: null, next_attempt_at: null, evidence: { source: "REDISPATCH" } });
    expect(done!.attempts[1]!.result).toMatchObject({ kind: "ACCEPTED" });
    expect(await w.db.grants.findOne({ _id: `${f.run}:GOODWILL` })).toMatchObject({ held_minor: 0, settled_minor: 15000 });
    expect(await w.db.audit.countDocuments({ intent_id: f.id, type: "LICENCE_GRANTED" })).toBe(1);
  });

  it("REJECTED_DEFINITIVE → T7 (goodwill returned); CONTRADICTION → T9; ACCEPTED without a match → T9", async () => {
    const a = await leased({ entitlement_type: "GOODWILL" });
    const a2 = (await recordLicence(a.deps, a.it, "L1_SAME_KEY"))!;
    expect(await applyResendResult(a.deps, a2, { kind: "REJECTED_DEFINITIVE", code: "X", message: "no", replayed: true })).toMatchObject({ state: "FAILED_NO_EFFECT", rejection: { replayed: true } });
    expect(await w.db.grants.findOne({ _id: `${a.run}:GOODWILL` })).toMatchObject({ held_minor: 0, settled_minor: 0 });
    const b = await leased();
    const b2 = (await recordLicence(b.deps, b.it, "L1_SAME_KEY"))!;
    expect(await applyResendResult(b.deps, b2, { kind: "CONTRADICTION", code: "KEY_REUSED_DIFFERENT_PARAMS", detail: "x" })).toMatchObject({ state: "QUARANTINED", quarantine: { reason: "CONTRADICTORY_EVIDENCE" } });
    const c = await leased();
    const c2 = (await recordLicence(c.deps, c.it, "L1_SAME_KEY"))!;
    const wrong = objectFor(c2.frozen_request, { payee_ref: "payee_OTHER" });
    expect(await applyResendResult(c.deps, c2, { kind: "ACCEPTED", object: wrong, replayed: false })).toMatchObject({ state: "QUARANTINED" });
  });

  it("INDETERMINATE → stays OUTCOME_UNKNOWN, lease cleared, next_attempt_at = now + 2 s after the first re-send", async () => {
    const f = await leased();
    const it2 = (await recordLicence(f.deps, f.it, "L1_SAME_KEY"))!;
    const after = await applyResendResult(f.deps, it2, { kind: "INDETERMINATE", cause: "TIMEOUT", detail: "x" });
    expect(after).toMatchObject({ state: "OUTCOME_UNKNOWN", lease: null });
    const upd = (after as unknown as { updated_at: Date }).updated_at;
    expect(after!.next_attempt_at!.getTime() - upd.getTime()).toBe(2000);
    const ev = await w.db.audit.findOne({ intent_id: f.id, "detail.transition": "T8", type: "TRANSITION" });
    expect(ev).toMatchObject({ from_state: "OUTCOME_UNKNOWN", to_state: "OUTCOME_UNKNOWN", detail: { next_attempt_in_ms: 2000 } });
  });

  it("recordLicence matches nothing after five attempts and after key_expires_at; keyless rail never licensed", async () => {
    const f = await leased();
    const five = [...f.it.attempts, ...[2, 3, 4, 5].map((n) => ({ ...f.it.attempts[0]!, n, licence: "L1_SAME_KEY" as const }))];
    await w.db.intents.updateOne({ _id: f.id }, { $set: { attempts: five } });
    expect(await recordLicence(f.deps, { ...f.it, attempts: five }, "L1_SAME_KEY")).toBeNull();
    const g = await leased();
    await w.db.intents.updateOne({ _id: g.id }, { $set: { key_expires_at: new Date(Date.now() - 1000) } });
    expect(await recordLicence(g.deps, g.it, "L1_SAME_KEY")).toBeNull();
    const k = await leased({ rail: "legacy" });
    expect(await recordLicence(k.deps, k.it, "L1_SAME_KEY")).toBeNull();
    expect(k.provider.calls).toHaveLength(1);
  });

  it("resend refuses without an unused licence; { unlicensed } only under M3; M4 sends a changed amount", async () => {
    const f = await leased();
    await expect(resend(f.deps, f.it)).rejects.toBeInstanceOf(ProgrammerError);
    await expect(resend(f.deps, f.it, { unlicensed: true })).rejects.toBeInstanceOf(ProgrammerError);
    const m3 = await leased({}, { mutation: "M3" });
    await resend(m3.deps, m3.it, { unlicensed: true });
    expect(m3.provider.calls).toHaveLength(2);
    const m4 = await leased({}, { mutation: "M4" });
    const m42 = (await recordLicence(m4.deps, m4.it, "L1_SAME_KEY"))!;
    await resend(m4.deps, m42);
    expect(m4.provider.calls[1]!.req.amount_minor).toBe(m4.provider.calls[0]!.req.amount_minor + 100);
    expect(m4.provider.calls[1]!.idempotencyKey).toBe(m4.id);
  });
});
