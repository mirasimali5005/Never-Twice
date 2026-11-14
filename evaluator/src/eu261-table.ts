// The auditor's OWN copy of the EU261 compensation table (Regulation (EC) No 261/2004, policy EU261-2004@2004-02-11).
// Written from the Regulation text, not from packages/rules or the policy JSON: the project's second deliberate duplicate.
// Plain functions and constants, no table-driven engine, so a misreading in one implementation is not copied into the other.
// All amounts are integer euro cents. Assumptions are the same ones the policy file lists (A2, A10, A11): 3500 km belongs to
// "between 1500 and 3500"; 1500 km belongs to "1500 or less"; re-routing exemptions of Art. 5(1)(c)(ii)-(iii) are not modelled.

export const EU261_POLICY_VERSION = "EU261-2004@2004-02-11";

export type Eu261Class = "UP_TO_1500" | "MID" | "LONG";
export type Eu261Kind = "DELAY" | "CANCELLATION" | "DENIED_BOARDING";
export type Eu261Control = "WITHIN_CONTROL" | "OUTSIDE_CONTROL" | "SAFETY_REQUIRED" | "UNDETERMINED";

/** Art. 7(1): (a) <= 1500 km; (b) intra-Community > 1500 km, or other 1500 < km <= 3500; (c) everything else. */
export function eu261Class(km: number, intraUnion: boolean): Eu261Class {
  if (!(km >= 0)) throw new Error(`distance must be a non-negative number, got ${km}`);
  if (km <= 1500) return "UP_TO_1500";
  if (intraUnion) return "MID";
  return km <= 3500 ? "MID" : "LONG";
}

const AMOUNT: Record<Eu261Class, number> = { UP_TO_1500: 250_00, MID: 400_00, LONG: 600_00 };
/** Art. 7(2): the arrival may not exceed the scheduled arrival by more than 2 h / 3 h / 4 h. */
const REDUCTION_CEILING_MIN: Record<Eu261Class, number> = { UP_TO_1500: 2 * 60, MID: 3 * 60, LONG: 4 * 60 };

export const EU261_DELAY_THRESHOLD_MIN = 3 * 60; // Sturgeon (C-402/07, C-432/07)
export const EU261_NOTICE_EXEMPT_MIN = 14 * 24 * 60; // Art. 5(1)(c)(i): informed at least two weeks before

export function eu261AmountMinor(km: number, intraUnion: boolean): number {
  return AMOUNT[eu261Class(km, intraUnion)];
}

export type Eu261Input = {
  distanceKm: number;
  intraUnion: boolean;
  kind: Eu261Kind;
  arrivalDelayMin: number | null;
  noticeMin: number | null;
  control: Eu261Control;
  rerouted: boolean;
};

export type Eu261Outcome =
  | { outcome: "PAY"; amountMinor: number; currency: "EUR"; reduced: boolean }
  | { outcome: "REFUSE"; reason: "DELAY_UNDER_3H" | "NOTICE_OVER_14_DAYS" | "OUTSIDE_CARRIER_CONTROL" | "SAFETY_REQUIRED" }
  | { outcome: "HOLD"; reason: "CAUSE_UNDETERMINED" };

export function eu261Outcome(i: Eu261Input): Eu261Outcome {
  // Art. 5(1)(c)(i): a cancellation announced two weeks or more ahead owes nothing.
  if (i.kind === "CANCELLATION" && i.noticeMin !== null && i.noticeMin >= EU261_NOTICE_EXEMPT_MIN) {
    return { outcome: "REFUSE", reason: "NOTICE_OVER_14_DAYS" };
  }
  // Art. 5(3): extraordinary circumstances. Denied boarding (Art. 4(3)) has no such defence.
  if (i.kind !== "DENIED_BOARDING") {
    if (i.control === "OUTSIDE_CONTROL") return { outcome: "REFUSE", reason: "OUTSIDE_CARRIER_CONTROL" };
    if (i.control === "SAFETY_REQUIRED") return { outcome: "REFUSE", reason: "SAFETY_REQUIRED" };
  }
  // Delay: three hours or more at the final destination.
  if (i.kind === "DELAY") {
    if (i.arrivalDelayMin === null) throw new Error("delay claim without an arrival delay");
    if (i.arrivalDelayMin < EU261_DELAY_THRESHOLD_MIN) return { outcome: "REFUSE", reason: "DELAY_UNDER_3H" };
  }
  const cls = eu261Class(i.distanceKm, i.intraUnion);
  let amount = AMOUNT[cls];
  let reduced = false;
  if (i.rerouted) {
    if (i.arrivalDelayMin === null) throw new Error("re-routed passenger without an arrival delay");
    if (i.arrivalDelayMin <= REDUCTION_CEILING_MIN[cls]) {
      amount = Math.floor(amount / 2);
      reduced = true;
    }
  }
  if (i.control === "UNDETERMINED" && i.kind !== "DENIED_BOARDING") return { outcome: "HOLD", reason: "CAUSE_UNDETERMINED" };
  return { outcome: "PAY", amountMinor: amount, currency: "EUR", reduced };
}
