// A2-UNIT-01: transitions allowed and forbidden (HANDOVER.md §10.2), table-driven over all 49 state pairs.
import { describe, expect, it } from "vitest";
import { INTENT_STATES, TRANSITIONS, TRANSITION_IDS, allowedTransition, type IntentState } from "../src/index.ts";

const ALLOWED = new Map<string, string>(
  TRANSITION_IDS.filter((id) => TRANSITIONS[id][0] !== null).map((id) => [`${TRANSITIONS[id][0]}>${TRANSITIONS[id][1]}`, id]),
);

describe("allowedTransition", () => {
  it("has exactly thirteen transitions T1..T13", () => {
    expect(TRANSITION_IDS).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13"]);
  });

  it("allows each of the thirteen transitions", () => {
    for (const id of TRANSITION_IDS) {
      const [from, to] = TRANSITIONS[id];
      expect(allowedTransition(from, to)).toBe(id);
    }
  });

  it("T1 is the only way into RESERVED", () => {
    expect(allowedTransition(null, "RESERVED")).toBe("T1");
    for (const s of INTENT_STATES) expect(allowedTransition(s, "RESERVED")).toBeNull();
    for (const s of INTENT_STATES) if (s !== "RESERVED") expect(allowedTransition(null, s)).toBeNull();
  });

  const pairs: [IntentState, IntentState][] = INTENT_STATES.flatMap((a) => INTENT_STATES.map((b) => [a, b] as [IntentState, IntentState]));
  it.each(pairs)("%s -> %s", (from, to) => {
    const expected = ALLOWED.get(`${from}>${to}`) ?? null;
    expect(allowedTransition(from, to)).toBe(expected);
  });

  it("forbids the §10.2 named pairs", () => {
    for (const s of INTENT_STATES) expect(allowedTransition("CONFIRMED", s)).toBeNull();
    for (const s of INTENT_STATES) if (s !== "CONFIRMED") expect(allowedTransition("QUARANTINED", s)).toBeNull();
    expect(allowedTransition("QUARANTINED", "CONFIRMED")).toBe("T12");
    expect(allowedTransition("DISPATCHING", "RELEASED")).toBeNull();
    expect(allowedTransition("OUTCOME_UNKNOWN", "RELEASED")).toBeNull();
    expect(allowedTransition("RESERVED", "CONFIRMED")).toBeNull();
  });

  it("counts 12 allowed pairs among the 49 (T1 has no from-state)", () => {
    expect(pairs.filter(([a, b]) => allowedTransition(a, b) !== null)).toHaveLength(12);
  });
});
