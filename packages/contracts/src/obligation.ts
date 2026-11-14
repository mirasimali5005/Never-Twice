// Obligations and booking records (HANDOVER.md §7.2, §8.2; ARCHITECTURE.md §6.4, §5.1).
import { z } from "zod";
import { RunId } from "./identity.ts";
import { Minor } from "./money.ts";
import { AdjudicationStatus, EntitlementType, GoodwillKind, HeldReason, NotOwedReason, Rail } from "./reasons.ts";

/** What the pure rules engine returns [ADD-12]. amount_minor is 0 unless OWED. */
export const ObligationDecision = z.object({
  effect_key: z.string(),
  booking_ref: z.string(),
  passenger_id: z.string(),
  disruption_id: z.string(),
  entitlement_type: EntitlementType,
  status: AdjudicationStatus,
  amount_minor: Minor.min(0),
  currency: z.literal("CAD"),
  payee_ref: z.string(),
  rail: Rail,
  reason_code: z.union([NotOwedReason, HeldReason]).nullable(),
  rule_citation: z.string(),
  policy_version: z.string(),
  due_by: z.date().nullable(),
});
export type ObligationDecision = z.infer<typeof ObligationDecision>;

export const Obligation = ObligationDecision.extend({
  _id: z.string(),
  run_id: RunId,
  claim_ids: z.array(z.string()),
  decided_at: z.date(),
});
export type Obligation = z.infer<typeof Obligation>;

export const DISRUPTION_KINDS = ["CANCELLATION", "DELAY", "DENIED_BOARDING"] as const;
export const CONTROL_CLASSES = ["WITHIN_CONTROL", "OUTSIDE_CONTROL", "SAFETY_REQUIRED", "UNDETERMINED"] as const;

export const Disruption = z.object({
  disruption_id: z.string(),
  flight_no: z.string(),
  scheduled_departure: z.date(),
  kind: z.enum(DISRUPTION_KINDS),
  cause_code: z.string(),
  control_class: z.enum(CONTROL_CLASSES),
  notice_minutes_before_departure: z.number().int().nullable(),
});
export type Disruption = z.infer<typeof Disruption>;

export const BookingPassenger = z.object({
  passenger_id: z.string(),
  name: z.string(),
  is_minor: z.boolean(),
  arrival_delay_minutes: z.number().int().nullable(),
  payee_ref: z.string(),
  payout_rail: Rail,
  hardship_flags: z.array(GoodwillKind),
  refund_elected: z.boolean(),
  other_regime_compensation: z.object({ regime: z.string(), amount_minor: Minor, currency: z.string() }).nullable(),
  alternative_accepted_in_writing: z.object({ description: z.string(), value_minor: Minor, expires: z.boolean() }).nullable(),
  /** Beyond ARCHITECTURE.md §6.4: carried by the task A3 fixture records (orchestrator instruction at A3 merge). */
  denied_boarding: z.boolean(),
});
export type BookingPassenger = z.infer<typeof BookingPassenger>;

/** bookings: one document per (booking, passenger); written by the seed script only. */
export const Booking = z.object({
  _id: z.string(),
  run_id: RunId,
  booking_ref: z.string(),
  passenger_id: z.string(),
  carrier_code: z.string(),
  carrier_size: z.enum(["LARGE", "SMALL"]),
  flight_no: z.string(),
  ticket_price_minor: Minor.nullable(),
  ticket_payment_ref: z.string().nullable(),
  passenger: BookingPassenger,
  disruption: Disruption,
});
export type Booking = z.infer<typeof Booking>;
