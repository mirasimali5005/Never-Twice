// Test helpers: the real policy files, and synthetic booking records for the cases no fixture passenger covers.
import { resolve } from "node:path";
import { Booking, type BookingPassenger, type Disruption, type PolicyBundle } from "@nt/contracts";
import { loadPolicyBundle } from "../src/index.ts";

export const FIXTURES_DIR = process.env["NT_FIXTURES_DIR"] ?? resolve(import.meta.dirname, "../../../fixtures");
export const POLICY: PolicyBundle = loadPolicyBundle(resolve(FIXTURES_DIR, "policies"));

export const DEPARTURE = new Date("2026-11-10T13:15:00Z");
export const RECEIVED = new Date("2026-11-11T09:00:00Z");
export const NO_FLAGS = { payeeChangeRequested: false, goodwillProposed: null } as const;

type Overrides = {
  passenger?: Partial<BookingPassenger>;
  disruption?: Partial<Disruption>;
  carrier_size?: "LARGE" | "SMALL";
  ticket_price_minor?: number | null;
};

/** One synthetic booking record: large carrier, cancelled for crew scheduling (within control), 50 minutes' notice. */
export function makeBooking(o: Overrides = {}): Booking {
  const passenger: BookingPassenger = {
    passenger_id: "P90",
    name: "Test Passenger",
    is_minor: false,
    arrival_delay_minutes: 200,
    payee_ref: "payee_P90",
    payout_rail: "instant",
    hardship_flags: [],
    refund_elected: false,
    other_regime_compensation: null,
    alternative_accepted_in_writing: null,
    denied_boarding: false,
    ...o.passenger,
  };
  const disruption: Disruption = {
    disruption_id: "NT900-20261110",
    flight_no: "NT900",
    scheduled_departure: DEPARTURE,
    kind: "CANCELLATION",
    cause_code: "CREW_SCHED",
    control_class: "WITHIN_CONTROL",
    notice_minutes_before_departure: 50,
    ...o.disruption,
  };
  return Booking.parse({
    _id: "rtest001:TESTAA.P90",
    run_id: "rtest001",
    booking_ref: "TESTAA",
    passenger_id: "P90",
    carrier_code: "NT",
    carrier_size: o.carrier_size ?? "LARGE",
    flight_no: disruption.flight_no,
    ticket_price_minor: o.ticket_price_minor === undefined ? null : o.ticket_price_minor,
    ticket_payment_ref: null,
    passenger,
    disruption,
  });
}
