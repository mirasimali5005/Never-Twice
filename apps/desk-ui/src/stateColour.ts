// One function from intent state, obligation status and claim status to the three display colours (HANDOVER 10.1, 17).
// Three colours for three states and no others; every other state is neutral text.
import type { Colour, IntentState } from "./types";

export const ALL_STATES: readonly IntentState[] = [
  "RESERVED",
  "DISPATCHING",
  "OUTCOME_UNKNOWN",
  "CONFIRMED",
  "FAILED_NO_EFFECT",
  "QUARANTINED",
  "RELEASED",
];

export function stateColour(input: {
  intentState?: string | null;
  obligationStatus?: string | null;
  claimStatus?: string | null;
}): Colour {
  const s = input.intentState ?? null;
  if (s === "DISPATCHING" || s === "OUTCOME_UNKNOWN") return "amber";
  if (s === "CONFIRMED") return "green";
  if (s === "QUARANTINED") return "grey-blue";
  if (s !== null) return "neutral"; // RESERVED, FAILED_NO_EFFECT, RELEASED: neutral text
  if (input.obligationStatus === "HELD") return "grey-blue";
  if (input.claimStatus === "HELD") return "grey-blue";
  return "neutral";
}

export const COLOUR_LABEL: Record<Colour, string> = {
  amber: "In doubt: sent, outcome unknown",
  green: "Confirmed",
  "grey-blue": "Needs a person",
  neutral: "",
};

export const COLOUR_SHORT: Record<Colour, string> = {
  amber: "In doubt",
  green: "Confirmed",
  "grey-blue": "Needs a person",
  neutral: "",
};

/** Tooltip text for "Confirmed" (HANDOVER 2). */
export const CONFIRMED_MEANS = "the provider holds one matching payment object";

const NEUTRAL_STATE_TEXT: Record<string, string> = {
  RESERVED: "Reserved, nothing sent",
  FAILED_NO_EFFECT: "Rejected by the provider, no payment exists",
  RELEASED: "Cancelled before any send",
};

/** Text for a card: the colour's label, or the plain state words for neutral states. */
export function stateLabel(state: string | null): string {
  const c = stateColour({ intentState: state });
  if (c !== "neutral") return COLOUR_LABEL[c];
  return state ? NEUTRAL_STATE_TEXT[state] ?? state : "";
}

// Plain words for QuarantineReason (ARCHITECTURE 6.1). NO_DEDUPE_NO_EVIDENCE is fixed by the task text.
const QUARANTINE_WORDS: Record<string, string> = {
  NO_DEDUPE_NO_EVIDENCE: "would not guess: keyless rail, no evidence",
  KEY_WINDOW_EXPIRED: "would not guess: the provider's key window has passed",
  RETRY_BUDGET_EXHAUSTED: "would not guess: the retry budget is used up",
  PROBE_NOT_ADMITTED: "would not guess: the lookup was not admitted",
  CONTRADICTORY_EVIDENCE: "would not guess: the provider's records contradict each other",
  AUTHORITY_REVOKED: "spending authority was withdrawn",
  PAYEE_CHANGED: "the payee changed: a person decides",
  DECISION_DIVERGENCE: "the decision changed after the money was reserved",
  PROVIDER_REVERSAL: "the provider reversed the payment",
  UNMATCHED_PROVIDER_OBJECT: "the provider holds a payment this desk did not record",
};

export function quarantineWords(reason: string | null | undefined): string {
  if (!reason) return "";
  return QUARANTINE_WORDS[reason] ?? `would not guess: ${reason}`;
}

const HELD_WORDS: Record<string, string> = {
  CAUSE_UNDETERMINED: "the cause of the delay is undetermined",
  PAYEE_CHANGE_REQUESTED: "the passenger asked to pay someone else",
  BOOKING_UNRESOLVED: "no booking matches this claim",
  BOOKING_AMBIGUOUS: "more than one booking matches",
  PASSENGER_UNMATCHED: "no passenger matches",
  EXTRACTION_FAILED: "the claim could not be read",
  CLAIM_TEXT_SUSPICIOUS: "the claim text tried to give instructions",
};
export function heldWords(reason: string | null | undefined): string {
  return reason ? HELD_WORDS[reason] ?? reason : "";
}
