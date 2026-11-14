// EU1 fixture (fictional CDG-FCO and CDG-JFK flights, four synthetic passengers) through computeObligations,
// against the hand-derived expected-outcomes.json. The auditor's own table is checked against the same file in evaluator/test.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Booking } from "@nt/contracts";
import { EU261_POLICY_ID, computeObligations, loadPolicyBundle } from "../src/index.ts";
import { FIXTURES_DIR } from "./helpers.ts";

const read = (p: string): any => JSON.parse(readFileSync(join(FIXTURES_DIR, p), "utf8"));
const ops = read("scenarios/EU1/ops-record.json");
const expected = read("scenarios/EU1/expected-outcomes.json");
const policy = loadPolicyBundle(resolve(FIXTURES_DIR, "policies"), undefined, [EU261_POLICY_ID]);

describe("EU1 fixture outcomes (rules engine)", () => {
  it("has four passengers and the policy it names loads", () => {
    expect(ops.bookings).toHaveLength(4);
    expect(ops.policy_ids).toEqual([EU261_POLICY_ID]);
  });
  for (const e of expected.expected) {
    it(`${e.passenger_id}: ${e.status} ${e.amount_minor} ${e.reason_code ?? ""}`, () => {
      const raw = ops.bookings.find((b: any) => b.passenger_id === e.passenger_id);
      const booking = Booking.parse({
        ...raw,
        _id: `reu1test:${raw.booking_ref}.${raw.passenger_id}`,
        run_id: "reu1test",
        disruption: { ...raw.disruption, scheduled_departure: new Date(raw.disruption.scheduled_departure) },
      });
      const out = computeObligations({
        booking, passenger: booking.passenger, disruption: booking.disruption, claimReceivedAt: new Date(expected.claim_received_at),
        flags: { payeeChangeRequested: false, goodwillProposed: null }, policy,
      });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        effect_key: e.effect_key, status: e.status, amount_minor: e.amount_minor, reason_code: e.reason_code,
        currency: "EUR", policy_version: expected.policy, entitlement_type: "EU261_COMPENSATION", due_by: null,
      });
      expect(out[0]!.rule_citation).toMatch(/Art\./);
    });
  }
  it("totals match: 550.00 EUR across 2 payments, 2 refusals", () => {
    const owed = expected.expected.filter((e: any) => e.status === "OWED");
    expect(owed.reduce((a: number, e: any) => a + e.amount_minor, 0)).toBe(expected.totals.owed_minor);
    expect(owed).toHaveLength(expected.totals.owed_payments);
  });
});
