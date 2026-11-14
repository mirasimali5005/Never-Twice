// A2-UNIT-05 (ids part): run id, group id, marker, simulator account.
import { describe, expect, it } from "vitest";
import { GroupId, RunId, marker, markerOf, newGroupId, newRunId, simAccountOf } from "../src/index.ts";

describe("ids", () => {
  it("run id: r + 7 lowercase base-36 characters", () => {
    expect(RunId.safeParse("r7k2m9qa").success).toBe(true);
    for (const bad of ["r7k2m9qab", "r7k2m9q", "R7k2m9qa", "r7K2m9qa", "g7k2m9qa", "r7k2m9q-", ""]) {
      expect(RunId.safeParse(bad).success).toBe(false);
    }
  });

  it("group id: g + 7", () => {
    expect(GroupId.safeParse("g4x8p2nd").success).toBe(true);
    for (const bad of ["g4x8p2ndx", "r4x8p2nd", "g4X8p2nd"]) expect(GroupId.safeParse(bad).success).toBe(false);
  });

  it("generates valid, varying ids", () => {
    const runs = new Set(Array.from({ length: 50 }, () => newRunId()));
    for (const r of runs) expect(RunId.safeParse(r).success).toBe(true);
    expect(runs.size).toBeGreaterThan(45);
    expect(GroupId.safeParse(newGroupId()).success).toBe(true);
  });

  it("marker = run_id:effect_key", () => {
    expect(marker("r7k2m9qa", "ZT4H9X.P02.NT101-20261110.APPR_DELAY")).toBe("r7k2m9qa:ZT4H9X.P02.NT101-20261110.APPR_DELAY");
    expect(markerOf).toBe(marker);
    expect(() => marker("r7k2m9qab", "ZT4H9X.P02.NT101-20261110.APPR_DELAY")).toThrow();
    expect(() => marker("r7k2m9qa", "zt4h9x:bad")).toThrow();
  });

  it("simulator account = acct_{run_id}", () => {
    expect(simAccountOf("r7k2m9qa")).toBe("acct_r7k2m9qa");
    expect(() => simAccountOf("x")).toThrow();
  });
});
