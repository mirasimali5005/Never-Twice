import { cloneDeep } from "./util.ts";
import { describe, expect, it } from "vitest";
import { effectKey } from "@nt/contracts";
import { computeObligations, RulesError } from "../src/index.ts";
import { DEPARTURE, NO_FLAGS, POLICY, RECEIVED, makeBooking } from "./helpers.ts";

type Over = Parameters<typeof makeBooking>[0];
function run(o: Over, flags: { payeeChangeRequested: boolean; goodwillProposed: "OVERNIGHT_STRANDED" | "MOBILITY_ASSIST" | null } = NO_FLAGS, received = RECEIVED) {
  const booking = makeBooking(o);
  return computeObligations({ booking, passenger: booking.passenger, disruption: booking.disruption, claimReceivedAt: received, flags, policy: POLICY });
}
const first = (o: Over, flags?: Parameters<typeof run>[1], received?: Date) => {
  const [ob] = run(o, flags, received);
  if (!ob) throw new Error("no obligation");
  return ob;
};

describe("E2-UNIT-01 delay boundaries (large carrier, within control)", () => {
  const cases: [number, "NOT_OWED" | "OWED", number, string | null][] = [
    [179, "NOT_OWED", 0, "DELAY_UNDER_3H"],
    [180, "OWED", 40000, null],
    [359, "OWED", 40000, null],
    [360, "OWED", 70000, null],
    [539, "OWED", 70000, null],
    [540, "OWED", 100000, null],
  ];
  for (const [minutes, status, amount, reason] of cases) {
    it(`${minutes} minutes`, () => {
      const ob = first({ passenger: { arrival_delay_minutes: minutes } });
      expect(ob.entitlement_type).toBe("APPR_DELAY");
      expect(ob.status).toBe(status);
      expect(ob.amount_minor).toBe(amount);
      expect(Number.isInteger(ob.amount_minor)).toBe(true);
      expect(ob.reason_code).toBe(reason);
      expect(ob.rule_citation.length).toBeGreaterThan(0);
      expect(ob.rule_citation.startsWith("s. 19(1)")).toBe(true);
      expect(ob.policy_version).toBe("APPR-SOR-2019-150@2022-09-08");
    });
  }
  it("small carrier uses the small-carrier amounts", () => {
    const amounts = [180, 360, 540].map((m) => first({ carrier_size: "SMALL", passenger: { arrival_delay_minutes: m } }).amount_minor);
    expect(amounts).toEqual([12500, 25000, 50000]);
  });
});

describe("E2-UNIT-02 denied-boarding boundaries", () => {
  const cases: [number, number][] = [
    [359, 90000],
    [360, 180000],
    [539, 180000],
    [540, 240000],
    [195, 90000],
    [390, 180000],
  ];
  for (const [minutes, amount] of cases) {
    it(`${minutes} minutes`, () => {
      const ob = first({ passenger: { arrival_delay_minutes: minutes, denied_boarding: true }, disruption: { kind: "DENIED_BOARDING", notice_minutes_before_departure: 0 } });
      expect(ob.entitlement_type).toBe("APPR_DENIED_BOARDING");
      expect(ob.status).toBe("OWED");
      expect(ob.amount_minor).toBe(amount);
      expect(ob.rule_citation.startsWith("s. 20(1)")).toBe(true);
    });
  }
  it("the 14-day notice rule does not apply to denied boarding", () => {
    const ob = first({ passenger: { arrival_delay_minutes: 400, denied_boarding: true }, disruption: { kind: "DENIED_BOARDING", notice_minutes_before_departure: 99999 } });
    expect(ob.status).toBe("OWED");
  });
});

describe("E2-UNIT-03 one test per reason code", () => {
  it("DELAY_UNDER_3H", () => expect(first({ passenger: { arrival_delay_minutes: 130 } }).reason_code).toBe("DELAY_UNDER_3H"));
  it("NOTICE_OVER_14_DAYS (and 14 days exactly is not over)", () => {
    expect(first({ disruption: { notice_minutes_before_departure: 20161 } }).reason_code).toBe("NOTICE_OVER_14_DAYS");
    expect(first({ disruption: { notice_minutes_before_departure: 20160 } }).status).toBe("OWED");
  });
  it("CLAIM_AFTER_ONE_YEAR (and one year to the instant is not after)", () => {
    const ob = first({}, NO_FLAGS, new Date("2027-11-12T00:00:00Z"));
    expect(ob.status).toBe("NOT_OWED");
    expect(ob.reason_code).toBe("CLAIM_AFTER_ONE_YEAR");
    expect(ob.rule_citation).toBe("s. 19(3)");
    expect(first({}, NO_FLAGS, new Date("2027-11-10T13:15:00Z")).status).toBe("OWED");
  });
  it("OUTSIDE_CARRIER_CONTROL", () => {
    const ob = first({ disruption: { control_class: "OUTSIDE_CONTROL", cause_code: "WX" } });
    expect(ob.status).toBe("NOT_OWED");
    expect(ob.reason_code).toBe("OUTSIDE_CARRIER_CONTROL");
    expect(ob.rule_citation).toBe("s. 10");
  });
  it("SAFETY_REQUIRED", () => {
    const ob = first({ disruption: { control_class: "SAFETY_REQUIRED", cause_code: "MX_SAFETY" } });
    expect(ob.status).toBe("NOT_OWED");
    expect(ob.reason_code).toBe("SAFETY_REQUIRED");
    expect(ob.rule_citation).toBe("s. 11");
  });
  it("ALREADY_COMPENSATED_OTHER_REGIME", () => {
    const ob = first({ passenger: { other_regime_compensation: { regime: "EU261", amount_minor: 60000, currency: "EUR" } } });
    expect(ob.reason_code).toBe("ALREADY_COMPENSATED_OTHER_REGIME");
    expect(ob.amount_minor).toBe(0);
  });
  it("ALTERNATIVE_ACCEPTED_IN_WRITING (an expiring alternative does not count)", () => {
    const alt = (expires: boolean) => ({ description: "credit", value_minor: 90000, expires });
    expect(first({ passenger: { alternative_accepted_in_writing: alt(false) } }).reason_code).toBe("ALTERNATIVE_ACCEPTED_IN_WRITING");
    expect(first({ passenger: { alternative_accepted_in_writing: alt(true) } }).status).toBe("OWED");
  });
  it("NOT_GOODWILL_ELIGIBLE", () => {
    const gw = run({}, { payeeChangeRequested: false, goodwillProposed: "OVERNIGHT_STRANDED" }).find((o) => o.entitlement_type === "GOODWILL");
    expect(gw?.status).toBe("NOT_OWED");
    expect(gw?.reason_code).toBe("NOT_GOODWILL_ELIGIBLE");
    expect(gw?.amount_minor).toBe(0);
  });
  it("CAUSE_UNDETERMINED", () => {
    const ob = first({ disruption: { control_class: "UNDETERMINED" } });
    expect(ob.status).toBe("HELD");
    expect(ob.reason_code).toBe("CAUSE_UNDETERMINED");
    expect(ob.amount_minor).toBe(0);
  });
  it("PAYEE_CHANGE_REQUESTED", () => {
    const ob = first({}, { payeeChangeRequested: true, goodwillProposed: null });
    expect(ob.status).toBe("HELD");
    expect(ob.reason_code).toBe("PAYEE_CHANGE_REQUESTED");
    expect(ob.amount_minor).toBe(0);
  });
});

describe("E2-UNIT-04 precedence, first matching row decides", () => {
  const ALL = {
    passenger: {
      arrival_delay_minutes: 100,
      other_regime_compensation: { regime: "EU261", amount_minor: 1, currency: "EUR" },
      alternative_accepted_in_writing: { description: "x", value_minor: 99999, expires: false },
    },
    disruption: { control_class: "OUTSIDE_CONTROL" as const, notice_minutes_before_departure: 30240 },
  };
  const payee = { payeeChangeRequested: true, goodwillProposed: null };
  const late = new Date("2028-01-01T00:00:00Z");
  it("walks the rows in order, removing the winner each time", () => {
    expect(first(ALL, payee, late).reason_code).toBe("CLAIM_AFTER_ONE_YEAR");
    expect(first(ALL, payee).reason_code).toBe("NOTICE_OVER_14_DAYS");
    expect(first({ ...ALL, disruption: { control_class: "OUTSIDE_CONTROL" } }, payee).reason_code).toBe("OUTSIDE_CARRIER_CONTROL");
    expect(first({ ...ALL, disruption: { control_class: "SAFETY_REQUIRED" } }, payee).reason_code).toBe("SAFETY_REQUIRED");
    expect(first({ ...ALL, disruption: { control_class: "UNDETERMINED" } }, payee).reason_code).toBe("DELAY_UNDER_3H");
    const p6 = { ...ALL.passenger, arrival_delay_minutes: 400 };
    expect(first({ passenger: p6, disruption: { control_class: "UNDETERMINED" } }, payee).reason_code).toBe("ALREADY_COMPENSATED_OTHER_REGIME");
    const p7 = { ...p6, other_regime_compensation: null };
    expect(first({ passenger: p7, disruption: { control_class: "UNDETERMINED" } }, payee).reason_code).toBe("ALTERNATIVE_ACCEPTED_IN_WRITING");
    const p8 = { ...p7, alternative_accepted_in_writing: null };
    expect(first({ passenger: p8, disruption: { control_class: "UNDETERMINED" } }, payee).reason_code).toBe("CAUSE_UNDETERMINED");
    expect(first({ passenger: p8 }, payee).reason_code).toBe("PAYEE_CHANGE_REQUESTED");
    expect(first({ passenger: p8 }).status).toBe("OWED");
  });
  it("a payee-change flag on a passenger who would be refused anyway: the refusal wins", () => {
    const ob = first({ passenger: { arrival_delay_minutes: 130 } }, payee);
    expect(ob.status).toBe("NOT_OWED");
    expect(ob.reason_code).toBe("DELAY_UNDER_3H");
  });
});

describe("refund elected (P03 shape)", () => {
  const o = { passenger: { refund_elected: true, arrival_delay_minutes: null }, ticket_price_minor: 41260 };
  it("two obligations with two effect keys, no lateness needed", () => {
    const obs = run(o);
    expect(obs.map((x) => [x.entitlement_type, x.status, x.amount_minor])).toEqual([
      ["APPR_REFUND_COMP", "OWED", 40000],
      ["TICKET_REFUND", "OWED", 41260],
    ]);
    expect(new Set(obs.map((x) => x.effect_key)).size).toBe(2);
    expect(obs[0]?.effect_key).toBe("TESTAA.P90.NT900-20261110.APPR_REFUND_COMP");
  });
  it("small carrier refund compensation", () => expect(run({ ...o, carrier_size: "SMALL" })[0]?.amount_minor).toBe(12500));
  it("payee change holds both; refusal on the compensation leaves the ticket refund owed", () => {
    expect(run(o, { payeeChangeRequested: true, goodwillProposed: null }).map((x) => x.reason_code)).toEqual(["PAYEE_CHANGE_REQUESTED", "PAYEE_CHANGE_REQUESTED"]);
    const outside = run({ ...o, disruption: { control_class: "OUTSIDE_CONTROL" } });
    expect(outside.map((x) => [x.entitlement_type, x.status])).toEqual([["APPR_REFUND_COMP", "NOT_OWED"], ["TICKET_REFUND", "OWED"]]);
  });
  it("throws when the record has no ticket price", () => expect(() => run({ ...o, ticket_price_minor: null })).toThrow(RulesError));
});

describe("E2-UNIT-06 goodwill", () => {
  const base = { passenger: { arrival_delay_minutes: 600, hardship_flags: ["OVERNIGHT_STRANDED" as const, "MOBILITY_ASSIST" as const] } };
  const gw = (o: Over, kind: "OVERNIGHT_STRANDED" | "MOBILITY_ASSIST" | null) => run(o, { payeeChangeRequested: false, goodwillProposed: kind }).filter((x) => x.entitlement_type === "GOODWILL");
  it("none unless proposed", () => expect(gw(base, null)).toEqual([]));
  it("amounts from the tariff, one per passenger per disruption", () => {
    expect(gw(base, "OVERNIGHT_STRANDED").map((x) => x.amount_minor)).toEqual([15000]);
    expect(gw(base, "MOBILITY_ASSIST").map((x) => x.amount_minor)).toEqual([20000]);
  });
  it("a proposal the record does not support is not eligible", () => {
    const only = { passenger: { ...base.passenger, hardship_flags: ["MOBILITY_ASSIST" as const] } };
    expect(gw(only, "OVERNIGHT_STRANDED")[0]?.reason_code).toBe("NOT_GOODWILL_ELIGIBLE");
  });
  it("stamps the goodwill policy version and shares the statutory due_by", () => {
    const obs = run(base, { payeeChangeRequested: false, goodwillProposed: "OVERNIGHT_STRANDED" });
    expect(obs[1]?.policy_version).toBe("NT-GOODWILL@1");
    expect(obs[1]?.rule_citation).toBe("NT-GOODWILL@1");
    expect(obs[1]?.due_by).toEqual(obs[0]?.due_by);
  });
  it("is held with the payee-change flag, and independent of a refused statutory claim", () => {
    const held = run(base, { payeeChangeRequested: true, goodwillProposed: "OVERNIGHT_STRANDED" });
    expect(held.map((x) => x.reason_code)).toEqual(["PAYEE_CHANGE_REQUESTED", "PAYEE_CHANGE_REQUESTED"]);
    const refused = run({ passenger: { ...base.passenger, arrival_delay_minutes: 100 } }, { payeeChangeRequested: false, goodwillProposed: "OVERNIGHT_STRANDED" });
    expect(refused.map((x) => [x.entitlement_type, x.status])).toEqual([["APPR_DELAY", "NOT_OWED"], ["GOODWILL", "OWED"]]);
  });
});

describe("E2-UNIT-07 due_by", () => {
  it("delay: received_at plus 30 days", () => {
    expect(first({}).due_by).toEqual(new Date("2026-12-11T09:00:00Z"));
  });
  it("denied boarding: received_at plus 48 hours", () => {
    const ob = first({ passenger: { arrival_delay_minutes: 400, denied_boarding: true }, disruption: { kind: "DENIED_BOARDING" } });
    expect(ob.due_by).toEqual(new Date("2026-11-13T09:00:00Z"));
  });
});

describe("record fields are copied", () => {
  it("payee_ref and rail from the booking passenger, ids from the record", () => {
    const ob = first({ passenger: { payee_ref: "payee_X_guardian", payout_rail: "legacy" } });
    expect(ob.payee_ref).toBe("payee_X_guardian");
    expect(ob.rail).toBe("legacy");
    expect(ob.currency).toBe("CAD");
    expect(ob.booking_ref).toBe("TESTAA");
    expect(ob.passenger_id).toBe("P90");
    expect(ob.disruption_id).toBe("NT900-20261110");
    expect(ob.effect_key).toBe(effectKey({ booking_ref: "TESTAA", passenger_id: "P90", disruption_id: "NT900-20261110" }, "APPR_DELAY"));
  });
  it("a disruption id that disagrees with the flight and date is a record error", () => {
    expect(() => first({ disruption: { disruption_id: "NT900-20261111" } })).toThrow(RulesError);
  });
});

describe("E2-UNIT-08 purity", () => {
  it("same input, same output; input not mutated", () => {
    const booking = makeBooking({ passenger: { hardship_flags: ["OVERNIGHT_STRANDED"], arrival_delay_minutes: 400 } });
    const input = { booking, passenger: booking.passenger, disruption: booking.disruption, claimReceivedAt: RECEIVED, flags: { payeeChangeRequested: false, goodwillProposed: "OVERNIGHT_STRANDED" as const }, policy: POLICY };
    const before = cloneDeep(input);
    const a = computeObligations(input);
    const b = computeObligations(input);
    expect(a).toEqual(b);
    expect(input).toEqual(before);
    expect(DEPARTURE.toISOString()).toBe("2026-11-10T13:15:00.000Z");
  });
});
