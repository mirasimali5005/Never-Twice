// A2-UNIT-08: crash spec parsing (HANDOVER.md §16).
import { describe, expect, it } from "vitest";
import { BARRIER_NAMES, parseCrashSpec } from "../src/index.ts";

describe("parseCrashSpec", () => {
  it("parses NAME:n", () => {
    expect(parseCrashSpec("BR_DISPATCH_RESPONSE_RECEIVED:2")).toEqual({ name: "BR_DISPATCH_RESPONSE_RECEIVED", nth: 2 });
    expect(parseCrashSpec("CTRL_AFTER_PROVIDER_RESPONSE:1")).toEqual({ name: "CTRL_AFTER_PROVIDER_RESPONSE", nth: 1 });
  });

  it("parses NAME@effect_key", () => {
    expect(parseCrashSpec("BR_DISPATCH_RESPONSE_RECEIVED@ZT4H9X.P02.NT101-20261110.APPR_DELAY")).toEqual({
      name: "BR_DISPATCH_RESPONSE_RECEIVED",
      effectKey: "ZT4H9X.P02.NT101-20261110.APPR_DELAY",
    });
  });

  it("accepts every barrier name", () => {
    expect(BARRIER_NAMES).toHaveLength(10);
    for (const n of BARRIER_NAMES) expect(parseCrashSpec(`${n}:1`)).toEqual({ name: n, nth: 1 });
  });

  it.each([
    "BR_NOT_A_BARRIER:1",
    "CTRL_SOMETHING_ELSE:1",
    "BR_RESERVE_AFTER_COMMIT",
    "BR_RESERVE_AFTER_COMMIT:0",
    "BR_RESERVE_AFTER_COMMIT:-1",
    "BR_RESERVE_AFTER_COMMIT:x",
    "BR_RESERVE_AFTER_COMMIT@",
    "BR_RESERVE_AFTER_COMMIT@zt4h9x",
    "br_reserve_after_commit:1",
    "",
  ])("rejects %j", (s) => {
    expect(parseCrashSpec(s)).toBeNull();
  });
});
