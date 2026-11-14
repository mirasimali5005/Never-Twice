// EU261 table of the auditor: band boundaries, the 50% reduction, the exemption, and the EU1 fixture against the hand-derived expected outcomes
// (the same file the rules engine's test uses, so the two independent implementations are shown to agree).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eu261AmountMinor, eu261Class, eu261Outcome, EU261_POLICY_VERSION, type Eu261Input } from "../src/eu261-table.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "scenarios", "EU1");
const ops = JSON.parse(readFileSync(join(FIX, "ops-record.json"), "utf8"));
const expected = JSON.parse(readFileSync(join(FIX, "expected-outcomes.json"), "utf8"));

const base: Eu261Input = { distanceKm: 1000, intraUnion: true, kind: "DELAY", arrivalDelayMin: 200, noticeMin: null, control: "WITHIN_CONTROL", rerouted: false };

test("distance bands: 250 / 400 / 600 with boundaries 1500 and 3500", () => {
  assert.equal(eu261AmountMinor(0, true), 250_00);
  assert.equal(eu261AmountMinor(1500, true), 250_00);
  assert.equal(eu261AmountMinor(1500, false), 250_00);
  assert.equal(eu261AmountMinor(1501, true), 400_00);
  assert.equal(eu261AmountMinor(9000, true), 400_00);
  assert.equal(eu261AmountMinor(1501, false), 400_00);
  assert.equal(eu261AmountMinor(3500, false), 400_00);
  assert.equal(eu261AmountMinor(3501, false), 600_00);
  assert.equal(eu261Class(5837, false), "LONG");
  assert.throws(() => eu261Class(-1, true));
});

test("delay threshold 180 minutes (Sturgeon)", () => {
  assert.deepEqual(eu261Outcome({ ...base, arrivalDelayMin: 179 }), { outcome: "REFUSE", reason: "DELAY_UNDER_3H" });
  assert.deepEqual(eu261Outcome({ ...base, arrivalDelayMin: 180 }), { outcome: "PAY", amountMinor: 250_00, currency: "EUR", reduced: false });
});

test("50% reduction at the 2 h / 3 h / 4 h ceilings, only when re-routed", () => {
  const c = { ...base, kind: "CANCELLATION" as const, rerouted: true };
  for (const [km, intra, ceil, full] of [[1200, true, 120, 250_00], [2000, true, 180, 400_00], [3000, false, 180, 400_00], [6000, false, 240, 600_00]] as const) {
    assert.equal((eu261Outcome({ ...c, distanceKm: km, intraUnion: intra, arrivalDelayMin: ceil }) as { amountMinor: number }).amountMinor, full / 2);
    assert.equal((eu261Outcome({ ...c, distanceKm: km, intraUnion: intra, arrivalDelayMin: ceil + 1 }) as { amountMinor: number }).amountMinor, full);
    assert.equal((eu261Outcome({ ...c, distanceKm: km, intraUnion: intra, arrivalDelayMin: ceil, rerouted: false }) as { amountMinor: number }).amountMinor, full);
  }
});

test("exemptions: extraordinary circumstances (not for denied boarding), notice of 14 days, undetermined cause held", () => {
  assert.deepEqual(eu261Outcome({ ...base, control: "OUTSIDE_CONTROL" }), { outcome: "REFUSE", reason: "OUTSIDE_CARRIER_CONTROL" });
  assert.equal(eu261Outcome({ ...base, kind: "DENIED_BOARDING", arrivalDelayMin: 0, control: "OUTSIDE_CONTROL" }).outcome, "PAY");
  assert.deepEqual(eu261Outcome({ ...base, kind: "CANCELLATION", noticeMin: 20160 }), { outcome: "REFUSE", reason: "NOTICE_OVER_14_DAYS" });
  assert.equal(eu261Outcome({ ...base, kind: "CANCELLATION", noticeMin: 20159 }).outcome, "PAY");
  assert.deepEqual(eu261Outcome({ ...base, control: "UNDETERMINED" }), { outcome: "HOLD", reason: "CAUSE_UNDETERMINED" });
});

test("EU1 fixture: the auditor's own table reproduces the hand-derived outcomes", () => {
  assert.equal(expected.policy, EU261_POLICY_VERSION);
  assert.equal(ops.bookings.length, expected.expected.length);
  let owed = 0;
  for (const e of expected.expected) {
    const b = ops.bookings.find((x: { passenger_id: string }) => x.passenger_id === e.passenger_id);
    const d = b.disruption;
    const got = eu261Outcome({
      distanceKm: d.facts.distance_km, intraUnion: d.facts.intra_union, kind: b.passenger.denied_boarding ? "DENIED_BOARDING" : d.kind,
      arrivalDelayMin: b.passenger.arrival_delay_minutes, noticeMin: d.notice_minutes_before_departure, control: d.control_class,
      rerouted: b.passenger.facts?.rerouted_art8 === true,
    });
    if (e.status === "OWED") {
      assert.equal(got.outcome, "PAY", e.passenger_id);
      assert.equal((got as { amountMinor: number }).amountMinor, e.amount_minor, e.passenger_id);
      owed += e.amount_minor;
    } else {
      assert.equal(got.outcome, "REFUSE", e.passenger_id);
      assert.equal((got as { reason: string }).reason, e.reason_code, e.passenger_id);
    }
  }
  assert.equal(owed, expected.totals.owed_minor);
});
