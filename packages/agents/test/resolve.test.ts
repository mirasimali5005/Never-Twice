// E3 resolver: pure, hand-written extractions (CLM-03b, CLM-05a, CLM-05b, CLM-15 and the C02, C03, C06, C17 cases).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OpsRecord, type ClaimExtraction } from "@nt/contracts";
import { nameSimilarity, resolve, type ResolverBooking } from "../src/intake/resolve.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
function load(scenario: "S0" | "S1"): ResolverBooking[] {
  const ops = OpsRecord.parse(JSON.parse(readFileSync(join(root, "fixtures/scenarios", scenario, "ops-record.json"), "utf8")));
  const dates = new Map(ops.flights.map((f) => [f.flight_no, f.scheduled_departure_local_date]));
  return ops.bookings.map((b) => ({ ...b, flight_date: dates.get(b.flight_no) }));
}
const S0 = load("S0");
const S1 = load("S1");

const ex = (o: Partial<ClaimExtraction>): ClaimExtraction => ({
  claimant_names: [],
  booking_refs: [],
  flight_numbers: [],
  travel_date: null,
  passengers_claimed_for: [],
  asserted_delay: null,
  asserted_cause: null,
  requested_amount: null,
  payee_change_request: { requested: false, quote: null },
  hardship: { kind: "NONE", quote: null },
  injection_suspected: false,
  language: "en",
  notes: "",
  ...o,
});

describe("nameSimilarity", () => {
  it("is order, case, punctuation and diacritic insensitive", () => {
    expect(nameSimilarity("Whitlock, Daniel", "daniel WHITLOCK")).toBe(1);
    expect(nameSimilarity("Hélène Roy", "Helene Roy")).toBe(1);
  });
  it("accepts a one-letter misspelling and rejects different people", () => {
    expect(nameSimilarity("Daniel Whitlok", "Daniel Whitlock")).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity("J. Smith", "Daniel Whitlock")).toBeLessThan(0.85);
    expect(nameSimilarity("Tomasz Nowak", "Ewa Nowak")).toBeLessThan(0.85);
  });
});

describe("resolve", () => {
  it("C02: no reference, resolves to ZT4H9X / P02 by name, flight and date (CLM-05a)", () => {
    const r = resolve(
      ex({ claimant_names: ["Daniel Whitlock"], flight_numbers: ["NT101"], travel_date: "2026-11-10", passengers_claimed_for: [{ name: "Daniel Whitlock", relation: "self" }] }),
      S0,
      { claim_id: "C02" },
    );
    expect(r).toMatchObject({ kind: "RESOLVED", booking_ref: "ZT4H9X", passenger_ids: ["P02"], method: "NAME_FLIGHT_DATE" });
  });

  it("C03: the misspelling Whitlok resolves through the reference", () => {
    const r = resolve(
      ex({ claimant_names: ["Daniel Whitlok"], booking_refs: ["ZT4H9X"], flight_numbers: ["NT101"], travel_date: "2026-11-10", passengers_claimed_for: [{ name: "Daniel Whitlok", relation: "client" }] }),
      S1,
    );
    expect(r).toMatchObject({ kind: "RESOLVED", booking_ref: "ZT4H9X", passenger_ids: ["P02"], method: "REFERENCE" });
  });

  it("C03 without a usable reference still resolves by name similarity", () => {
    const r = resolve(ex({ claimant_names: ["Daniel Whitlok"], flight_numbers: ["NT101"], travel_date: "2026-11-10", passengers_claimed_for: [{ name: "Daniel Whitlok", relation: null }] }), S1);
    expect(r).toMatchObject({ kind: "RESOLVED", booking_ref: "ZT4H9X", passenger_ids: ["P02"] });
  });

  it("C06: three passengers on RW6N1K", () => {
    const r = resolve(
      ex({
        claimant_names: ["Tomasz Nowak"],
        booking_refs: ["RW6N1K"],
        flight_numbers: ["NT101"],
        travel_date: "2026-11-10",
        passengers_claimed_for: [
          { name: "Tomasz Nowak", relation: "self" },
          { name: "Ewa Nowak", relation: "spouse" },
          { name: "Jan Nowak", relation: "child" },
        ],
        hardship: { kind: "OVERNIGHT_STRANDED", quote: "spent the night in the terminal" },
      }),
      S1,
    );
    expect(r).toMatchObject({ kind: "RESOLVED", booking_ref: "RW6N1K", passenger_ids: ["P05", "P06", "P07"], method: "REFERENCE" });
    if (r.kind === "RESOLVED") expect(r.flags.goodwillProposed).toBe("OVERNIGHT_STRANDED");
  });

  it("a surname alone does not pick between Tomasz, Ewa and Jan Nowak", () => {
    const r = resolve(ex({ booking_refs: ["RW6N1K"], passengers_claimed_for: [{ name: "Nowak", relation: null }] }), S1);
    expect(r).toMatchObject({ kind: "HELD", reason_code: "PASSENGER_UNMATCHED" });
  });

  it("C17: J. Smith on NT101 is BOOKING_UNRESOLVED even with injection suspected", () => {
    const r = resolve(
      ex({ claimant_names: ["J. Smith"], flight_numbers: ["NT101"], travel_date: "2026-11-10", passengers_claimed_for: [{ name: "J. Smith", relation: "self" }], injection_suspected: true }),
      S1,
    );
    expect(r).toMatchObject({ kind: "HELD", reason_code: "BOOKING_UNRESOLVED" });
  });

  it("CLAIM_TEXT_SUSPICIOUS applies only once the booking and passengers resolved", () => {
    const r = resolve(ex({ claimant_names: ["Oliver Grant"], booking_refs: ["KS2R9B"], passengers_claimed_for: [{ name: "Oliver Grant", relation: "self" }], injection_suspected: true }), S1);
    expect(r).toMatchObject({ kind: "HELD", reason_code: "CLAIM_TEXT_SUSPICIOUS" });
  });

  it("CLM-03b: two NT101 bookings, Whitlock and Whitlok, no reference: BOOKING_AMBIGUOUS", () => {
    const base = S1.find((b) => b.passenger_id === "P02")!;
    const twin: ResolverBooking = { ...base, booking_ref: "ZZ9Z9Z", passenger_id: "P99", passenger: { name: "Daniel Whitlok" } };
    const r = resolve(ex({ claimant_names: ["Daniel Whitlock"], flight_numbers: ["NT101"], travel_date: "2026-11-10", passengers_claimed_for: [{ name: "Daniel Whitlock", relation: "self" }] }), [...S1, twin]);
    expect(r).toMatchObject({ kind: "HELD", reason_code: "BOOKING_AMBIGUOUS" });
  });

  it("two references that each match a booking is BOOKING_AMBIGUOUS", () => {
    const r = resolve(ex({ booking_refs: ["ZT4H9X", "QK7R2M"], passengers_claimed_for: [{ name: "Daniel Whitlock", relation: null }] }), S1);
    expect(r).toMatchObject({ kind: "HELD", reason_code: "BOOKING_AMBIGUOUS" });
  });

  it("CLM-05b: no reference, flight or date is BOOKING_UNRESOLVED", () => {
    const r = resolve(ex({ claimant_names: ["Oliver Grant"], passengers_claimed_for: [{ name: "Oliver Grant", relation: "self" }] }), S1);
    expect(r).toMatchObject({ kind: "HELD", reason_code: "BOOKING_UNRESOLVED" });
  });

  it("an unknown reference with no flight is BOOKING_UNRESOLVED; a wrong date on the right flight is too", () => {
    expect(resolve(ex({ booking_refs: ["NOPE12"], claimant_names: ["Oliver Grant"] }), S1)).toMatchObject({ kind: "HELD", reason_code: "BOOKING_UNRESOLVED" });
    const r = resolve(ex({ claimant_names: ["Daniel Whitlock"], flight_numbers: ["NT101"], travel_date: "2026-11-09", passengers_claimed_for: [{ name: "Daniel Whitlock", relation: null }] }), S1);
    expect(r).toMatchObject({ kind: "HELD", reason_code: "BOOKING_UNRESOLVED" });
  });

  it("CLM-15: a fourth person not on RW6N1K is PASSENGER_UNMATCHED", () => {
    const r = resolve(
      ex({
        booking_refs: ["RW6N1K"],
        passengers_claimed_for: [
          { name: "Tomasz Nowak", relation: "self" },
          { name: "Ewa Nowak", relation: "spouse" },
          { name: "Jan Nowak", relation: "child" },
          { name: "Piotr Zielinski", relation: "friend" },
        ],
      }),
      S1,
    );
    expect(r).toMatchObject({ kind: "HELD", reason_code: "PASSENGER_UNMATCHED" });
    if (r.kind === "HELD") expect(r.detail).toContain("Piotr Zielinski");
  });

  it("a claim naming no passenger at all is PASSENGER_UNMATCHED", () => {
    expect(resolve(ex({ booking_refs: ["KS2R9B"] }), S1)).toMatchObject({ kind: "HELD", reason_code: "PASSENGER_UNMATCHED" });
  });

  it("the writer is the claimed-for passenger when no one is listed", () => {
    const r = resolve(ex({ claimant_names: ["Oliver Grant"], booking_refs: ["KS2R9B"] }), S1);
    expect(r).toMatchObject({ kind: "RESOLVED", booking_ref: "KS2R9B", passenger_ids: ["P13"] });
  });

  it("passes the payee-change and hardship flags through", () => {
    const r = resolve(
      ex({
        booking_refs: ["DX3F7Q"],
        passengers_claimed_for: [{ name: "Priya Raman", relation: "self" }],
        payee_change_request: { requested: true, quote: "pay their account instead" },
        hardship: { kind: "MOBILITY_ASSIST", quote: "wheelchair" },
      }),
      S1,
    );
    expect(r).toMatchObject({ kind: "RESOLVED", flags: { payeeChangeRequested: true, goodwillProposed: "MOBILITY_ASSIST" } });
  });

  it("is deterministic and does not mutate its inputs", () => {
    const e = ex({ booking_refs: ["KS2R9B"], passengers_claimed_for: [{ name: "Oliver Grant", relation: null }] });
    const before = JSON.stringify([e, S1]);
    expect(resolve(e, S1)).toEqual(resolve(e, S1));
    expect(JSON.stringify([e, S1])).toBe(before);
  });
});
