// D1-UNIT-03: key_expires_at arithmetic, the L1 boundary, and the backoff sequence (HANDOVER.md §11.3; ERRATA 12, 14, 40).
import type { ProviderCapabilities } from "@nt/contracts";
import { describe, expect, it } from "vitest";
import { backoffMs, keyExpiresAt, l1Allowed, l1Holds, nextAttemptAt, resendCount } from "../src/pure/index.ts";
import { attempt, makeIntent, T0 } from "./support/fixtures.ts";

const caps = (o: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  dedupesOnIdempotencyKey: true,
  keyRetentionMs: 86_400_000,
  declaredMaxInFlightMs: null,
  stronglyConsistentList: true,
  ...o,
});

describe("keyExpiresAt", () => {
  it("first_dispatch_at + retention − margin, from caps or from a number", () => {
    expect(keyExpiresAt(T0, caps(), 60_000)).toEqual(new Date(T0.getTime() + 86_400_000 - 60_000));
    expect(keyExpiresAt(T0, 86_400_000, 60_000)).toEqual(new Date("2026-11-15T17:59:00.000Z"));
    expect(keyExpiresAt(T0, 4000, 1000)).toEqual(new Date(T0.getTime() + 3000)); // PAY-09b short-retention account
    expect(keyExpiresAt(T0, 4000, 0)).toEqual(new Date(T0.getTime() + 4000));
  });
  it("null when the provider documents no retention", () => {
    expect(keyExpiresAt(T0, null, 60_000)).toBeNull();
    expect(keyExpiresAt(T0, caps({ keyRetentionMs: null }), 60_000)).toBeNull();
  });
  it("refuses a negative margin, invalid retention or an invalid date", () => {
    expect(() => keyExpiresAt(T0, 4000, -1)).toThrow(RangeError);
    expect(() => keyExpiresAt(T0, 4000, Number.NaN)).toThrow(RangeError);
    expect(() => keyExpiresAt(T0, -1, 0)).toThrow(RangeError);
    expect(() => keyExpiresAt(T0, Number.POSITIVE_INFINITY, 0)).toThrow(RangeError);
    expect(() => keyExpiresAt(new Date(Number.NaN), 4000, 0)).toThrow(RangeError);
  });
  it("does not mutate firstDispatchAt", () => {
    const d = new Date(T0);
    keyExpiresAt(d, 4000, 1000);
    expect(d.getTime()).toBe(T0.getTime());
  });
});

describe("l1Holds / l1Allowed", () => {
  const it0 = makeIntent("sim_payout");
  const exp = it0.key_expires_at!.getTime();

  it("l1Allowed is l1Holds", () => expect(l1Allowed).toBe(l1Holds));
  it("true strictly before key_expires_at", () => {
    expect(l1Holds(it0, caps(), new Date(exp - 1))).toBe(true);
    expect(l1Holds(it0, caps(), T0)).toBe(true);
  });
  it("false at the boundary instant (now == key_expires_at) and after", () => {
    expect(l1Holds(it0, caps(), new Date(exp))).toBe(false);
    expect(l1Holds(it0, caps(), new Date(exp + 1))).toBe(false);
  });
  it("false without deduplication, without a key, without an expiry, or with an invalid now", () => {
    expect(l1Holds(it0, caps({ dedupesOnIdempotencyKey: false }), T0)).toBe(false);
    expect(l1Holds(makeIntent("sim_payout", { idempotency_key: null }), caps(), T0)).toBe(false);
    expect(l1Holds(makeIntent("sim_payout", { idempotency_key: "" }), caps(), T0)).toBe(false);
    expect(l1Holds(makeIntent("sim_payout", { key_expires_at: null }), caps(), T0)).toBe(false);
    expect(l1Holds(it0, caps(), new Date(Number.NaN))).toBe(false);
  });
});

describe("backoffMs / nextAttemptAt", () => {
  it("1 s × 2^n where n counts re-sends including the one just made: 2 s, 4 s, 8 s, 16 s, then capped at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1000)).toBe(30000);
    expect(backoffMs(2000)).toBe(30000); // 2^2000 overflows to Infinity; still capped
  });
  it("refuses a negative or fractional count", () => {
    expect(() => backoffMs(-1)).toThrow(RangeError);
    expect(() => backoffMs(1.5)).toThrow(RangeError);
    expect(() => backoffMs(Number.NaN)).toThrow(RangeError);
  });
  it("nextAttemptAt = now + backoff, on the caller's (database) clock", () => {
    expect(nextAttemptAt(T0, 1)).toEqual(new Date(T0.getTime() + 2000));
    expect(nextAttemptAt(T0, 3)).toEqual(new Date(T0.getTime() + 8000));
    expect(nextAttemptAt(T0, 5)).toEqual(new Date(T0.getTime() + 30000));
    expect(() => nextAttemptAt(new Date(Number.NaN), 1)).toThrow(RangeError);
  });
  it("resendCount counts attempts other than FIRST_SEND", () => {
    expect(resendCount({ attempts: [] })).toBe(0);
    expect(resendCount({ attempts: [attempt(1, "FIRST_SEND")] })).toBe(0);
    expect(resendCount({ attempts: [attempt(1, "FIRST_SEND"), attempt(2), attempt(3)] })).toBe(2);
  });
});
