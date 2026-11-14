// Recovery decision (HANDOVER.md §11.3, frozen truth table; ERRATA 10). Pure: `now` is the database clock read by the caller,
// `guards` are read by the caller. Tier 1 and Tier 2 return exactly SETTLE, REDISPATCH_SAME_KEY or QUARANTINE(reason).
// Rows are evaluated top to bottom; the first row whose condition holds wins. Row 8 (licence L2, WAIT) is Tier 3 and is not built.
import type { EvidenceMatch, Intent, ProviderCapabilities, RecoveryDecision, RecoveryGuards } from "@nt/contracts";
import { dedupesForIntent, keyWindowOpen } from "./licences.ts";

/** Row 5: `attempts.length >= 5` quarantines with RETRY_BUDGET_EXHAUSTED. Counts every attempt, FIRST_SEND included. */
export const MAX_ATTEMPTS = 5;

/** The intent fields the decision reads. A full `Intent` satisfies it. */
export type DecidableIntent = Pick<Intent, "attempts" | "idempotency_key" | "key_expires_at">;

export function decideRecovery(
  it: DecidableIntent,
  match: EvidenceMatch,
  caps: Pick<ProviderCapabilities, "dedupesOnIdempotencyKey">,
  now: Date,
  guards: RecoveryGuards,
): RecoveryDecision {
  // Row 1: contradictory evidence beats everything.
  if (match.kind === "CONTRADICTION") {
    return { row: 1, kind: "QUARANTINE", reason: "CONTRADICTORY_EVIDENCE", detail: `matcher: ${match.why}` };
  }
  // Row 2: matching evidence settles (T6), whatever the guards say: the money has already moved.
  if (match.kind === "MATCH") {
    return { row: 2, kind: "SETTLE", object: match.object };
  }
  // Any other kind is not NO_MATCH by construction; refuse to treat an unknown kind as absence.
  if (match.kind !== "NO_MATCH") {
    return { row: 1, kind: "QUARANTINE", reason: "CONTRADICTORY_EVIDENCE", detail: "matcher: unknown result kind" };
  }
  // Row 3: obligation HELD for a payee change.
  if (guards.obligationStatus === "HELD" && guards.obligationReason === "PAYEE_CHANGE_REQUESTED") {
    return { row: 3, kind: "QUARANTINE", reason: "PAYEE_CHANGED", detail: "obligation HELD: PAYEE_CHANGE_REQUESTED" };
  }
  // Row 4: grant frozen (anything but an explicit false counts as frozen), or obligation not OWED for any other reason.
  if (guards.grantFrozen !== false || guards.obligationStatus !== "OWED") {
    const detail =
      guards.grantFrozen !== false
        ? "authority grant frozen"
        : `obligation ${String(guards.obligationStatus)}${guards.obligationReason ? `: ${guards.obligationReason}` : ""}`;
    return { row: 4, kind: "QUARANTINE", reason: "AUTHORITY_REVOKED", detail };
  }
  // Row 5: retry budget.
  if (it.attempts.length >= MAX_ATTEMPTS) {
    return { row: 5, kind: "QUARANTINE", reason: "RETRY_BUDGET_EXHAUSTED", detail: `${it.attempts.length} attempts (limit ${MAX_ATTEMPTS})` };
  }
  if (dedupesForIntent(it, caps)) {
    // Row 6: L1 window open (now < key_expires_at, strictly).
    if (keyWindowOpen(it, now)) {
      return { row: 6, kind: "REDISPATCH_SAME_KEY", licence: "L1_SAME_KEY" };
    }
    // Row 7: now >= key_expires_at (an unknown expiry counts as expired).
    return {
      row: 7,
      kind: "QUARANTINE",
      reason: "KEY_WINDOW_EXPIRED",
      detail: it.key_expires_at === null ? "key_expires_at unknown" : `now >= key_expires_at ${it.key_expires_at.toISOString()}`,
    };
  }
  // Row 8 (Tier 3, L2) is not built. Row 9: no deduplication and no evidence.
  return { row: 9, kind: "QUARANTINE", reason: "NO_DEDUPE_NO_EVIDENCE", detail: "provider does not deduplicate on the key; no matching evidence" };
}
