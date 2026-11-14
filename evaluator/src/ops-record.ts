// Hand-written reader for fixtures/scenarios/<S>/ops-record.json, in the format task A3 wrote (merged):
//   { scenario, policy_ids, carrier: { code, name, size }, goodwill_pool: { grant_minor, ... },
//     flights: [{ flight_no, scheduled_departure_local_date, origin, destination, disruption: {...} }],
//     bookings: [ one record per (booking, passenger), ARCHITECTURE §5.1 / §6.4 `Booking`:
//       { booking_ref, passenger_id, carrier_code, carrier_size, flight_no, ticket_price_minor, ticket_payment_ref,
//         passenger: { passenger_id, name, is_minor, arrival_delay_minutes, payee_ref, payout_rail, hardship_flags,
//                      refund_elected, other_regime_compensation, alternative_accepted_in_writing, denied_boarding },
//         disruption: { disruption_id, flight_no, scheduled_departure, kind, cause_code, control_class,
//                       notice_minutes_before_departure } } ] }
// It never imports OpsRecordSchema. Every missing or mistyped field is named in the error; the CLI exits 2 on it.
import type { CarrierSize } from "./appr-table.ts";
import { disruptionId } from "./effect-key.ts";

export class InputError extends Error {}

export type ControlClass = "WITHIN_CONTROL" | "OUTSIDE_CONTROL" | "SAFETY_REQUIRED" | "UNDETERMINED";
export type DisruptionKind = "CANCELLATION" | "DELAY" | "DENIED_BOARDING";

export type OpsFlight = {
  flight_no: string;
  date: string; // YYYY-MM-DD, scheduled departure (local), from flights[].scheduled_departure_local_date
  kind: DisruptionKind;
  cause_code: string;
  control_class: ControlClass;
  notice_minutes_before_departure: number | null;
};

export type OpsPassenger = {
  passenger_id: string;
  booking_ref: string;
  flight_no: string;
  carrier_size: CarrierSize;
  flight: OpsFlight;              // the disruption as recorded on this booking record
  ticket_price_minor: number | null;
  arrival_delay_minutes: number | null;
  denied_boarding: boolean;
  refund_elected: boolean;
  payee_ref: string;
  hardship_flags: string[];
  other_regime_compensation: { regime: string; amount_minor: number; currency: string } | null;
  alternative_accepted_in_writing: boolean;
};

export type OpsRecord = {
  scenario: string;
  goodwill_grant_minor: number | null;
  passengers: OpsPassenger[];
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function obj(o: Record<string, unknown>, k: string, where: string): Record<string, unknown> {
  const v = o[k];
  if (!isObj(v)) throw new InputError(`ops-record: ${where}.${k} must be an object`);
  return v;
}
function str(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) throw new InputError(`ops-record: ${where}.${k} must be a non-empty string`);
  return v;
}
function intOrNull(o: Record<string, unknown>, k: string, where: string): number | null {
  if (!(k in o)) throw new InputError(`ops-record: ${where}.${k} is missing (use null when not applicable)`);
  const v = o[k];
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new InputError(`ops-record: ${where}.${k} must be a non-negative integer or null`);
  return v;
}
function bool(o: Record<string, unknown>, k: string, where: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new InputError(`ops-record: ${where}.${k} must be a boolean`);
  return v;
}
function size(v: unknown, where: string): CarrierSize {
  if (v !== "LARGE" && v !== "SMALL") throw new InputError(`ops-record: ${where} must be LARGE or SMALL`);
  return v;
}

const KINDS: ReadonlySet<string> = new Set(["CANCELLATION", "DELAY", "DENIED_BOARDING"]);
const CONTROL: ReadonlySet<string> = new Set(["WITHIN_CONTROL", "OUTSIDE_CONTROL", "SAFETY_REQUIRED", "UNDETERMINED"]);

function parseDisruption(d: Record<string, unknown>, w: string, flightNo: string, date: string): OpsFlight {
  const kind = str(d, "kind", w);
  if (!KINDS.has(kind)) throw new InputError(`ops-record: ${w}.kind ${JSON.stringify(kind)} is not CANCELLATION, DELAY or DENIED_BOARDING`);
  const control = str(d, "control_class", w);
  if (!CONTROL.has(control)) throw new InputError(`ops-record: ${w}.control_class ${JSON.stringify(control)} is not known`);
  if (d.flight_no !== undefined && d.flight_no !== flightNo) throw new InputError(`ops-record: ${w}.flight_no ${String(d.flight_no)} differs from ${flightNo}`);
  if (d.disruption_id !== undefined && d.disruption_id !== disruptionId(flightNo, date)) {
    throw new InputError(`ops-record: ${w}.disruption_id ${String(d.disruption_id)} differs from ${disruptionId(flightNo, date)}`);
  }
  return {
    flight_no: flightNo, date, kind: kind as DisruptionKind, cause_code: str(d, "cause_code", w),
    control_class: control as ControlClass, notice_minutes_before_departure: intOrNull(d, "notice_minutes_before_departure", w),
  };
}

export function parseOpsRecord(raw: unknown): OpsRecord {
  if (!isObj(raw)) throw new InputError("ops-record: top level must be an object");
  const scenario = str(raw, "scenario", "$");
  const carrierSize = size(obj(raw, "carrier", "$").size, "$.carrier.size");
  const grant = intOrNull(obj(raw, "goodwill_pool", "$"), "grant_minor", "$.goodwill_pool");

  if (!Array.isArray(raw.flights) || raw.flights.length === 0) throw new InputError("ops-record: $.flights must be a non-empty array");
  const flightDates = new Map<string, string>();
  const flights = new Map<string, OpsFlight>();
  raw.flights.forEach((f, i) => {
    const w = `$.flights[${i}]`;
    if (!isObj(f)) throw new InputError(`ops-record: ${w} must be an object`);
    const flight_no = str(f, "flight_no", w);
    const date = str(f, "scheduled_departure_local_date", w);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new InputError(`ops-record: ${w}.scheduled_departure_local_date must be YYYY-MM-DD`);
    if (flightDates.has(flight_no)) throw new InputError(`ops-record: duplicate flight ${flight_no}`);
    flightDates.set(flight_no, date);
    flights.set(flight_no, parseDisruption(obj(f, "disruption", w), `${w}.disruption`, flight_no, date));
  });

  if (!Array.isArray(raw.bookings) || raw.bookings.length === 0) throw new InputError("ops-record: $.bookings must be a non-empty array");
  const passengers: OpsPassenger[] = [];
  const seen = new Set<string>();
  raw.bookings.forEach((b, i) => {
    const w = `$.bookings[${i}]`;
    if (!isObj(b)) throw new InputError(`ops-record: ${w} must be an object`);
    const booking_ref = str(b, "booking_ref", w);
    const passenger_id = str(b, "passenger_id", w);
    const flight_no = str(b, "flight_no", w);
    const date = flightDates.get(flight_no);
    if (date === undefined) throw new InputError(`ops-record: ${w}.flight_no ${flight_no} is not in $.flights`);
    if (seen.has(passenger_id)) throw new InputError(`ops-record: duplicate passenger ${passenger_id}`);
    seen.add(passenger_id);
    const pw = `${w}.passenger`;
    const p = obj(b, "passenger", w);
    if (str(p, "passenger_id", pw) !== passenger_id) throw new InputError(`ops-record: ${pw}.passenger_id differs from ${w}.passenger_id`);
    const flight = parseDisruption(obj(b, "disruption", w), `${w}.disruption`, flight_no, date);
    const top = flights.get(flight_no)!;
    if (flight.kind !== top.kind || flight.control_class !== top.control_class || flight.notice_minutes_before_departure !== top.notice_minutes_before_departure) {
      throw new InputError(`ops-record: ${w}.disruption disagrees with $.flights entry for ${flight_no}`);
    }
    if (!Array.isArray(p.hardship_flags) || !p.hardship_flags.every((x) => typeof x === "string")) {
      throw new InputError(`ops-record: ${pw}.hardship_flags must be an array of strings`);
    }
    if (!("other_regime_compensation" in p)) throw new InputError(`ops-record: ${pw}.other_regime_compensation is missing (use null)`);
    let other: OpsPassenger["other_regime_compensation"] = null;
    if (p.other_regime_compensation !== null) {
      const ow = `${pw}.other_regime_compensation`;
      const orc = obj(p, "other_regime_compensation", pw);
      other = { regime: str(orc, "regime", ow), amount_minor: intOrNull(orc, "amount_minor", ow) ?? 0, currency: str(orc, "currency", ow) };
    }
    if (!("alternative_accepted_in_writing" in p)) throw new InputError(`ops-record: ${pw}.alternative_accepted_in_writing is missing (use null)`);
    const alt = p.alternative_accepted_in_writing;
    if (alt !== null && !isObj(alt)) throw new InputError(`ops-record: ${pw}.alternative_accepted_in_writing must be an object or null`);
    passengers.push({
      passenger_id, booking_ref, flight_no,
      carrier_size: b.carrier_size === undefined ? carrierSize : size(b.carrier_size, `${w}.carrier_size`),
      flight,
      ticket_price_minor: intOrNull(b, "ticket_price_minor", w),
      arrival_delay_minutes: intOrNull(p, "arrival_delay_minutes", pw),
      denied_boarding: bool(p, "denied_boarding", pw),
      refund_elected: bool(p, "refund_elected", pw),
      payee_ref: str(p, "payee_ref", pw),
      hardship_flags: [...(p.hardship_flags as string[])],
      other_regime_compensation: other,
      // The record holds a written acceptance of a non-expiring alternative (s. 21); present = accepted in writing.
      alternative_accepted_in_writing: alt !== null,
    });
  });
  return { scenario, goodwill_grant_minor: grant, passengers };
}
