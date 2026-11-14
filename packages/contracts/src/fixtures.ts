// Fixture file shapes (task A3 data files, as merged; ARCHITECTURE.md §5.1 bookings and policies examples, §7.3 faults).
// Dates are ISO strings in files and Date in stored documents. Policy schemas are loose (extra descriptive fields are kept).
import { z } from "zod";
import { Minor } from "./money.ts";
import { Booking, Disruption } from "./obligation.ts";
import { Scenario } from "./reasons.ts";

// ---------------------------------------------------------------------------------------------------------------- ops record

/** Disruption as written in a file: scheduled_departure is an ISO-8601 UTC string. */
export const OpsDisruption = Disruption.extend({ scheduled_departure: z.iso.datetime() });
export type OpsDisruption = z.infer<typeof OpsDisruption>;

export const OpsFlight = z.object({
  flight_no: z.string(),
  scheduled_departure_local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  origin: z.string(),
  destination: z.string(),
  disruption: OpsDisruption,
});
export type OpsFlight = z.infer<typeof OpsFlight>;

/** One record per (booking, passenger): the stored Booking document minus _id and run_id, with a file-form disruption. */
export const OpsBooking = Booking.omit({ _id: true, run_id: true, disruption: true }).extend({ disruption: OpsDisruption });
export type OpsBooking = z.infer<typeof OpsBooking>;

/** fixtures/scenarios/<S>/ops-record.json */
export const OpsRecord = z.object({
  scenario: Scenario,
  policy_ids: z.array(z.string()),
  carrier: z.object({ code: z.string(), name: z.string(), size: z.enum(["LARGE", "SMALL"]) }),
  goodwill_pool: z.object({ grant_minor: Minor.min(0), currency: z.literal("CAD"), policy_version: z.string() }),
  flights: z.array(OpsFlight),
  bookings: z.array(OpsBooking),
});
export type OpsRecord = z.infer<typeof OpsRecord>;

/** fixtures/scenarios/<S>/claims/index.json */
export const ClaimIndex = z.array(z.object({ claim_id: z.string(), channel: z.string(), received_at: z.iso.datetime(), file: z.string() }));
export type ClaimIndex = z.infer<typeof ClaimIndex>;

// ---------------------------------------------------------------------------------------------------------------- faults

export const FAULT_KINDS = [
  "DROP_RESPONSE_AFTER_APPLY",
  "DROP_REQUEST",
  "LATE_COMMIT_ON_RELEASE",
  "LATE_COMMIT_AFTER_MS",
  "REJECT",
  "IN_PROGRESS",
  "SERVER_ERROR_AFTER_APPLY",
  "HOLD_RESPONSE_MS",
] as const;
export const FaultKind = z.enum(FAULT_KINDS);
export type FaultKind = z.infer<typeof FaultKind>;

export const FaultEntry = z.object({
  match: z.object({ payee_ref: z.string().optional(), marker: z.string().optional(), ordinal: z.number().int().min(1).optional() }),
  fault: FaultKind,
  times: z.number().int().min(0),
  code: z.string().optional(),
  n: z.number().int().min(1).optional(),
  ms: z.number().int().min(0).optional(),
});
export type FaultEntry = z.infer<typeof FaultEntry>;
/** fixtures/faults/*.json. Carries no account: the harness binds a schedule to an account when it installs it. */
export const FaultSchedule = z.object({ id: z.string(), description: z.string(), faults: z.array(FaultEntry) });
export type FaultSchedule = z.infer<typeof FaultSchedule>;

// ---------------------------------------------------------------------------------------------------------------- policies

export const PolicyBand = z
  .object({
    min_minutes: z.number().int().min(0),
    max_minutes_exclusive: z.number().int().nullable().optional(),
    amount_minor: Minor.min(0),
    citation: z.string().optional(),
  })
  .loose();
export type PolicyBand = z.infer<typeof PolicyBand>;

/** fixtures/policies/APPR-SOR-2019-150@2022-09-08.json (and the `policies` document, _id `${policy_id}@${version}`). */
export const ApprPolicy = z
  .object({
    _id: z.string(),
    policy_id: z.string(),
    version: z.string(),
    kind: z.literal("STATUTORY"),
    currency: z.literal("CAD"),
    delay: z.object({ citation: z.string(), LARGE: z.array(PolicyBand), SMALL: z.array(PolicyBand) }).loose(),
    refund_comp: z.object({ citation: z.string(), LARGE: Minor, SMALL: Minor }).loose(),
    denied_boarding: z.object({ citation: z.string(), bands: z.array(PolicyBand) }).loose(),
    notice_max_minutes: z.number().int(),
    claim_window_years: z.number().int(),
    pay_within_days: z.number().int(),
    denied_boarding_pay_within_hours: z.number().int(),
  })
  .loose();
export type ApprPolicy = z.infer<typeof ApprPolicy>;

/** fixtures/policies/NT-GOODWILL@1.json (fictional). */
export const GoodwillPolicy = z
  .object({
    _id: z.string(),
    policy_id: z.string(),
    version: z.string(),
    kind: z.literal("GOODWILL"),
    currency: z.literal("CAD"),
    tariff: z.object({ OVERNIGHT_STRANDED: Minor, MOBILITY_ASSIST: Minor }),
    one_per_passenger_per_disruption: z.literal(true),
  })
  .loose();
export type GoodwillPolicy = z.infer<typeof GoodwillPolicy>;

/** The policy input of computeObligations (HANDOVER.md §7.2). ASSUMED shape: the two policy documents side by side. */
export const PolicyBundle = z.object({ statutory: ApprPolicy, goodwill: GoodwillPolicy });
export type PolicyBundle = z.infer<typeof PolicyBundle>;
