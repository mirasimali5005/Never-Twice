import { describe, expect, it } from "vitest";
import { ALL_STATES, COLOUR_LABEL, quarantineWords, stateColour, stateLabel } from "../src/stateColour";

// G2-UNIT-02: the state-to-colour map covers every state of HANDOVER 10.1.
describe("stateColour", () => {
  it("covers every intent state", () => {
    expect(ALL_STATES).toHaveLength(7);
    const expected: Record<string, string> = {
      RESERVED: "neutral", DISPATCHING: "amber", OUTCOME_UNKNOWN: "amber", CONFIRMED: "green",
      FAILED_NO_EFFECT: "neutral", QUARANTINED: "grey-blue", RELEASED: "neutral",
    };
    for (const s of ALL_STATES) expect(stateColour({ intentState: s })).toBe(expected[s]);
  });
  it("uses exactly three colours plus neutral", () => {
    const seen = new Set(ALL_STATES.map((s) => stateColour({ intentState: s })));
    expect([...seen].sort()).toEqual(["amber", "green", "grey-blue", "neutral"]);
  });
  it("holds are grey-blue when there is no intent", () => {
    expect(stateColour({ obligationStatus: "HELD" })).toBe("grey-blue");
    expect(stateColour({ claimStatus: "HELD" })).toBe("grey-blue");
    expect(stateColour({ obligationStatus: "OWED" })).toBe("neutral");
    expect(stateColour({})).toBe("neutral");
  });
  it("an intent state wins over a hold", () => {
    expect(stateColour({ intentState: "CONFIRMED", obligationStatus: "HELD" })).toBe("green");
  });
  it("labels match the approved wording", () => {
    expect(COLOUR_LABEL.amber).toBe("In doubt: sent, outcome unknown");
    expect(COLOUR_LABEL.green).toBe("Confirmed");
    expect(COLOUR_LABEL["grey-blue"]).toBe("Needs a person");
    expect(stateLabel("OUTCOME_UNKNOWN")).toBe("In doubt: sent, outcome unknown");
    expect(quarantineWords("NO_DEDUPE_NO_EVIDENCE")).toBe("would not guess: keyless rail, no evidence");
  });
  it("never uses the banned words", () => {
    const all = [...Object.values(COLOUR_LABEL), quarantineWords("NO_DEDUPE_NO_EVIDENCE")].join(" ").toLowerCase();
    for (const w of ["exactly-once", "guaranteed", "tamper-proof", "immutable"]) expect(all).not.toContain(w);
  });
});
