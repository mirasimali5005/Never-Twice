import { describe, expect, it } from "vitest";
import type { Intent, Obligation } from "@nt/contracts";
import { letterEffectKey, payoutOrder } from "../src/orchestrator.ts";
import { deriveReport } from "../src/final-report.ts";

const day = 86_400_000;
const base = new Date("2026-11-11T00:00:00Z");
function ob(pax: string, type: Obligation["entitlement_type"], due: number | null, claim: string, ref = "REF"): Obligation {
  const effect_key = `${ref}.${pax}.NT101-20261110.${type}`;
  return { _id: `r1234567:${effect_key}`, run_id: "r1234567", effect_key, booking_ref: ref, passenger_id: pax, disruption_id: "NT101-20261110", entitlement_type: type, status: "OWED", amount_minor: 100, currency: "CAD", payee_ref: `payee_${pax}`, rail: "instant", reason_code: null, rule_citation: "c", policy_version: "p", due_by: due === null ? null : new Date(base.getTime() + due), claim_ids: [claim], decided_at: base } as Obligation;
}

describe("payoutOrder (E4-UNIT-03)", () => {
  const received = new Map([["C1", new Date("2026-11-11T09:00:00Z")], ["C2", new Date("2026-11-11T10:00:00Z")], ["C3", new Date("2026-11-11T13:15:00Z")]]);

  it("orders by due_by, then received_at, then statutory before goodwill of the same passenger, then effect_key", () => {
    const owed = [
      ob("P05", "GOODWILL", 30 * day, "C3", "RW6N1K"),
      ob("P06", "APPR_DELAY", 30 * day, "C3", "RW6N1K"),
      ob("P05", "APPR_DELAY", 30 * day, "C3", "RW6N1K"),
      ob("P02", "APPR_DELAY", 30 * day, "C2", "ZT4H9X"),
      ob("P10", "APPR_DENIED_BOARDING", 2 * day, "C3", "GT8K4S"),
      ob("P13", "APPR_DELAY", 30 * day, "C1", "KS2R9B"),
    ];
    expect(payoutOrder(owed, received).map((o) => `${o.passenger_id}:${o.entitlement_type}`)).toEqual([
      "P10:APPR_DENIED_BOARDING",
      "P13:APPR_DELAY",
      "P02:APPR_DELAY",
      "P05:APPR_DELAY",
      "P05:GOODWILL", // right after P05's statutory payment, before P06's
      "P06:APPR_DELAY",
    ]);
  });

  it("a null due_by sorts last and the input is not mutated", () => {
    const owed = [ob("P01", "APPR_DELAY", null, "C1", "A"), ob("P02", "APPR_DELAY", day, "C3", "B")];
    expect(payoutOrder(owed, received).map((o) => o.passenger_id)).toEqual(["P02", "P01"]);
    expect(owed[0]?.passenger_id).toBe("P01");
  });
});

describe("deriveReport mapping (E4-UNIT-05, E4-UNIT-06)", () => {
  const run = { _id: "r1234567", group_id: "g1234567", arm: "nt" as const, scenario: "S1" as const };
  const none = { run, claims: [], obligations: [], intents: [], budgetRefusedKeys: new Set<string>(), generatedAt: "2026-11-14T00:00:00.000Z" };

  it("CP-REV-1: a CONFIRMED intent with a PROVIDER_REVERSAL event is parked (PROVIDER_REVERSAL), never paid", () => {
    const owed = ob("P02", "APPR_DELAY", day, "C1");
    const intent = {
      _id: `r1234567:${owed.effect_key}`, run_id: "r1234567", effect_key: owed.effect_key, state: "CONFIRMED", amount_minor: owed.amount_minor,
      currency: "CAD", payee_ref: owed.payee_ref, provider: "sim_payout", evidence: { provider_object_id: "po_1" },
    } as unknown as Intent;
    const claims = [{ claim_id: "C1", status: "RESOLVED", hold_reason: null, effect_keys: [owed.effect_key] }];
    expect(deriveReport({ ...none, obligations: [owed], intents: [intent], claims }).paid).toHaveLength(1);
    const r = deriveReport({ ...none, obligations: [owed], intents: [intent], claims, reversedIntentIds: new Set([intent._id]) });
    expect(r.paid).toEqual([]);
    expect(r.parked).toEqual([{ effect_key: owed.effect_key, claim_id: null, reason_code: "PROVIDER_REVERSAL", amount_minor: owed.amount_minor }]);
    expect(r.complete).toBe(true);
  });

  it("an empty run is complete and carries group_id", () => {
    expect(deriveReport(none)).toMatchObject({ group_id: "g1234567", run_id: "r1234567", complete: true, paid: [], parked: [], unresolved: [] });
  });

  it("a claim that is not adjudicated yet blocks completion and appears in no list", () => {
    const r = deriveReport({ ...none, claims: [{ claim_id: "C1", status: "EXTRACTED", hold_reason: null, effect_keys: [] }] });
    expect(r.complete).toBe(false);
    expect(Object.values(r).flat().length).toBeGreaterThan(0);
    expect(r.parked).toEqual([]);
  });

  it("an owed obligation with no intent is unresolved NO_INTENT; a refusal is listed with its citation", () => {
    const owed = ob("P02", "APPR_DELAY", day, "C1");
    const refused = { ...ob("P04", "APPR_DELAY", day, "C1"), status: "NOT_OWED", reason_code: "DELAY_UNDER_3H", amount_minor: 0 } as Obligation;
    const r = deriveReport({ ...none, obligations: [owed, refused], claims: [{ claim_id: "C1", status: "RESOLVED", hold_reason: null, effect_keys: [owed.effect_key, refused.effect_key] }] });
    expect(r.unresolved).toEqual([{ effect_key: owed.effect_key, state: "NO_INTENT" }]);
    expect(r.refused).toEqual([{ effect_key: refused.effect_key, reason_code: "DELAY_UNDER_3H", rule_citation: "c" }]);
    expect(r.complete).toBe(false);
  });
});

describe("decision letters in the final report (CP-LETTER-1)", () => {
  const run = { _id: "r1234567", group_id: "g1234567", arm: "nt" as const, scenario: "S0" as const };
  const none = { run, claims: [], obligations: [], intents: [], budgetRefusedKeys: new Set<string>(), generatedAt: "2026-11-14T00:00:00.000Z" };
  const letter = (claim: string) => ({ ...ob("P02", "DECISION_LETTER", null, claim), effect_key: letterEffectKey(claim), _id: `r1234567:${letterEffectKey(claim)}`, amount_minor: 0 }) as Obligation;

  it("letterEffectKey is a valid effect key per claim", () => {
    expect(letterEffectKey("C02")).toBe("LETTER.C02");
    expect(letterEffectKey("c-7/x")).toBe("LETTER.C-7_X");
  });

  it("letters are never in paid/refused/parked/unresolved and never block completion; they are listed in `letters` with their state", () => {
    const l2 = letter("C02");
    const l3 = letter("C03");
    const confirmed = {
      _id: l2._id, effect_key: l2.effect_key, entitlement_type: "DECISION_LETTER", state: "CONFIRMED", amount_minor: 0, currency: "CAD", payee_ref: "payee_P02", provider: "notify_letter",
      evidence: { source: "PROBE", provider_object_id: "msg_1", status: "sent", amount_minor: 0, currency: "CAD", payee_ref: "payee_P02", marker: l2._id, retrieved_at: new Date() }, quarantine: null,
    } as never;
    const quarantined = { _id: l3._id, effect_key: l3.effect_key, entitlement_type: "DECISION_LETTER", state: "QUARANTINED", evidence: null, quarantine: { reason: "NO_DEDUPE_NO_EVIDENCE", detail: "", at: new Date() } } as never;
    const r = deriveReport({ ...none, obligations: [l2, l3], intents: [confirmed, quarantined] });
    expect(r.paid).toEqual([]);
    expect(r.parked).toEqual([]);
    expect(r.unresolved).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.letters).toEqual([
      { effect_key: "LETTER.C02", claim_id: "C02", marker: l2._id, payee_ref: "payee_P02", state: "CONFIRMED", provider_object_id: "msg_1", quarantine_reason: null },
      { effect_key: "LETTER.C03", claim_id: "C03", marker: l3._id, payee_ref: "payee_P02", state: "QUARANTINED", provider_object_id: null, quarantine_reason: "NO_DEDUPE_NO_EVIDENCE" },
    ]);
  });

  it("a run without letters has no `letters` field (reports with NT_LETTERS_ENABLED=false are unchanged)", () => {
    expect("letters" in deriveReport(none)).toBe(false);
  });
});
