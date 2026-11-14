// D1-UNIT-01: every branch of the frozen matcher (HANDOVER.md §11.2; ERRATA 13, 40).
import { ACCEPTED_STATUSES as CONTRACT_ACCEPTED, PROVIDER_IDS, type ProviderId, type ProviderObject } from "@nt/contracts";
import { describe, expect, it } from "vitest";
import { ACCEPTED_STATUSES, matchEvidence } from "../src/pure/index.ts";
import { deepFreeze, makeIntent, objectFor } from "./support/fixtures.ts";

const other = (it: ReturnType<typeof makeIntent>, marker: string, over: Partial<ProviderObject> = {}) =>
  objectFor(it, { id: `po_other_${marker}`, metadata: { nt_marker: marker }, ...over });

describe("matchEvidence: ACCEPTED_STATUSES", () => {
  it("is the contracts constant, not a redefinition", () => {
    expect(ACCEPTED_STATUSES).toBe(CONTRACT_ACCEPTED);
    expect([...ACCEPTED_STATUSES.sim_payout]).toEqual(["paid"]);
    expect([...ACCEPTED_STATUSES.sim_keyless]).toEqual(["paid"]);
    expect([...ACCEPTED_STATUSES.stripe_refund].sort()).toEqual(["pending", "succeeded"]);
  });
});

describe.each(PROVIDER_IDS)("matchEvidence on %s", (provider: ProviderId) => {
  const intent = makeIntent(provider);

  it("zero records → NO_MATCH", () => {
    expect(matchEvidence(intent, [])).toEqual({ kind: "NO_MATCH" });
  });

  it("only other markers → NO_MATCH", () => {
    const recs = [other(intent, "r7k2m9qa:OTHER.KEY"), other(intent, `${intent._id}x`), other(intent, intent._id.slice(0, -1)), other(intent, ` ${intent._id}`), other(intent, intent._id.toLowerCase() === intent._id ? intent._id.toUpperCase() : intent._id.toLowerCase())];
    expect(matchEvidence(intent, recs)).toEqual({ kind: "NO_MATCH" });
  });

  it("the marker on a different field is ignored → NO_MATCH", () => {
    const recs: ProviderObject[] = [
      objectFor(intent, { id: intent._id, metadata: {} }),
      objectFor(intent, { metadata: { nt_effect_key: intent._id } }),
      objectFor(intent, { metadata: { marker: intent._id, NT_MARKER: intent._id, "nt_marker ": intent._id } }),
      objectFor(intent, { payee_ref: intent._id, metadata: { nt_run_id: intent._id } }),
      objectFor(intent, { parent_ref: intent._id, metadata: {} }),
      { ...objectFor(intent, { metadata: {} }), nt_marker: intent._id } as ProviderObject,
    ];
    expect(matchEvidence(intent, recs)).toEqual({ kind: "NO_MATCH" });
  });

  it("missing or null metadata, and null records, are not hits", () => {
    const noMeta = { ...objectFor(intent) } as Partial<ProviderObject>;
    delete noMeta.metadata;
    const nullMeta = { ...objectFor(intent), metadata: null } as unknown as ProviderObject;
    expect(matchEvidence(intent, [noMeta as ProviderObject, nullMeta, null as unknown as ProviderObject])).toEqual({ kind: "NO_MATCH" });
  });

  it("one exact match → MATCH carrying that object", () => {
    const obj = objectFor(intent);
    const r = matchEvidence(intent, [other(intent, "r7k2m9qa:A"), obj, other(intent, "r7k2m9qa:B")]);
    expect(r).toEqual({ kind: "MATCH", object: obj });
    expect(r.kind === "MATCH" && r.object).toBe(obj);
  });

  it("each accepted status for this provider matches", () => {
    for (const status of ACCEPTED_STATUSES[provider]) {
      expect(matchEvidence(intent, [objectFor(intent, { status })]).kind).toBe("MATCH");
    }
  });

  it("two hits → CONTRADICTION MULTIPLE_OBJECTS (even if identical, even if one is a mismatch)", () => {
    const a = objectFor(intent);
    expect(matchEvidence(intent, [a, objectFor(intent, { id: "po_second" })])).toEqual({ kind: "CONTRADICTION", why: "MULTIPLE_OBJECTS" });
    expect(matchEvidence(intent, [a, a])).toEqual({ kind: "CONTRADICTION", why: "MULTIPLE_OBJECTS" });
    expect(matchEvidence(intent, [a, objectFor(intent, { id: "x", amount_minor: 1 })])).toEqual({ kind: "CONTRADICTION", why: "MULTIPLE_OBJECTS" });
    expect(matchEvidence(intent, [a, a, a])).toEqual({ kind: "CONTRADICTION", why: "MULTIPLE_OBJECTS" });
  });

  it.each([
    ["amount higher", { amount_minor: 100000 }],
    ["amount lower", { amount_minor: 69999 }],
    // a letter's amount is 0, so for notify_letter "amount zero" would match: use 1 there (still a mismatch)
    ["amount zero (1 on a letter)", { amount_minor: provider === "notify_letter" ? 1 : 0 }],
    ["currency USD", { currency: "USD" }],
    ["currency lower-case cad", { currency: "cad" }],
    ["payee differs", { payee_ref: "payee_P14" }],
    ["payee empty", { payee_ref: "" }],
  ] as [string, Partial<ProviderObject>][])("field mismatch: %s → CONTRADICTION FIELD_MISMATCH", (_n, over) => {
    expect(matchEvidence(intent, [objectFor(intent, over)])).toEqual({ kind: "CONTRADICTION", why: "FIELD_MISMATCH" });
  });

  it("a field mismatch is reported before a bad status", () => {
    expect(matchEvidence(intent, [objectFor(intent, { amount_minor: 1, status: "failed" })])).toEqual({ kind: "CONTRADICTION", why: "FIELD_MISMATCH" });
  });

  it("does not mutate its inputs", () => {
    const it2 = deepFreeze(makeIntent(provider));
    const recs = deepFreeze([objectFor(it2), other(it2, "r7k2m9qa:Z")]);
    expect(() => matchEvidence(it2, recs)).not.toThrow();
    expect(matchEvidence(it2, recs)).toEqual(matchEvidence(it2, recs));
  });
});

describe("matchEvidence: wrong status per provider → CONTRADICTION STATUS_<status>", () => {
  const cases: [ProviderId, string][] = [
    ["sim_payout", "pending"],
    ["sim_payout", "failed"],
    ["sim_payout", "succeeded"],
    ["sim_payout", "PAID"],
    ["sim_payout", ""],
    ["sim_keyless", "pending"],
    ["sim_keyless", "succeeded"],
    ["sim_keyless", "failed"],
    ["stripe_refund", "paid"],
    ["stripe_refund", "failed"],
    ["stripe_refund", "canceled"],
    ["stripe_refund", "requires_action"],
    ["stripe_refund", "Succeeded"],
  ];
  it.each(cases)("%s with status %j", (provider, status) => {
    const intent = makeIntent(provider);
    expect(matchEvidence(intent, [objectFor(intent, { status })])).toEqual({ kind: "CONTRADICTION", why: `STATUS_${status}` });
  });
});

describe("matchEvidence: stripe_refund parent_ref rule (ERRATA 40)", () => {
  const intent = makeIntent("stripe_refund");

  it("equal parent_ref matches", () => {
    expect(matchEvidence(intent, [objectFor(intent, { parent_ref: "pi_test_parent_1" })]).kind).toBe("MATCH");
  });

  it.each([["pi_test_parent_2"], [null], [""]])("parent_ref %j differs → CONTRADICTION FIELD_MISMATCH (contracts has no PARENT_MISMATCH)", (parent_ref) => {
    expect(matchEvidence(intent, [objectFor(intent, { parent_ref })])).toEqual({ kind: "CONTRADICTION", why: "FIELD_MISMATCH" });
  });

  it("parent mismatch is reported before a bad status", () => {
    expect(matchEvidence(intent, [objectFor(intent, { parent_ref: "pi_x", status: "failed" })])).toEqual({ kind: "CONTRADICTION", why: "FIELD_MISMATCH" });
  });

  it("the parent_ref rule does not apply to the simulator providers", () => {
    for (const p of ["sim_payout", "sim_keyless"] as const) {
      const sim = makeIntent(p);
      expect(matchEvidence(sim, [objectFor(sim, { parent_ref: "pi_anything" })]).kind).toBe("MATCH");
    }
  });
});
