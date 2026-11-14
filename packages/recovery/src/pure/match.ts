// Evidence matcher (HANDOVER.md §11.2, frozen; ERRATA 13 and 40). Pure: no I/O, no clock, no randomness.
// Imports only @nt/contracts. The gateway (task B3) calls this for T3 and T13; the reconciler for T6 and T12.
import { ACCEPTED_STATUSES } from "@nt/contracts";
import type { EvidenceMatch, FrozenRequest, Intent, ProviderObject } from "@nt/contracts";

/** The intent fields the matcher reads. A full `Intent` satisfies it. */
export type MatchableIntent = Pick<Intent, "_id" | "amount_minor" | "currency" | "payee_ref" | "provider"> & {
  frozen_request: Pick<FrozenRequest, "parent_ref">;
};

/**
 * matchEvidence(it, records), line for line with HANDOVER.md §11.2:
 *   hits = records whose metadata.nt_marker === it._id (the marker on any other field is ignored)
 *   0 hits            → NO_MATCH
 *   >1 hits           → CONTRADICTION MULTIPLE_OBJECTS
 *   amount, currency or payee differ → CONTRADICTION FIELD_MISMATCH
 *   stripe_refund and parent_ref differs from the frozen request's → CONTRADICTION FIELD_MISMATCH
 *     (ERRATA 40; contracts has no PARENT_MISMATCH member, so the nearest exported reason is used)
 *   status not in ACCEPTED_STATUSES[it.provider] → CONTRADICTION STATUS_<status>
 *   otherwise         → MATCH with the object
 */
export function matchEvidence(it: MatchableIntent, records: readonly ProviderObject[]): EvidenceMatch {
  const hits = records.filter((r) => r?.metadata?.nt_marker === it._id);
  if (hits.length === 0) return { kind: "NO_MATCH" };
  if (hits.length > 1) return { kind: "CONTRADICTION", why: "MULTIPLE_OBJECTS" };
  const h = hits[0]!;
  if (h.amount_minor !== it.amount_minor || h.currency !== it.currency || h.payee_ref !== it.payee_ref) {
    return { kind: "CONTRADICTION", why: "FIELD_MISMATCH" };
  }
  if (it.provider === "stripe_refund" && h.parent_ref !== it.frozen_request.parent_ref) {
    return { kind: "CONTRADICTION", why: "FIELD_MISMATCH" };
  }
  const accepted = ACCEPTED_STATUSES[it.provider];
  // An unknown provider id has no accepted statuses: never a MATCH.
  if (accepted === undefined || !accepted.has(h.status)) {
    return { kind: "CONTRADICTION", why: `STATUS_${h.status}` };
  }
  return { kind: "MATCH", object: h };
}
