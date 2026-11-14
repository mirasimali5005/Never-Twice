// Goodwill: the carrier's discretionary hardship top-up (HANDOVER.md §7.3). Pure.
// Eligibility is read from the booking record's hardship flags, never from claim text; the amount comes from the tariff.
import type { BookingPassenger, GoodwillKind, GoodwillPolicy } from "@nt/contracts";

export type GoodwillEligibility = { eligible: true; kind: GoodwillKind; amount_minor: number } | { eligible: false };

/** A proposed kind is confirmed only when the passenger's record carries that same hardship flag. One kind, so one payment. */
export function goodwillEligibility(policy: GoodwillPolicy, passenger: BookingPassenger, proposed: GoodwillKind): GoodwillEligibility {
  if (!passenger.hardship_flags.includes(proposed)) return { eligible: false };
  return { eligible: true, kind: proposed, amount_minor: policy.tariff[proposed] };
}

/** The citation of a goodwill decision: the goodwill policy's own id (it is a tariff, not a regulation). */
export function goodwillCitation(policy: GoodwillPolicy): string {
  return policy._id;
}
