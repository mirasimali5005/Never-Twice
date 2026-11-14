// E2-UNIT-05: every S1 passenger, from the real fixture files, against the HANDOVER §7.4 table.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Booking, ClaimIndex, OpsRecord, type GoodwillKind, type ObligationDecision } from "@nt/contracts";
import { computeObligations } from "../src/index.ts";
import { FIXTURES_DIR, POLICY } from "./helpers.ts";

const read = (p: string): unknown => JSON.parse(readFileSync(join(FIXTURES_DIR, p), "utf8"));
const ops = OpsRecord.parse(read("scenarios/S1/ops-record.json"));
const claims = ClaimIndex.parse(read("scenarios/S1/claims/index.json"));
const receivedAt = (claimId: string): Date => {
  const c = claims.find((x) => x.claim_id === claimId);
  if (!c) throw new Error(`no claim ${claimId}`);
  return new Date(c.received_at);
};

function bookingOf(pid: string): Booking {
  const b = ops.bookings.find((x) => x.passenger_id === pid);
  if (!b) throw new Error(`no booking record for ${pid}`);
  return Booking.parse({
    ...b,
    _id: `rfixtur1:${b.booking_ref}.${b.passenger_id}`,
    run_id: "rfixtur1",
    disruption: { ...b.disruption, scheduled_departure: new Date(b.disruption.scheduled_departure) },
  });
}

// The claim each passenger's fixture claim is, and the goodwill the intake would propose (HANDOVER §7.4 claims table).
const CLAIM: Record<string, string> = {
  P01: "C01", P02: "C02", P03: "C04", P04: "C05", P05: "C06", P06: "C06", P07: "C06", P08: "C07", P09: "C09",
  P10: "C10", P11: "C11", P12: "C12", P13: "C13", P14: "C14", P15: "C15", P16: "C16",
};
const PROPOSED: Record<string, GoodwillKind> = { P01: "MOBILITY_ASSIST", P05: "OVERNIGHT_STRANDED", P06: "OVERNIGHT_STRANDED", P07: "OVERNIGHT_STRANDED", P10: "OVERNIGHT_STRANDED" };

function compute(pid: string, opts: { payeeChange?: boolean; goodwill?: boolean } = {}): ObligationDecision[] {
  const booking = bookingOf(pid);
  const claimId = CLAIM[pid];
  if (!claimId) throw new Error(`passenger ${pid} files no claim`);
  return computeObligations({
    booking,
    passenger: booking.passenger,
    disruption: booking.disruption,
    claimReceivedAt: receivedAt(claimId),
    flags: { payeeChangeRequested: opts.payeeChange ?? false, goodwillProposed: opts.goodwill === false ? null : (PROPOSED[pid] ?? null) },
    policy: POLICY,
  });
}
const summary = (obs: ObligationDecision[]) => obs.map((o) => [o.entitlement_type, o.status, o.amount_minor, o.reason_code]);

describe("S1 fixture outcomes (HANDOVER §7.4)", () => {
  it("P01: 70000 APPR_DELAY, goodwill 20000 eligible", () => {
    expect(summary(compute("P01"))).toEqual([["APPR_DELAY", "OWED", 70000, null], ["GOODWILL", "OWED", 20000, null]]);
  });
  it("P02: 70000 (a claim of 1,000 for 'over nine hours' is not an input)", () => {
    expect(summary(compute("P02"))).toEqual([["APPR_DELAY", "OWED", 70000, null]]);
  });
  it("P03: 40000 APPR_REFUND_COMP and 41260 TICKET_REFUND", () => {
    const obs = compute("P03");
    expect(summary(obs)).toEqual([["APPR_REFUND_COMP", "OWED", 40000, null], ["TICKET_REFUND", "OWED", 41260, null]]);
    expect(obs.map((o) => o.effect_key)).toEqual(["LM2P8D.P03.NT101-20261110.APPR_REFUND_COMP", "LM2P8D.P03.NT101-20261110.TICKET_REFUND"]);
  });
  it("P04: refusal DELAY_UNDER_3H", () => {
    expect(summary(compute("P04"))).toEqual([["APPR_DELAY", "NOT_OWED", 0, "DELAY_UNDER_3H"]]);
  });
  it("P05, P06, P07: 100000 each, goodwill 15000 each; P07 pays the booking's designated payee", () => {
    for (const pid of ["P05", "P06", "P07"]) {
      expect(summary(compute(pid)), pid).toEqual([["APPR_DELAY", "OWED", 100000, null], ["GOODWILL", "OWED", 15000, null]]);
    }
    expect(compute("P07").every((o) => o.payee_ref === "payee_P07_guardian")).toBe(true);
    expect(compute("P05").every((o) => o.payee_ref === "payee_P05")).toBe(true);
  });
  it("P08: held PAYEE_CHANGE_REQUESTED when flagged, else 40000", () => {
    expect(summary(compute("P08", { payeeChange: true }))).toEqual([["APPR_DELAY", "HELD", 0, "PAYEE_CHANGE_REQUESTED"]]);
    expect(summary(compute("P08"))).toEqual([["APPR_DELAY", "OWED", 40000, null]]);
  });
  it("P09: refusal NOTICE_OVER_14_DAYS", () => {
    expect(summary(compute("P09"))).toEqual([["APPR_DELAY", "NOT_OWED", 0, "NOTICE_OVER_14_DAYS"]]);
  });
  it("P10: 180000 APPR_DENIED_BOARDING, goodwill 15000", () => {
    expect(summary(compute("P10"))).toEqual([["APPR_DENIED_BOARDING", "OWED", 180000, null], ["GOODWILL", "OWED", 15000, null]]);
  });
  it("P11: 90000 denied boarding on the legacy rail", () => {
    const obs = compute("P11");
    expect(summary(obs)).toEqual([["APPR_DENIED_BOARDING", "OWED", 90000, null]]);
    expect(obs[0]?.rail).toBe("legacy");
  });
  it("P12: refusal ALREADY_COMPENSATED_OTHER_REGIME", () => {
    expect(summary(compute("P12"))).toEqual([["APPR_DELAY", "NOT_OWED", 0, "ALREADY_COMPENSATED_OTHER_REGIME"]]);
  });
  it("P13: 70000", () => {
    expect(summary(compute("P13"))).toEqual([["APPR_DELAY", "OWED", 70000, null]]);
  });
  it("P14: refusal ALTERNATIVE_ACCEPTED_IN_WRITING", () => {
    expect(summary(compute("P14"))).toEqual([["APPR_DELAY", "NOT_OWED", 0, "ALTERNATIVE_ACCEPTED_IN_WRITING"]]);
  });
  it("P15, P16: held CAUSE_UNDETERMINED", () => {
    for (const pid of ["P15", "P16"]) expect(summary(compute(pid)), pid).toEqual([["APPR_DELAY", "HELD", 0, "CAUSE_UNDETERMINED"]]);
  });
  it("P17 files no claim: the fixture has no claim for them, so nothing is computed", () => {
    expect(CLAIM["P17"]).toBeUndefined();
    expect(() => compute("P17")).toThrow(/files no claim/);
  });

  it("every obligation is stamped, cited, in integer cents, with a deadline and keys built from the record", () => {
    for (const pid of Object.keys(CLAIM)) {
      for (const o of compute(pid)) {
        expect(o.policy_version, `${pid} ${o.entitlement_type}`).toMatch(/^(APPR-SOR-2019-150@2022-09-08|NT-GOODWILL@1)$/);
        expect(o.rule_citation.length).toBeGreaterThan(0);
        expect(Number.isInteger(o.amount_minor)).toBe(true);
        expect(o.due_by).toBeInstanceOf(Date);
        expect(o.effect_key).toMatch(/^[A-Z0-9._-]+$/);
        expect(o.effect_key.endsWith(`.${o.entitlement_type}`)).toBe(true);
        expect(o.effect_key.startsWith(`${o.booking_ref}.${o.passenger_id}.${o.disruption_id}.`)).toBe(true);
      }
    }
  });

  it("due_by: denied boarding 48 hours, everything else 30 days, goodwill equals the statutory due_by", () => {
    expect(compute("P10")[0]?.due_by).toEqual(new Date(receivedAt("C10").getTime() + 48 * 3_600_000));
    expect(compute("P11")[0]?.due_by).toEqual(new Date(receivedAt("C11").getTime() + 48 * 3_600_000));
    expect(compute("P13")[0]?.due_by).toEqual(new Date(receivedAt("C13").getTime() + 30 * 86_400_000));
    for (const pid of ["P01", "P05", "P06", "P07", "P10"]) {
      const [statutory, goodwill] = compute(pid);
      expect(goodwill?.due_by, pid).toEqual(statutory?.due_by);
    }
  });

  it("S1 totals: 820000 across 9 statutory payments (P08 not paid), one refund of 41260, 80000 goodwill eligible", () => {
    const all: ObligationDecision[] = [];
    for (const pid of Object.keys(CLAIM)) all.push(...compute(pid, { payeeChange: pid === "P08" }));
    const owed = all.filter((o) => o.status === "OWED");
    const statutory = owed.filter((o) => o.entitlement_type !== "TICKET_REFUND" && o.entitlement_type !== "GOODWILL");
    expect(statutory).toHaveLength(9);
    expect(statutory.reduce((s, o) => s + o.amount_minor, 0)).toBe(820000);
    const refunds = owed.filter((o) => o.entitlement_type === "TICKET_REFUND");
    expect(refunds.map((o) => o.amount_minor)).toEqual([41260]);
    const goodwill = owed.filter((o) => o.entitlement_type === "GOODWILL");
    expect(goodwill).toHaveLength(5);
    expect(goodwill.reduce((s, o) => s + o.amount_minor, 0)).toBe(80000);
    expect(all.filter((o) => o.status === "NOT_OWED").map((o) => o.passenger_id).sort()).toEqual(["P04", "P09", "P12", "P14"]);
    expect(all.filter((o) => o.status === "HELD").map((o) => o.passenger_id).sort()).toEqual(["P08", "P15", "P16"]);
  });

  it("with P08 paid to the passenger the statutory total is 860000 across 10", () => {
    const all: ObligationDecision[] = [];
    for (const pid of Object.keys(CLAIM)) all.push(...compute(pid));
    const statutory = all.filter((o) => o.status === "OWED" && o.entitlement_type !== "TICKET_REFUND" && o.entitlement_type !== "GOODWILL");
    expect(statutory).toHaveLength(10);
    expect(statutory.reduce((s, o) => s + o.amount_minor, 0)).toBe(860000);
  });

  it("the engine does not mutate the booking records", () => {
    const b = bookingOf("P01");
    const before = structuredClone(b);
    computeObligations({ booking: b, passenger: b.passenger, disruption: b.disruption, claimReceivedAt: receivedAt("C01"), flags: { payeeChangeRequested: false, goodwillProposed: "MOBILITY_ASSIST" }, policy: POLICY });
    expect(b).toEqual(before);
  });
});
