// Provider-side reversal detector (Tier 3, CP-REV-1; HANDOVER.md §11.3 PROVIDER_REVERSAL, §21 "a provider's acknowledgement is not
// payment finality"). Pure: no I/O, no clock, no randomness. Imports only @nt/contracts.
//
// A CONFIRMED intent is immutable (HANDOVER.md §10.2: CONFIRMED → anything is forbidden). This function only says whether a fresh
// read of the confirmed provider object is POSITIVE evidence that the payment was undone at the provider. Anything else, including
// a missing object, an object for another marker, or an unrecognised status, is NOT_EVIDENCE and changes nothing: a reversal is
// never inferred from absence (otherwise a phantom confirmation, mutation M2, would be laundered into a parked item).
import { ACCEPTED_STATUSES, REVERSAL_STATUSES } from "@nt/contracts";
import type { Intent, ProviderObject } from "@nt/contracts";

export type ReversibleIntent = Pick<Intent, "_id" | "state" | "provider" | "amount_minor" | "currency" | "payee_ref" | "evidence">;

export type ReversalCheck =
  | { kind: "STILL_PAID" }
  | { kind: "REVERSED"; status: string }
  | { kind: "NOT_EVIDENCE"; why: string };

export function detectReversal(it: ReversibleIntent, object: ProviderObject | null): ReversalCheck {
  if (it.state !== "CONFIRMED") return { kind: "NOT_EVIDENCE", why: `STATE_${it.state}` };
  if (it.evidence === null) return { kind: "NOT_EVIDENCE", why: "NO_EVIDENCE_ON_INTENT" };
  if (object === null) return { kind: "NOT_EVIDENCE", why: "OBJECT_NOT_FOUND" };
  if (object.id !== it.evidence.provider_object_id) return { kind: "NOT_EVIDENCE", why: "OTHER_OBJECT" };
  if (object.metadata?.nt_marker !== it._id) return { kind: "NOT_EVIDENCE", why: "MARKER_MISMATCH" };
  if (object.amount_minor !== it.amount_minor || object.currency !== it.currency || object.payee_ref !== it.payee_ref) {
    return { kind: "NOT_EVIDENCE", why: "FIELD_MISMATCH" };
  }
  if (ACCEPTED_STATUSES[it.provider]?.has(object.status)) return { kind: "STILL_PAID" };
  if (REVERSAL_STATUSES[it.provider]?.has(object.status)) return { kind: "REVERSED", status: object.status };
  return { kind: "NOT_EVIDENCE", why: `STATUS_${object.status}` };
}
