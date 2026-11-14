// APPR band lookup, citations and carrier-size selection (HANDOVER.md §7.1). Pure; amounts and citations come from the policy.
import type { ApprPolicy, PolicyBand } from "@nt/contracts";

export type CarrierSize = "LARGE" | "SMALL";

export class RulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesError";
  }
}

/** A string field of a loosely typed policy object, or undefined. */
export function policyString(obj: unknown, key: string): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The band with min_minutes <= minutes < max_minutes_exclusive (null or absent max = open ended), or null when none applies. */
export function selectBand(bands: readonly PolicyBand[], minutes: number): PolicyBand | null {
  for (const b of bands) {
    const max = b.max_minutes_exclusive ?? null;
    if (minutes >= b.min_minutes && (max === null || minutes < max)) return b;
  }
  return null;
}

export type Banded = { amount_minor: number; citation: string };

/** Delay or cancellation, by carrier size, by lateness at final destination (s. 19(1)). null = below the lowest band. */
export function delayBand(policy: ApprPolicy, size: CarrierSize, minutes: number): Banded | null {
  const band = selectBand(policy.delay[size], minutes);
  return band ? { amount_minor: band.amount_minor, citation: band.citation ?? policy.delay.citation } : null;
}

/** Denied boarding bands (s. 20(1)); the carrier size does not change them. null = no band covers the lateness. */
export function deniedBoardingBand(policy: ApprPolicy, minutes: number): Banded | null {
  const band = selectBand(policy.denied_boarding.bands, minutes);
  return band ? { amount_minor: band.amount_minor, citation: band.citation ?? policy.denied_boarding.citation } : null;
}

/** The compensation that accompanies a ticket refund (s. 19(2)); amount by carrier size. */
export function refundCompensation(policy: ApprPolicy, size: CarrierSize): Banded {
  return { amount_minor: policy.refund_comp[size], citation: policy.refund_comp.citation };
}

/** Citation for the ticket refund itself (s. 17(2) in the policy's `related` field; falls back to the refund-comp citation). */
export function ticketRefundCitation(policy: ApprPolicy): string {
  return policyString(policy.refund_comp, "related") ?? policy.refund_comp.citation;
}

/** Citation of a named precondition or rule block of the policy, with a fallback. */
export function ruleCitation(policy: ApprPolicy, block: string, fallback: string): string {
  return policyString((policy as Record<string, unknown>)[block], "citation") ?? fallback;
}

/** Citation of the no-compensation row for a control class (ss. 10, 11). */
export function noCompensationCitation(policy: ApprPolicy, controlClass: string, fallback: string): string {
  const rows = (policy as Record<string, unknown>)["no_compensation"];
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (policyString(r, "control_class") === controlClass) return policyString(r, "citation") ?? fallback;
    }
  }
  return fallback;
}

/** Citation of the claim-window rule (s. 19(3)). */
export function claimWindowCitation(policy: ApprPolicy): string {
  return policyString(policy, "claim_window_citation") ?? policy.delay.citation;
}

/** Citation of the pay-within rule. */
export function payWithinCitation(policy: ApprPolicy, deniedBoarding: boolean): string {
  const key = deniedBoarding ? "denied_boarding_pay_within_citation" : "pay_within_citation";
  return policyString(policy, key) ?? policy.delay.citation;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Carrier deadline: denied boarding 48 hours, everything else 30 days after the claim is received (s. 20(2), s. 19(4)). */
export function dueBy(policy: ApprPolicy, claimReceivedAt: Date, deniedBoarding: boolean): Date {
  const ms = deniedBoarding ? policy.denied_boarding_pay_within_hours * MS_PER_HOUR : policy.pay_within_days * MS_PER_DAY;
  return new Date(claimReceivedAt.getTime() + ms);
}

/** True when the claim was received more than `claim_window_years` after the scheduled departure (calendar years, UTC). */
export function claimAfterWindow(policy: ApprPolicy, scheduledDeparture: Date, claimReceivedAt: Date): boolean {
  const limit = new Date(scheduledDeparture.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + policy.claim_window_years);
  return claimReceivedAt.getTime() > limit.getTime();
}

/** True when the passenger was told more than the policy's maximum notice (14 days) before departure. Unknown notice never refuses. */
export function noticeTooEarly(policy: ApprPolicy, noticeMinutesBeforeDeparture: number | null): boolean {
  return noticeMinutesBeforeDeparture !== null && noticeMinutesBeforeDeparture > policy.notice_max_minutes;
}
