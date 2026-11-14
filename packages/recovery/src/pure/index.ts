// @nt/recovery/pure (task D1): the evidence matcher, the recovery decision and the licences.
// Imports only @nt/contracts; no I/O, no clock read, no random value. The gateway (task B3) imports this sub-path for T3 and T13.
export { matchEvidence, type MatchableIntent } from "./match.ts";
export { detectReversal, type ReversalCheck, type ReversibleIntent } from "./reversal.ts";
export { decideRecovery, MAX_ATTEMPTS, type DecidableIntent } from "./decide.ts";
export {
  keyExpiresAt,
  l1Holds,
  l1Allowed,
  dedupesForIntent,
  keyWindowOpen,
  backoffMs,
  nextAttemptAt,
  resendCount,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  type L1Intent,
} from "./licences.ts";
// Re-exported from @nt/contracts for callers' convenience (owned by task A2; never redefined here).
export { ACCEPTED_STATUSES, REVERSAL_STATUSES, ABSENCE_CLASS, isAbsenceClass } from "@nt/contracts";
export type { EvidenceMatch, MatchResult, RecoveryDecision, RecoveryGuards, ProviderObject, ProviderCapabilities } from "@nt/contracts";
