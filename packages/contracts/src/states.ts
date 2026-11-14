// Payment-intent states and transitions (HANDOVER.md §10; ARCHITECTURE.md §6.1).
import { z } from "zod";

export const INTENT_STATES = [
  "RESERVED",
  "DISPATCHING",
  "OUTCOME_UNKNOWN",
  "CONFIRMED",
  "FAILED_NO_EFFECT",
  "QUARANTINED",
  "RELEASED",
] as const;
export const IntentState = z.enum(INTENT_STATES);
export type IntentState = z.infer<typeof IntentState>;

/** Property P6, check C7. */
export const UNRESOLVED_STATES = ["RESERVED", "DISPATCHING", "OUTCOME_UNKNOWN"] as const;
export const TERMINAL_STATES = ["CONFIRMED", "FAILED_NO_EFFECT", "RELEASED"] as const;

export const TRANSITIONS = {
  T1: [null, "RESERVED"],
  T2: ["RESERVED", "DISPATCHING"],
  T3: ["DISPATCHING", "CONFIRMED"],
  T4: ["DISPATCHING", "FAILED_NO_EFFECT"],
  T5: ["DISPATCHING", "OUTCOME_UNKNOWN"],
  T6: ["OUTCOME_UNKNOWN", "CONFIRMED"],
  T7: ["OUTCOME_UNKNOWN", "FAILED_NO_EFFECT"],
  T8: ["OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN"],
  T9: ["OUTCOME_UNKNOWN", "QUARANTINED"],
  T10: ["RESERVED", "RELEASED"],
  T11: ["RESERVED", "QUARANTINED"],
  T12: ["QUARANTINED", "CONFIRMED"],
  T13: ["DISPATCHING", "QUARANTINED"],
} as const satisfies Record<string, readonly [IntentState | null, IntentState]>;
export type TransitionId = keyof typeof TRANSITIONS;
export const TRANSITION_IDS = Object.keys(TRANSITIONS) as TransitionId[];

/** Which component performs each transition (HANDOVER.md §10.2, column "Actor"). */
export const TRANSITION_ACTORS: Record<TransitionId, readonly ("gateway" | "reconciler")[]> = {
  T1: ["gateway"],
  T2: ["gateway"],
  T3: ["gateway"],
  T4: ["gateway"],
  T5: ["gateway", "reconciler"],
  T6: ["reconciler"],
  T7: ["reconciler"],
  T8: ["reconciler"],
  T9: ["reconciler"],
  T10: ["gateway"],
  T11: ["gateway"],
  T12: ["reconciler"],
  T13: ["gateway"],
};

/** The transition id for (from, to), or null if the pair is forbidden. `from` null means "no intent yet" (only T1). */
export function allowedTransition(from: IntentState | null, to: IntentState): TransitionId | null {
  for (const id of TRANSITION_IDS) {
    const [f, t] = TRANSITIONS[id];
    if (f === from && t === to) return id;
  }
  return null;
}

export function isTerminalState(s: IntentState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(s);
}

export function isUnresolvedState(s: IntentState): boolean {
  return (UNRESOLVED_STATES as readonly string[]).includes(s);
}
