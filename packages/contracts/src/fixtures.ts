// Fixture file shapes (task A3 data files, as merged; ARCHITECTURE.md §5.1 bookings and policies examples, §7.3 faults).
// Dates are ISO strings in files and Date in stored documents. Policy schemas are loose (extra descriptive fields are kept).
import { z } from "zod";
import { Minor } from "./money.ts";
import { Booking, Disruption, ObligationCurrency, RegimeFact } from "./obligation.ts";
import { EntitlementType, HeldReason, NotOwedReason, Scenario } from "./reasons.ts";

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

// ---------------------------------------------------------------------------------------------------------------- regime packs (CP-EU261-1)

/** One row of a regime's band table. The measure is a fact (e.g. distance_km); bounds carry their own inclusivity; `when` is an
 *  exact-match filter on other facts (e.g. intra_union). The first matching row wins. */
export const RegimeBand = z
  .object({
    id: z.string(),
    min: z.number(),
    min_inclusive: z.boolean(),
    max: z.number().nullable(),
    max_inclusive: z.boolean(),
    when: z.record(z.string(), RegimeFact).optional(),
    amount_minor: Minor.min(0),
    /** Arrival-delay ceiling (minutes, inclusive) under which the reduction applies in this band. */
    reduction_threshold_minutes: z.number().int().min(0).nullable().optional(),
    citation: z.string(),
  })
  .loose();
export type RegimeBand = z.infer<typeof RegimeBand>;

const DisruptionKindEnum = z.enum(["CANCELLATION", "DELAY", "DENIED_BOARDING"]);
const ControlRule = z.discriminatedUnion("status", [
  z.object({ control_class: z.string(), status: z.literal("NOT_OWED"), reason_code: NotOwedReason, kinds: z.array(DisruptionKindEnum).optional(), citation: z.string() }).loose(),
  z.object({ control_class: z.string(), status: z.literal("HELD"), reason_code: HeldReason, kinds: z.array(DisruptionKindEnum).optional(), citation: z.string() }).loose(),
]);

export const RegimeTrigger = z
  .object({
    citation: z.string(),
    /** Arrival delay at the final destination (minutes) from which compensation is owed; 0 = no delay condition. */
    min_arrival_delay_minutes: z.number().int().min(0),
    below_threshold_reason: NotOwedReason.optional(),
    /** Notice (minutes before departure) at or above which nothing is owed. */
    notice_exemption: z.object({ min_notice_minutes: z.number().int(), reason_code: NotOwedReason, citation: z.string() }).loose().optional(),
  })
  .loose();
export type RegimeTrigger = z.infer<typeof RegimeTrigger>;

/** A jurisdiction's rule table as data (e.g. fixtures/policies/EU261-2004@2004-02-11.json). The engine reads it generically. */
export const RegimePolicy = z
  .object({
    _id: z.string(),
    policy_id: z.string(),
    version: z.string(),
    kind: z.literal("STATUTORY"),
    jurisdiction: z.string(),
    currency: ObligationCurrency,
    entitlement_type: EntitlementType,
    compensation: z.object({ citation: z.string(), measure_fact: z.string(), bands: z.array(RegimeBand).min(1) }).loose(),
    triggers: z.partialRecord(DisruptionKindEnum, RegimeTrigger),
    control_rules: z.array(ControlRule),
    reduction: z
      .object({ numerator: z.number().int().min(1), denominator: z.number().int().min(1), requires_fact: z.string(), citation: z.string() })
      .loose()
      .nullable()
      .optional(),
    other_regime: z.object({ citation: z.string() }).loose().nullable().optional(),
    undetermined_citation: z.string().optional(),
    payee_citation: z.string().optional(),
    goodwill_citation: z.string().optional(),
    pay_within_days: z.number().int().nullable(),
    /** Passenger-record fields this table does not model; a record that sets any of them makes the engine refuse to guess. */
    not_modelled_passenger_fields: z.array(z.enum(["refund_elected", "alternative_accepted_in_writing"])),
  })
  .loose();
export type RegimePolicy = z.infer<typeof RegimePolicy>;

/** The policy input of computeObligations (HANDOVER.md §7.2). ASSUMED shape: the two policy documents side by side;
 *  `regimes` (optional, keyed by jurisdiction) carries further rule tables selected by Disruption.jurisdiction. */
export const PolicyBundle = z.object({ statutory: ApprPolicy, goodwill: GoodwillPolicy, regimes: z.record(z.string(), RegimePolicy).optional() });
export type PolicyBundle = z.infer<typeof PolicyBundle>;
