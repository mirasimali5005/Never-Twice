// Data-driven rule tables for further jurisdictions (Tier 3, change proposal CP-EU261-1). Pure; no I/O.
// Nothing here knows which regulation it is reading: bands, thresholds, exemptions, reduction, currency and citations all come from a
// RegimePolicy document (e.g. EU261-2004@2004-02-11). The APPR path in compute.ts is untouched.
import {
  disruptionId,
  effectKey,
  type Booking,
  type BookingPassenger,
  type Disruption,
  type EntitlementType,
  type HeldReason,
  type NotOwedReason,
  type ObligationDecision,
  type PolicyBundle,
  type RegimeBand,
  type RegimeFact,
  type RegimePolicy,
} from "@nt/contracts";
import { RulesError } from "./appr.ts";

type Facts = Readonly<Record<string, RegimeFact>>;

/** ONE band lookup for any regime: the first band whose numeric range contains `value` (each bound carries its own inclusivity)
 *  and whose `when` filter matches the facts exactly. null = no band applies. */
export function lookupRegimeBand(bands: readonly RegimeBand[], value: number, facts: Facts): RegimeBand | null {
  for (const b of bands) {
    const aboveMin = b.min_inclusive ? value >= b.min : value > b.min;
    const belowMax = b.max === null ? true : b.max_inclusive ? value <= b.max : value < b.max;
    if (!aboveMin || !belowMax) continue;
    if (b.when && !Object.entries(b.when).every(([k, v]) => facts[k] === v)) continue;
    return b;
  }
  return null;
}

type Verdict =
  | { status: "OWED"; amount_minor: number; citation: string }
  | { status: "NOT_OWED"; reason: NotOwedReason; citation: string }
  | { status: "HELD"; reason: HeldReason; citation: string };

export type RegimeInput = {
  booking: Booking;
  passenger: BookingPassenger;
  disruption: Disruption;
  claimReceivedAt: Date;
  flags: { payeeChangeRequested: boolean; goodwillProposed: string | null };
  policy: PolicyBundle;
};

const MS_PER_DAY = 24 * 3_600_000;

/** The regime selected by the disruption's jurisdiction, or null for the default statutory table. Unknown jurisdiction throws. */
export function selectRegime(policy: PolicyBundle, disruption: Disruption): RegimePolicy | null {
  if (disruption.jurisdiction === undefined) return null;
  const regime = policy.regimes?.[disruption.jurisdiction];
  if (!regime) throw new RulesError(`no rule table for jurisdiction ${JSON.stringify(disruption.jurisdiction)} in the policy bundle`);
  return regime;
}

/** Obligations under a data-driven regime: one statutory obligation, plus a refused goodwill row when goodwill was proposed. */
export function computeRegimeObligations(input: RegimeInput, regime: RegimePolicy): ObligationDecision[] {
  const { booking, passenger, disruption, claimReceivedAt, flags } = input;
  const facts: Facts = { ...(disruption.facts ?? {}), ...(passenger.facts ?? {}) };
  const kind = passenger.denied_boarding ? "DENIED_BOARDING" : disruption.kind;
  const parts = { booking_ref: booking.booking_ref, passenger_id: passenger.passenger_id, disruption_id: disruption.disruption_id };
  if (disruption.disruption_id !== disruptionId(disruption.flight_no, disruption.scheduled_departure)) throw new RulesError("disruption_id does not match flight and departure");

  for (const f of regime.not_modelled_passenger_fields) {
    const v = passenger[f];
    if (v !== null && v !== false) throw new RulesError(`${regime._id} does not model ${f}; the record sets it, so the engine refuses to guess`);
  }

  const due = regime.pay_within_days === null ? null : new Date(claimReceivedAt.getTime() + regime.pay_within_days * MS_PER_DAY);
  const make = (type: EntitlementType, v: Verdict, policyVersion: string): ObligationDecision => ({
    effect_key: effectKey(parts, type),
    booking_ref: booking.booking_ref,
    passenger_id: passenger.passenger_id,
    disruption_id: disruption.disruption_id,
    entitlement_type: type,
    status: v.status,
    amount_minor: v.status === "OWED" ? v.amount_minor : 0,
    currency: regime.currency,
    payee_ref: passenger.payee_ref,
    rail: passenger.payout_rail,
    reason_code: v.status === "OWED" ? null : v.reason,
    rule_citation: v.citation,
    policy_version: policyVersion,
    due_by: due === null ? null : new Date(due.getTime()),
  });

  const out: ObligationDecision[] = [make(regime.entitlement_type, verdict(), regime._id)];
  if (flags.goodwillProposed !== null) {
    out.push(make("GOODWILL", { status: "NOT_OWED", reason: "NOT_GOODWILL_ELIGIBLE", citation: regime.goodwill_citation ?? regime._id }, regime._id));
  }
  return out;

  function verdict(): Verdict {
    const trigger = regime.triggers[kind];
    if (!trigger) throw new RulesError(`${regime._id} has no trigger for ${kind}`);
    // 1. Notice exemption (cancellation).
    const ne = trigger.notice_exemption;
    const notice = disruption.notice_minutes_before_departure;
    if (ne && notice !== null && notice >= ne.min_notice_minutes) return { status: "NOT_OWED", reason: ne.reason_code, citation: ne.citation };
    // 2. Control-class rules that refuse (extraordinary circumstances ...), for the kinds they cover.
    const control = regime.control_rules.find((r) => r.control_class === disruption.control_class && (r.kinds === undefined || r.kinds.includes(kind)));
    if (control && control.status === "NOT_OWED") return { status: "NOT_OWED", reason: control.reason_code, citation: control.citation };
    // 3. Arrival-delay condition.
    if (trigger.min_arrival_delay_minutes > 0) {
      if (passenger.arrival_delay_minutes === null) throw new RulesError(`${kind} needs arrival_delay_minutes on the record`);
      if (passenger.arrival_delay_minutes < trigger.min_arrival_delay_minutes) {
        return { status: "NOT_OWED", reason: trigger.below_threshold_reason ?? "DELAY_UNDER_3H", citation: trigger.citation };
      }
    }
    // 4. Band lookup on the measure fact.
    const measure = facts[regime.compensation.measure_fact];
    if (typeof measure !== "number") throw new RulesError(`record lacks numeric fact ${regime.compensation.measure_fact}`);
    const band = lookupRegimeBand(regime.compensation.bands, measure, facts);
    if (band === null) throw new RulesError(`no band of ${regime._id} covers ${regime.compensation.measure_fact}=${measure} with the record's facts`);
    let amount = band.amount_minor;
    let citation = band.citation;
    // 5. Reduction where the policy's fact is true and the arrival delay is within the band's ceiling.
    const red = regime.reduction;
    if (red && facts[red.requires_fact] === true && band.reduction_threshold_minutes != null) {
      if (passenger.arrival_delay_minutes === null) throw new RulesError("reduction needs arrival_delay_minutes on the record");
      if (passenger.arrival_delay_minutes <= band.reduction_threshold_minutes) {
        const scaled = amount * red.numerator;
        if (scaled % red.denominator !== 0) throw new RulesError("reduction does not give a whole number of minor units");
        amount = scaled / red.denominator;
        citation = `${band.citation}; ${red.citation}`;
      }
    }
    // 6. Compensated under another regime (recorded on the booking).
    if (regime.other_regime && passenger.other_regime_compensation !== null) {
      return { status: "NOT_OWED", reason: "ALREADY_COMPENSATED_OTHER_REGIME", citation: regime.other_regime.citation };
    }
    // 7. Cause could not be settled.
    if (control && control.status === "HELD") return { status: "HELD", reason: control.reason_code, citation: control.citation };
    // 8. A request to pay someone else.
    if (flags.payeeChangeRequested) return { status: "HELD", reason: "PAYEE_CHANGE_REQUESTED", citation: regime.payee_citation ?? citation };
    return { status: "OWED", amount_minor: amount, citation };
  }
}
