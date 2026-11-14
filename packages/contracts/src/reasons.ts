// Domain enums and the four reason-code families (HANDOVER.md §7.2, §8.2, §11.3; ARCHITECTURE.md §6.1).
// Families are never mixed: NotOwedReason, HeldReason, ProposalRefusal, QuarantineReason.
import { z } from "zod";

export const ENTITLEMENT_TYPES = ["APPR_DELAY", "APPR_DENIED_BOARDING", "APPR_REFUND_COMP", "TICKET_REFUND", "GOODWILL"] as const;
export const EntitlementType = z.enum(ENTITLEMENT_TYPES);
export type EntitlementType = z.infer<typeof EntitlementType>;

export const ADJUDICATION_STATUSES = ["OWED", "NOT_OWED", "HELD"] as const;
export const AdjudicationStatus = z.enum(ADJUDICATION_STATUSES);
export type AdjudicationStatus = z.infer<typeof AdjudicationStatus>;

/** A "refusal" = a NOT_OWED adjudication with a written reason. */
export const NOT_OWED_REASONS = [
  "DELAY_UNDER_3H",
  "NOTICE_OVER_14_DAYS",
  "CLAIM_AFTER_ONE_YEAR",
  "OUTSIDE_CARRIER_CONTROL",
  "SAFETY_REQUIRED",
  "ALREADY_COMPENSATED_OTHER_REGIME",
  "ALTERNATIVE_ACCEPTED_IN_WRITING",
  "NOT_GOODWILL_ELIGIBLE",
] as const;
export const NotOwedReason = z.enum(NOT_OWED_REASONS);
export type NotOwedReason = z.infer<typeof NotOwedReason>;

export const HELD_REASONS = [
  "CAUSE_UNDETERMINED",
  "PAYEE_CHANGE_REQUESTED",
  "BOOKING_UNRESOLVED",
  "BOOKING_AMBIGUOUS",
  "PASSENGER_UNMATCHED",
  "EXTRACTION_FAILED",
  "CLAIM_TEXT_SUSPICIOUS",
] as const;
export const HeldReason = z.enum(HELD_REASONS);
export type HeldReason = z.infer<typeof HeldReason>;

/** The last five held reasons, which may also apply to a whole claim (a claim-level hold). */
export const CLAIM_HOLD_REASONS = [
  "BOOKING_UNRESOLVED",
  "BOOKING_AMBIGUOUS",
  "PASSENGER_UNMATCHED",
  "EXTRACTION_FAILED",
  "CLAIM_TEXT_SUSPICIOUS",
] as const satisfies readonly HeldReason[];
export const ClaimHoldReason = z.enum(CLAIM_HOLD_REASONS);
export type ClaimHoldReason = z.infer<typeof ClaimHoldReason>;

// UNMATCHED_PROVIDER_OBJECT is never stored on an intent (there is none): the invariant scan records it as an ANOMALY audit event.
// PROBE_NOT_ADMITTED arises only in Tier 3; PROVIDER_REVERSAL is PLANNED.
export const QUARANTINE_REASONS = [
  "KEY_WINDOW_EXPIRED",
  "NO_DEDUPE_NO_EVIDENCE",
  "PROBE_NOT_ADMITTED",
  "CONTRADICTORY_EVIDENCE",
  "AUTHORITY_REVOKED",
  "PAYEE_CHANGED",
  "DECISION_DIVERGENCE",
  "RETRY_BUDGET_EXHAUSTED",
  "PROVIDER_REVERSAL",
  "UNMATCHED_PROVIDER_OBJECT",
] as const;
export const QuarantineReason = z.enum(QUARANTINE_REASONS);
export type QuarantineReason = z.infer<typeof QuarantineReason>;

/** The only quarantine reasons T12 may leave. */
export const ABSENCE_CLASS = ["NO_DEDUPE_NO_EVIDENCE", "KEY_WINDOW_EXPIRED", "RETRY_BUDGET_EXHAUSTED"] as const satisfies readonly QuarantineReason[];
/** Alias of ABSENCE_CLASS (AGENT_TASKS.md packet A name). */
export const ABSENCE_CLASS_REASONS = ABSENCE_CLASS;
export function isAbsenceClass(r: QuarantineReason): boolean {
  return (ABSENCE_CLASS as readonly string[]).includes(r);
}

/** Gateway proposal refusals (HANDOVER.md §7.2): results of propose(), not adjudications and not quarantine reasons.
 *  Only AWAITING_BUDGET is expected in normal operation; the other two indicate a bug or an adversarial proposal and are audited.
 *  "Awaiting budget" is never called a refusal. */
export const PROPOSAL_REFUSALS = ["OBLIGATION_NOT_OWED", "PROPOSAL_MISMATCH", "AWAITING_BUDGET"] as const;
export const ProposalRefusal = z.enum(PROPOSAL_REFUSALS);
export type ProposalRefusal = z.infer<typeof ProposalRefusal>;

/** execution_runs.status; PAUSED only under --pause-before-payout. */
export const RUN_STATUSES = ["SEEDED", "RUNNING", "PAUSED", "ENDED"] as const;
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;

export const LICENCES = ["FIRST_SEND", "L1_SAME_KEY", "L2_BOUNDED_WAIT"] as const;
export const Licence = z.enum(LICENCES);
export type Licence = z.infer<typeof Licence>;

export const PROVIDER_IDS = ["sim_payout", "sim_keyless", "stripe_refund"] as const;
export const ProviderId = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderId>;

export const RAILS = ["instant", "legacy"] as const;
export const Rail = z.enum(RAILS);
export type Rail = z.infer<typeof Rail>;

export const GOODWILL_KINDS = ["OVERNIGHT_STRANDED", "MOBILITY_ASSIST"] as const;
export const GoodwillKind = z.enum(GOODWILL_KINDS);
export type GoodwillKind = z.infer<typeof GoodwillKind>;

export const ARMS = ["nt", "control", "documented", "rules_only", "nt_mutant"] as const;
export const Arm = z.enum(ARMS);
export type Arm = z.infer<typeof Arm>;

export const SCENARIOS = ["S0", "S1"] as const;
export const Scenario = z.enum(SCENARIOS);
export type Scenario = z.infer<typeof Scenario>;

export const AUDIT_EVENT_TYPES = [
  "OBLIGATION_DECIDED",
  "INTENT_RESERVED",
  "INTENT_ADOPTED",
  "DECISION_DIVERGENCE",
  "TRANSITION",
  "LICENCE_GRANTED",
  "EVIDENCE_RECORDED",
  "BUDGET_REFUSED",
  "CLAIM_HELD",
  "ANOMALY", // HANDOVER.md §16 invariant scan
  "OBLIGATION_HELD", // HANDOVER.md §8.2: OWED → HELD by the orchestrator or a person
  "GRANT_FROZEN", // gateway.freezeGrant
] as const;
export const AuditEventType = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof AuditEventType>;
