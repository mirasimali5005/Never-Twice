// H1-UNIT-03: the terminal renderer maps states to the three colours and renders the mock group; go file and arg parsing.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../lib/args.ts";
import { KILL_TARGETS, writeGoFile } from "../lib/state.ts";
import { classify, mockSnapshot, render, stateStyle, visibleLength } from "../lib/tty-render.ts";

describe("tty renderer", () => {
  it("maps payment states to three colours", () => {
    const row = (state: string | null, n: number | null = 1) => ({ effect_key: "A.P02.F-1.APPR_DELAY", state, amount_minor: 1, provider_count: n });
    expect(stateStyle(classify(row("CONFIRMED"))).colour).toBe("green");
    expect(stateStyle(classify(row("OUTCOME_UNKNOWN"))).colour).toBe("amber");
    expect(stateStyle(classify(row("DISPATCHING"))).colour).toBe("amber");
    expect(stateStyle(classify(row("QUARANTINED"))).colour).toBe("blue");
    expect(classify(row(null, 2))).toBe("DUPLICATE");
  });
  it("renders the mock group in both colour modes without throwing, in two columns", () => {
    const plain = render(mockSnapshot(), { width: 120, color: false });
    expect(plain).toContain("ORDINARY AGENT (control)");
    expect(plain).toContain("PAID TWICE");
    expect(plain).toContain("Needs a person");
    expect(plain).toContain("SAFETY: PASS");
    expect(plain).toContain("MUTANT RUN — M2");
    expect(plain).not.toContain("\u001b");
    const coloured = render(mockSnapshot(), { width: 100, color: true });
    expect(coloured).toContain("\u001b[");
    expect(visibleLength(coloured)).toBeGreaterThan(0);
  });
});

describe("go file and arguments", () => {
  it("writes {kill_at_passenger} and only valid targets exist per scenario", () => {
    const dir = mkdtempSync(join(tmpdir(), "nt-go-"));
    try {
      const p = writeGoFile(dir, "gq4w8n2c", "P02");
      expect(p.endsWith("go-gq4w8n2c.json")).toBe(true);
      expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ kill_at_passenger: "P02" });
      expect(KILL_TARGETS.S0).toEqual(["P02"]);
      expect(KILL_TARGETS.S1).toContain("P07");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("ignores pnpm's bare -- and parses values and flags", () => {
    const a = parseArgs(["--", "--scenario", "S0", "--arms=nt,control", "--once"], ["scenario", "arms"]);
    expect(a.values.get("scenario")).toBe("S0");
    expect(a.values.get("arms")).toBe("nt,control");
    expect(a.flags.has("once")).toBe(true);
  });
});
