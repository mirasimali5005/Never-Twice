// The auditor's OWN copy of the APPR statutory table (HANDOVER §7.1, policy APPR-SOR-2019-150@2022-09-08)
// and the fictional goodwill tariff NT-GOODWILL@1 (HANDOVER §7.3). Written from the document, not from
// packages/rules: this is the project's one deliberate duplicate. All amounts are integer cents (CAD).

export const APPR_POLICY_VERSION = "APPR-SOR-2019-150@2022-09-08";
export const GOODWILL_POLICY_VERSION = "NT-GOODWILL@1";

export type CarrierSize = "LARGE" | "SMALL";

// Boundaries are exact: 180 minutes is "3 h"; 179 is not.
export const THRESHOLD_3H = 180;
export const THRESHOLD_6H = 360;
export const THRESHOLD_9H = 540;

// "Passenger informed 14 days or less before departure" (ss. 12, 19).
export const NOTICE_LIMIT_MINUTES = 14 * 24 * 60; // 20160
// "Request filed within one year" (s. 19(3)).
export const CLAIM_LIMIT_DAYS = 365;

const DELAY_BANDS: Record<CarrierSize, readonly [number, number, number]> = {
  LARGE: [40000, 70000, 100000],
  SMALL: [12500, 25000, 50000],
};
const REFUND_COMP: Record<CarrierSize, number> = { LARGE: 40000, SMALL: 12500 };
const DENIED_BOARDING_BANDS: readonly [number, number, number] = [90000, 180000, 240000];

export const GOODWILL_TARIFF: Readonly<Record<string, number>> = {
  OVERNIGHT_STRANDED: 15000,
  MOBILITY_ASSIST: 20000,
};

function assertMinutes(m: number): void {
  if (!Number.isInteger(m) || m < 0) throw new Error(`minutes must be a non-negative integer, got ${m}`);
}

/** s. 19(1): delay or cancellation, by lateness at final destination. null = under 3 h (not owed). */
export function delayCompensationMinor(size: CarrierSize, lateMinutes: number): number | null {
  assertMinutes(lateMinutes);
  const b = DELAY_BANDS[size];
  if (lateMinutes < THRESHOLD_3H) return null;
  if (lateMinutes < THRESHOLD_6H) return b[0];
  if (lateMinutes < THRESHOLD_9H) return b[1];
  return b[2];
}

/** s. 19(2), s. 17(2): ticket refunded instead of rebooking. */
export function refundCompensationMinor(size: CarrierSize): number {
  return REFUND_COMP[size];
}

/** s. 20(1): denied boarding, by lateness at destination: under 6 h, 6 h to under 9 h, 9 h or more. */
export function deniedBoardingCompensationMinor(lateMinutes: number): number {
  assertMinutes(lateMinutes);
  if (lateMinutes < THRESHOLD_6H) return DENIED_BOARDING_BANDS[0];
  if (lateMinutes < THRESHOLD_9H) return DENIED_BOARDING_BANDS[1];
  return DENIED_BOARDING_BANDS[2];
}

/** NT-GOODWILL@1: one payment per passenger per disruption; the highest tariff among the record's flags. */
export function goodwillMinor(flags: readonly string[]): number | null {
  let best: number | null = null;
  for (const f of flags) {
    const v = GOODWILL_TARIFF[f];
    if (v !== undefined && (best === null || v > best)) best = v;
  }
  return best;
}

export function delayCitation(lateMinutes: number): string {
  if (lateMinutes < THRESHOLD_6H) return "s. 19(1)(a)(i)";
  if (lateMinutes < THRESHOLD_9H) return "s. 19(1)(a)(ii)";
  return "s. 19(1)(a)(iii)";
}
