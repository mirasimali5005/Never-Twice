import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyError, loadPolicyBundle, parsePolicyBundle } from "../src/index.ts";
import { FIXTURES_DIR } from "./helpers.ts";

const dir = join(FIXTURES_DIR, "policies");

describe("E2-UNIT-09 policy loader", () => {
  it("loads and validates the two policy files", () => {
    const b = loadPolicyBundle(dir);
    expect(b.statutory._id).toBe("APPR-SOR-2019-150@2022-09-08");
    expect(b.goodwill._id).toBe("NT-GOODWILL@1");
  });
  it("rejects a version that does not exist (CLM-07a)", () => {
    expect(() => loadPolicyBundle(dir, { statutory: "APPR-SOR-2019-150@2024-12-01", goodwill: "NT-GOODWILL@1" })).toThrow(PolicyError);
    expect(() => loadPolicyBundle(dir, { statutory: "APPR-SOR-2019-150@2022-09-08", goodwill: "NT-GOODWILL@2" })).toThrow(PolicyError);
  });
  it("rejects a missing directory and a document with the wrong _id or shape", () => {
    expect(() => loadPolicyBundle(join(dir, "nowhere"))).toThrow(PolicyError);
    const stat = JSON.parse(readFileSync(join(dir, "APPR-SOR-2019-150@2022-09-08.json"), "utf8")) as Record<string, unknown>;
    const good = JSON.parse(readFileSync(join(dir, "NT-GOODWILL@1.json"), "utf8")) as Record<string, unknown>;
    expect(() => parsePolicyBundle({ ...stat, _id: "APPR-SOR-2019-150@2024-12-01" }, good)).toThrow(PolicyError);
    expect(() => parsePolicyBundle({ ...stat, refund_comp: undefined }, good)).toThrow(PolicyError);
    expect(() => parsePolicyBundle(stat, { ...good, tariff: {} })).toThrow(PolicyError);
  });
});

describe("no I/O in the rules modules", () => {
  it("compute.ts, appr.ts and goodwill.ts import no node: module and read no clock or random value", () => {
    const src = resolve(import.meta.dirname, "../src");
    for (const f of readdirSync(src).filter((n) => ["compute.ts", "appr.ts", "goodwill.ts"].includes(n))) {
      const text = readFileSync(join(src, f), "utf8");
      expect(text, f).not.toMatch(/from\s+["']node:/);
      expect(text, f).not.toMatch(/Date\.now|new Date\(\)|Math\.random|performance\.now|randomUUID/);
    }
  });
});
