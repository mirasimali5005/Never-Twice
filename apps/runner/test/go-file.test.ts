import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crashSpecFor, goFilePath, parseGoFile, waitForGoFile } from "../src/go-file.ts";

const ob = (passenger_id: string, entitlement_type: string, status = "OWED", key?: string) => ({
  effect_key: key ?? `REF.${passenger_id}.NT101-20261110.${entitlement_type}`,
  passenger_id,
  entitlement_type: entitlement_type as "APPR_DELAY",
  status: status as "OWED",
});

describe("go file", () => {
  it("is .nt/go-<group_id>.json under the repository root", () => {
    expect(goFilePath("/repo", "g4x8p2nd")).toBe("/repo/.nt/go-g4x8p2nd.json");
  });

  it("parses kill_at_passenger and ignores anything else; a non-object is an error", () => {
    expect(parseGoFile('{"kill_at_passenger":"P05"}')).toEqual({ kill_at_passenger: "P05" });
    expect(parseGoFile("{}")).toEqual({});
    expect(parseGoFile('{"kill_at_passenger":5}')).toEqual({});
    expect(() => parseGoFile("[]")).toThrow();
    expect(() => parseGoFile("not json")).toThrow();
  });

  it("E4-UNIT-04: translates to BR_DISPATCH_RESPONSE_RECEIVED@<statutory effect key> for nt, CTRL_AFTER_PROVIDER_RESPONSE@ for control", () => {
    const obs = [ob("P03", "TICKET_REFUND"), ob("P03", "APPR_REFUND_COMP"), ob("P05", "GOODWILL"), ob("P05", "APPR_DELAY"), ob("P04", "APPR_DELAY", "NOT_OWED"), ob("P08", "APPR_DELAY", "HELD")];
    expect(crashSpecFor("nt", "P05", obs)).toBe("BR_DISPATCH_RESPONSE_RECEIVED@REF.P05.NT101-20261110.APPR_DELAY");
    expect(crashSpecFor("nt_mutant", "P03", obs)).toBe("BR_DISPATCH_RESPONSE_RECEIVED@REF.P03.NT101-20261110.APPR_REFUND_COMP");
    expect(crashSpecFor("control", "P05", obs)).toBe("CTRL_AFTER_PROVIDER_RESPONSE@REF.P05.NT101-20261110.APPR_DELAY");
    // no owed statutory obligation: refusal, hold, goodwill only, unknown passenger
    expect(crashSpecFor("nt", "P04", obs)).toBeNull();
    expect(crashSpecFor("nt", "P08", obs)).toBeNull();
    expect(crashSpecFor("nt", "P99", obs)).toBeNull();
    expect(crashSpecFor("nt", "P05", [ob("P05", "GOODWILL")])).toBeNull();
  });

  it("waitForGoFile returns at once when the file exists, and polls until it appears or a half-written file parses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nt-go-"));
    const path = join(dir, "go.json");
    let polls = 0;
    const sleep = async () => {
      polls++;
      if (polls === 2) writeFileSync(path, '{"kill_at_p'); // half written
      if (polls === 3) writeFileSync(path, '{"kill_at_passenger":"P02"}');
    };
    expect(await waitForGoFile(path, { pollMs: 1, sleep })).toEqual({ kill_at_passenger: "P02" });
    expect(polls).toBe(3);
    expect(await waitForGoFile(path, { pollMs: 1, sleep })).toEqual({ kill_at_passenger: "P02" });
    expect(polls).toBe(3);
    await expect(waitForGoFile(join(dir, "never.json"), { pollMs: 1, timeoutMs: 5 })).rejects.toThrow(/timed out/);
  });
});
