// B2-UNIT-02: applyTransition throws before any database call for every forbidden (from, to) pair.
import { describe, expect, it } from "vitest";
import { INTENT_STATES, allowedTransition } from "@nt/contracts";
import type { NtDb } from "@nt/db";
import { ProgrammerError, applyTransition } from "../src/index.ts";

const untouchable = new Proxy({} as NtDb, {
  get(_t, prop) {
    throw new Error(`database touched: ${String(prop)}`);
  },
});

describe("applyTransition guards", () => {
  const pairs = INTENT_STATES.flatMap((from) => INTENT_STATES.map((to) => [from, to] as const));
  const forbidden = pairs.filter(([f, t]) => allowedTransition(f, t) === null);

  it("covers the forbidden list of HANDOVER §10.2", () => {
    expect(forbidden).toContainEqual(["CONFIRMED", "RESERVED"]);
    expect(forbidden).toContainEqual(["DISPATCHING", "RELEASED"]);
    expect(forbidden).toContainEqual(["OUTCOME_UNKNOWN", "RELEASED"]);
    expect(forbidden).toContainEqual(["RESERVED", "CONFIRMED"]);
    expect(forbidden).toContainEqual(["QUARANTINED", "RELEASED"]);
    expect(forbidden.length).toBe(pairs.length - 12); // 12 allowed pairs among states (T1 has no source state)
  });

  for (const [from, to] of forbidden) {
    it(`${from} -> ${to} is refused before any database call`, async () => {
      await expect(
        applyTransition(untouchable, { intentId: "x", from, to, epoch: 0, set: {}, event: { actor: { kind: "gateway", id: "t" }, detail: {} } }),
      ).rejects.toBeInstanceOf(ProgrammerError);
    });
  }
});
