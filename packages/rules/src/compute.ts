// computeObligations: the pure compensation rules engine (HANDOVER.md §7.2; AGENT_TASKS.md E2 field 12).
// No I/O, no clock, no model, no claim prose. Every input is a field of the booking record, claim metadata (claimReceivedAt) or a flag.
import {
  disruptionId,
  effectKey,
  type Booking,
  type BookingPassenger,
  type Disruption,
  type EntitlementType,
  type GoodwillKind,
  type HeldReason,
  type NotOwedReason,
  type ObligationDecision,
  type PolicyBundle,
} from "@nt/contracts";
import {
  RulesError,
  claimAfterWindow,
  claimWindowCitation,
  delayBand,
  deniedBoardingBand,
  dueBy,
  noCompensationCitation,
  noticeTooEarly,
  ruleCitation,
  refundCompensation,
  ticketRefundCitation,
} from "./appr.ts";
import { goodwillCitation, goodwillEligibility } from "./goodwill.ts";

export type ComputeInput = {
  booking: Booking;
  passenger: BookingPassenger;
  disruption: Disruption;
  claimReceivedAt: Date;
  flags: { payeeChangeRequested: boolean; goodwillProposed: GoodwillKind | null };
  policy: PolicyBundle;
};

type Verdict =
  | { status: "OWED"; amount_minor: number; citation: string }
  | { status: "NOT_OWED"; reason: NotOwedReason; citation: string }
  | { status: "HELD"; reason: HeldReason; citation: string };

/** Obligations for one passenger on one disruption: the statutory entitlement (APPR_DELAY, APPR_DENIED_BOARDING, or
 *  APPR_REFUND_COMP plus TICKET_REFUND), then GOODWILL when a goodwill kind is proposed. Refusals and holds are obligations too. */
export function computeObligations(input: ComputeInput): ObligationDecision[] {
  const { booking, passenger, disruption, claimReceivedAt, flags, policy } = input;
  const appr = policy.statutory;
  if (Number.isNaN(claimReceivedAt.getTime())) throw new RulesError("claimReceivedAt is not a valid date");
  if (passenger.passenger_id !== booking.passenger_id) throw new RulesError("passenger does not belong to the booking record");
  const derivedId = disruptionId(disruption.flight_no, disruption.scheduled_departure);
  if (disruption.disruption_id !== derivedId) throw new RulesError(`disruption_id ${disruption.disruption_id} differs from ${derivedId}`);

  const deniedBoarding = passenger.denied_boarding;
  const due = dueBy(appr, claimReceivedAt, deniedBoarding);
  const parts = { booking_ref: booking.booking_ref, passenger_id: passenger.passenger_id, disruption_id: disruption.disruption_id };

  const make = (type: EntitlementType, v: Verdict, policyVersion: string): ObligationDecision => ({
    effect_key: effectKey(parts, type),
    booking_ref: booking.booking_ref,
    passenger_id: passenger.passenger_id,
    disruption_id: disruption.disruption_id,
    entitlement_type: type,
    status: v.status,
    amount_minor: v.status === "OWED" ? v.amount_minor : 0,
    currency: "CAD",
    payee_ref: passenger.payee_ref,
    rail: passenger.payout_rail,
    reason_code: v.status === "OWED" ? null : v.reason,
    rule_citation: v.citation,
    policy_version: policyVersion,
    due_by: new Date(due.getTime()),
  });

  const out: ObligationDecision[] = [];

  // Statutory compensation (delay, cancellation, denied boarding, or the compensation that accompanies a refund).
  const statutoryType: EntitlementType = deniedBoarding ? "APPR_DENIED_BOARDING" : passenger.refund_elected ? "APPR_REFUND_COMP" : "APPR_DELAY";
  out.push(make(statutoryType, statutoryVerdict(), appr._id));

  // The ticket refund itself: subject only to a payee-change hold (precedence row 9).
  if (passenger.refund_elected && !deniedBoarding) {
    if (booking.ticket_price_minor === null) throw new RulesError("refund elected but the booking record has no ticket price");
    const v: Verdict = flags.payeeChangeRequested
      ? { status: "HELD", reason: "PAYEE_CHANGE_REQUESTED", citation: ruleCitation(appr, "payee", ticketRefundCitation(appr)) }
      : { status: "OWED", amount_minor: booking.ticket_price_minor, citation: ticketRefundCitation(appr) };
    out.push(make("TICKET_REFUND", v, appr._id));
  }

  // Goodwill: only when proposed; eligibility from the record's hardship flags; takes the passenger's statutory due_by.
  if (flags.goodwillProposed !== null) {
    const gw = policy.goodwill;
    const elig = goodwillEligibility(gw, passenger, flags.goodwillProposed);
    const citation = goodwillCitation(gw);
    let v: Verdict;
    if (!elig.eligible) v = { status: "NOT_OWED", reason: "NOT_GOODWILL_ELIGIBLE", citation };
    else if (flags.payeeChangeRequested) v = { status: "HELD", reason: "PAYEE_CHANGE_REQUESTED", citation };
    else v = { status: "OWED", amount_minor: elig.amount_minor, citation };
    out.push(make("GOODWILL", v, gw._id));
  }
  return out;

  /** The first matching row of the precedence table decides (AGENT_TASKS.md E, field 12). */
  function statutoryVerdict(): Verdict {
    // 1. Claim filed more than one year after the disruption.
    if (claimAfterWindow(appr, disruption.scheduled_departure, claimReceivedAt)) {
      return { status: "NOT_OWED", reason: "CLAIM_AFTER_ONE_YEAR", citation: claimWindowCitation(appr) };
    }
    // 2. Delay or cancellation with notice more than 14 days before departure (does not apply to denied boarding).
    if (!deniedBoarding && noticeTooEarly(appr, disruption.notice_minutes_before_departure)) {
      return { status: "NOT_OWED", reason: "NOTICE_OVER_14_DAYS", citation: ruleCitation(appr, "preconditions", appr.delay.citation) };
    }
    // 3, 4. Outside the carrier's control, or required for safety.
    if (disruption.control_class === "OUTSIDE_CONTROL") {
      return { status: "NOT_OWED", reason: "OUTSIDE_CARRIER_CONTROL", citation: noCompensationCitation(appr, "OUTSIDE_CONTROL", appr.delay.citation) };
    }
    if (disruption.control_class === "SAFETY_REQUIRED") {
      return { status: "NOT_OWED", reason: "SAFETY_REQUIRED", citation: noCompensationCitation(appr, "SAFETY_REQUIRED", appr.delay.citation) };
    }
    // 5. Delay entitlement under the lowest band. Not applied to denied boarding or a refund election.
    let banded: { amount_minor: number; citation: string };
    if (deniedBoarding) {
      if (passenger.arrival_delay_minutes === null) throw new RulesError("denied boarding without arrival_delay_minutes on the record");
      const b = deniedBoardingBand(appr, passenger.arrival_delay_minutes);
      if (b === null) throw new RulesError(`no denied-boarding band covers ${passenger.arrival_delay_minutes} minutes`);
      banded = b;
    } else if (passenger.refund_elected) {
      banded = refundCompensation(appr, booking.carrier_size);
    } else {
      if (passenger.arrival_delay_minutes === null) throw new RulesError("delay entitlement without arrival_delay_minutes on the record");
      const b = delayBand(appr, booking.carrier_size, passenger.arrival_delay_minutes);
      if (b === null) return { status: "NOT_OWED", reason: "DELAY_UNDER_3H", citation: appr.delay.citation };
      banded = b;
    }
    // 6. Compensated under another regime (recorded on the booking).
    if (passenger.other_regime_compensation !== null) {
      return { status: "NOT_OWED", reason: "ALREADY_COMPENSATED_OTHER_REGIME", citation: ruleCitation(appr, "other_regime", appr.delay.citation) };
    }
    // 7. A signed, non-expiring alternative (recorded on the booking).
    if (passenger.alternative_accepted_in_writing !== null && !passenger.alternative_accepted_in_writing.expires) {
      return { status: "NOT_OWED", reason: "ALTERNATIVE_ACCEPTED_IN_WRITING", citation: ruleCitation(appr, "form", appr.delay.citation) };
    }
    // 8. Cause could not be settled from the record.
    if (disruption.control_class === "UNDETERMINED") {
      return { status: "HELD", reason: "CAUSE_UNDETERMINED", citation: ruleCitation(appr, "preconditions", appr.delay.citation) };
    }
    // 9. A request to pay someone else.
    if (flags.payeeChangeRequested) {
      return { status: "HELD", reason: "PAYEE_CHANGE_REQUESTED", citation: ruleCitation(appr, "payee", banded.citation) };
    }
    // 10. Owed.
    return { status: "OWED", amount_minor: banded.amount_minor, citation: banded.citation };
  }
}
