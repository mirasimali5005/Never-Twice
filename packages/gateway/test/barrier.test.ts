// B3-UNIT-01 and B3-UNIT-02: barriers and the mutation switch.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { __setBarrierFireForTests, barrier, barrierAfterMs } from "../src/barrier.ts";
import { mutation } from "../src/mutation.ts";

afterEach(() => {
  delete process.env.NT_CRASH_AT;
  delete process.env.NT_MUTATION;
  __setBarrierFireForTests(null);
});

describe("barrier", () => {
  it("is a no-op without NT_CRASH_AT or with a malformed one", () => {
    let fired = 0;
    __setBarrierFireForTests(() => fired++);
    barrier("BR_DISPATCH_AFTER_MARK", "K");
    process.env.NT_CRASH_AT = "nonsense";
    barrier("BR_DISPATCH_AFTER_MARK", "K");
    process.env.NT_CRASH_AT = "BR_NOT_A_BARRIER:1";
    barrier("BR_DISPATCH_AFTER_MARK", "K");
    expect(fired).toBe(0);
  });

  it("NAME:2 fires on the second arrival only, and only at that name; NT_CRASH_AT is read at call time", () => {
    let fired = 0;
    __setBarrierFireForTests(() => fired++);
    process.env.NT_CRASH_AT = "BR_DISPATCH_AFTER_MARK:2";
    barrier("BR_SETTLE_IN_TXN", "K");
    barrier("BR_DISPATCH_AFTER_MARK", "A");
    expect(fired).toBe(0);
    barrier("BR_DISPATCH_AFTER_MARK", "B");
    expect(fired).toBe(1);
    barrier("BR_DISPATCH_AFTER_MARK", "C");
    expect(fired).toBe(1);
  });

  it("NAME@effect_key fires only for that key", () => {
    let fired = 0;
    __setBarrierFireForTests(() => fired++);
    process.env.NT_CRASH_AT = "BR_SETTLE_IN_TXN@ZT4H9X.P02.NT101-20261110.APPR_DELAY";
    barrier("BR_SETTLE_IN_TXN", "ZT4H9X.P03.NT101-20261110.APPR_DELAY");
    barrier("BR_SETTLE_IN_TXN");
    expect(fired).toBe(0);
    barrier("BR_SETTLE_IN_TXN", "ZT4H9X.P02.NT101-20261110.APPR_DELAY");
    expect(fired).toBe(1);
  });

  it("barrierAfterMs fires after the delay unless cancelled", async () => {
    let fired = 0;
    __setBarrierFireForTests(() => fired++);
    process.env.NT_CRASH_AT = "BR_DISPATCH_REQUEST_SENT@K";
    const cancel = barrierAfterMs("BR_DISPATCH_REQUEST_SENT", 20, "K");
    cancel();
    barrierAfterMs("BR_DISPATCH_REQUEST_SENT", 20, "K");
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(1);
  });

  it("firing kills the process with SIGKILL (observed in a child process)", () => {
    const barrierTs = fileURLToPath(new URL("../src/barrier.ts", import.meta.url));
    const code = `import { barrier } from ${JSON.stringify(barrierTs)}; console.log("before"); barrier("BR_DISPATCH_AFTER_MARK", "K"); console.log("after");`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, NT_CRASH_AT: "BR_DISPATCH_AFTER_MARK@K" },
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    expect(r.signal).toBe("SIGKILL");
    expect(r.stdout).toContain("before");
    expect(r.stdout).not.toContain("after");
  });
});

describe("mutation", () => {
  it("only the named mutation is active", () => {
    expect(mutation("M1")).toBe(false);
    process.env.NT_MUTATION = "M2";
    expect(mutation("M2")).toBe(true);
    for (const m of ["M1", "M3", "M4", "M5"] as const) expect(mutation(m)).toBe(false);
  });
});
