// EU261 rule pack: jurisdiction is data. Band boundaries, the 50% reduction, the extraordinary-circumstances exemption, the
// Sturgeon 3 h threshold, and the proof that the APPR path is untouched (Tier 3).
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Booking, BookingPassenger, Disruption, RegimeFact } from "@nt/contracts";
import { type ComputeInput, RulesError, computeObligations, loadPolicyBundle, lookupRegimeBand, EU261_POLICY_ID, PolicyError } from "../src/index.ts";
import { FIXTURES_DIR, NO_FLAGS, POLICY, RECEIVED, makeBooking } from "./helpers.ts";

const EU_POLICY = loadPolicyBundle(resolve(FIXTURES_DIR, "policies"), undefined, [EU261_POLICY_ID]);
const BANDS = EU_POLICY.regimes!["EU"]!.compensation.bands;

type Opts = {
  km: number;
  intra: boolean;
  kind?: Disruption["kind"];
  delay?: number | null;
  notice?: number | null;
  control?: Disruption["control_class"];
  rerouted?: boolean;
  denied?: boolean;
  passenger?: Partial<BookingPassenger>;
};

function eu(o: Opts): Booking {
  const pfacts: Record<string, RegimeFact> = o.rerouted === undefined ? {} : { rerouted_art8: o.rerouted };
  return makeBooking({
    passenger: { arrival_delay_minutes: o.delay === undefined ? 200 : o.delay, denied_boarding: o.denied ?? false, facts: pfacts, ...o.passenger },
    disruption: {
      disruption_id: "NT900-20261110",
      jurisdiction: "EU",
      kind: o.kind ?? "DELAY",
      facts: { distance_km: o.km, intra_union: o.intra },
      notice_minutes_before_departure: o.notice === undefined ? null : o.notice,
      control_class: o.control ?? "WITHIN_CONTROL",
    },
  });
}
const run = (b: Booking, flags: ComputeInput["flags"] = NO_FLAGS) =>
  computeObligations({ booking: b, passenger: b.passenger, disruption: b.disruption, claimReceivedAt: RECEIVED, flags, policy: EU_POLICY });
const amount = (o: Opts): number => run(eu(o))[0]!.amount_minor;

describe("EU261 distance bands (Art. 7(1))", () => {
  it("1500 km or less: 250 EUR, boundary 1500 inclusive", () => {
    expect(amount({ km: 1, intra: true })).toBe(25000);
    expect(amount({ km: 1500, intra: true })).toBe(25000);
    expect(amount({ km: 1500, intra: false })).toBe(25000);
  });
  it("intra-EU over 1500 km: 400 EUR at any larger distance", () => {
    expect(amount({ km: 1501, intra: true })).toBe(40000);
    expect(amount({ km: 3501, intra: true })).toBe(40000);
    expect(amount({ km: 9000, intra: true })).toBe(40000);
  });
  it("other flights 1500 to 3500 km: 400 EUR; 3500 inclusive (assumption A2); over 3500: 600 EUR", () => {
    expect(amount({ km: 1501, intra: false })).toBe(40000);
    expect(amount({ km: 3500, intra: false })).toBe(40000);
    expect(amount({ km: 3501, intra: false })).toBe(60000);
    expect(amount({ km: 5837, intra: false })).toBe(60000);
  });
  it("amounts, currency, citation, policy version and no due date come from the document", () => {
    const o = run(eu({ km: 5837, intra: false }))[0]!;
    expect(o).toMatchObject({ status: "OWED", currency: "EUR", entitlement_type: "EU261_COMPENSATION", policy_version: EU261_POLICY_ID, due_by: null });
    expect(o.rule_citation).toBe("Art. 7(1)(c); reduction ceiling Art. 7(2)(c)");
    expect(o.effect_key.endsWith(".EU261_COMPENSATION")).toBe(true);
  });
  it("lookup returns null when no band matches, and respects the `when` filter", () => {
    expect(lookupRegimeBand(BANDS, 2000, { intra_union: "yes" })).toBeNull();
    expect(lookupRegimeBand(BANDS, 2000, { intra_union: true })?.id).toBe("B_INTRA_UNION_OVER_1500");
    expect(lookupRegimeBand(BANDS, 2000, { intra_union: false })?.id).toBe("B_OTHER_1500_TO_3500");
  });
  it("a record without the distance fact is refused, never guessed", () => {
    const b = makeBooking({ disruption: { disruption_id: "NT900-20261110", jurisdiction: "EU", facts: { intra_union: true } } });
    expect(() => run(b)).toThrow(RulesError);
  });
});

describe("EU261 arrival-delay threshold for delays (Sturgeon, 3 h)", () => {
  it("179 minutes: NOT_OWED DELAY_UNDER_3H; 180: owed", () => {
    const under = run(eu({ km: 1000, intra: true, delay: 179 }))[0]!;
    expect(under).toMatchObject({ status: "NOT_OWED", reason_code: "DELAY_UNDER_3H", amount_minor: 0, currency: "EUR" });
    expect(amount({ km: 1000, intra: true, delay: 180 })).toBe(25000);
  });
  it("a cancellation and a denied boarding have no delay condition", () => {
    expect(run(eu({ km: 1000, intra: true, kind: "CANCELLATION", delay: 30 }))[0]!.amount_minor).toBe(25000);
    expect(run(eu({ km: 1000, intra: true, denied: true, delay: 0 }))[0]!.amount_minor).toBe(25000);
  });
  it("a delay with no recorded arrival delay is an error", () => {
    expect(() => run(eu({ km: 1000, intra: true, delay: null }))).toThrow(RulesError);
  });
});

describe("EU261 50% reduction (Art. 7(2))", () => {
  const cases: [string, number, boolean, number, number][] = [
    // label, km, intra, ceiling minutes, full amount
    ["band (a) 2 h", 1200, true, 120, 25000],
    ["band (b) intra 3 h", 2000, true, 180, 40000],
    ["band (b) other 3 h", 3000, false, 180, 40000],
    ["band (c) 4 h", 6000, false, 240, 60000],
  ];
  for (const [label, km, intra, ceil, full] of cases) {
    it(`${label}: halved at the ceiling, full one minute later, full when not re-routed`, () => {
      const base = { km, intra, kind: "CANCELLATION" as const };
      expect(amount({ ...base, delay: ceil, rerouted: true })).toBe(full / 2);
      expect(amount({ ...base, delay: ceil - 1, rerouted: true })).toBe(full / 2);
      expect(amount({ ...base, delay: ceil + 1, rerouted: true })).toBe(full);
      expect(amount({ ...base, delay: ceil, rerouted: false })).toBe(full);
      expect(amount({ ...base, delay: ceil })).toBe(full);
    });
  }
  it("the reduced decision cites Art. 7(2)", () => {
    expect(run(eu({ km: 6000, intra: false, kind: "CANCELLATION", delay: 200, rerouted: true }))[0]!.rule_citation).toContain("Art. 7(2)");
  });
});

describe("EU261 cancellation notice (Art. 5(1)(c)(i))", () => {
  it("14 days or more: NOT_OWED NOTICE_OVER_14_DAYS; one minute less: owed", () => {
    expect(run(eu({ km: 1000, intra: true, kind: "CANCELLATION", notice: 20160 }))[0]).toMatchObject({ status: "NOT_OWED", reason_code: "NOTICE_OVER_14_DAYS" });
    expect(run(eu({ km: 1000, intra: true, kind: "CANCELLATION", notice: 20159 }))[0]!.status).toBe("OWED");
  });
  it("the notice rule does not apply to a delay", () => {
    expect(run(eu({ km: 1000, intra: true, kind: "DELAY", notice: 99999, delay: 200 }))[0]!.status).toBe("OWED");
  });
});

describe("EU261 extraordinary circumstances (Art. 5(3))", () => {
  it("OUTSIDE_CONTROL refuses a delay and a cancellation with a citation", () => {
    const d = run(eu({ km: 6000, intra: false, control: "OUTSIDE_CONTROL", delay: 400 }))[0]!;
    expect(d).toMatchObject({ status: "NOT_OWED", reason_code: "OUTSIDE_CARRIER_CONTROL", amount_minor: 0 });
    expect(d.rule_citation).toContain("Art. 5(3)");
    expect(run(eu({ km: 6000, intra: false, kind: "CANCELLATION", control: "OUTSIDE_CONTROL" }))[0]!.status).toBe("NOT_OWED");
  });
  it("denied boarding is not exempted by extraordinary circumstances (Art. 4(3) has no such defence)", () => {
    expect(run(eu({ km: 1000, intra: true, denied: true, delay: 0, control: "OUTSIDE_CONTROL" }))[0]!.status).toBe("OWED");
  });
  it("an undetermined cause is held, after the delay threshold and other-regime rows", () => {
    expect(run(eu({ km: 1000, intra: true, control: "UNDETERMINED" }))[0]).toMatchObject({ status: "HELD", reason_code: "CAUSE_UNDETERMINED" });
    expect(run(eu({ km: 1000, intra: true, control: "UNDETERMINED", delay: 100 }))[0]!.reason_code).toBe("DELAY_UNDER_3H");
  });
});

describe("EU261 other rows and fail-closed behaviour", () => {
  it("payee change is held; goodwill is not defined for the regime", () => {
    const b = eu({ km: 1000, intra: true });
    expect(run(b, { payeeChangeRequested: true, goodwillProposed: null })[0]).toMatchObject({ status: "HELD", reason_code: "PAYEE_CHANGE_REQUESTED" });
    const g = run(b, { payeeChangeRequested: false, goodwillProposed: "OVERNIGHT_STRANDED" });
    expect(g.map((x) => [x.entitlement_type, x.status, x.reason_code])).toEqual([["EU261_COMPENSATION", "OWED", null], ["GOODWILL", "NOT_OWED", "NOT_GOODWILL_ELIGIBLE"]]);
  });
  it("a record that sets a field the table does not model is refused", () => {
    expect(() => run(eu({ km: 1000, intra: true, passenger: { refund_elected: true } }))).toThrow(RulesError);
  });
  it("an unknown jurisdiction, or a bundle without the pack, is refused (never silently APPR)", () => {
    const b = eu({ km: 1000, intra: true });
    expect(() => computeObligations({ booking: b, passenger: b.passenger, disruption: b.disruption, claimReceivedAt: RECEIVED, flags: NO_FLAGS, policy: POLICY })).toThrow(RulesError);
  });
  it("loader rejects an unknown regime version", () => {
    expect(() => loadPolicyBundle(resolve(FIXTURES_DIR, "policies"), undefined, ["EU261-2004@2099-01-01"])).toThrow(PolicyError);
  });
});

describe("APPR is unchanged", () => {
  it("a record without a jurisdiction is computed by the APPR table in the same bundle, in CAD", () => {
    const b = makeBooking({ passenger: { arrival_delay_minutes: 370 } });
    for (const policy of [POLICY, EU_POLICY]) {
      const [o] = computeObligations({ booking: b, passenger: b.passenger, disruption: b.disruption, claimReceivedAt: RECEIVED, flags: NO_FLAGS, policy });
      expect(o).toMatchObject({ status: "OWED", amount_minor: 70000, currency: "CAD", entitlement_type: "APPR_DELAY", policy_version: "APPR-SOR-2019-150@2022-09-08" });
    }
  });
});
