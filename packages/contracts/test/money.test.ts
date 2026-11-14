// A2-UNIT-02: money helpers.
import { describe, expect, it } from "vitest";
import { Minor, assertMinor, formatCad, formatMinor, parseCad, toMinor } from "../src/index.ts";

describe("money", () => {
  it("parses decimal strings by string arithmetic", () => {
    expect(parseCad("412.60")).toBe(41260);
    expect(parseCad("700.00")).toBe(70000);
    expect(parseCad("0.07")).toBe(7);
    expect(parseCad("0")).toBe(0);
    expect(toMinor("1000")).toBe(100000);
  });

  it("formats minor units", () => {
    expect(formatCad(70000)).toBe("700.00");
    expect(formatCad(41260)).toBe("412.60");
    expect(formatCad(7)).toBe("0.07");
    expect(formatCad(0)).toBe("0.00");
    expect(formatMinor(100000)).toBe("1000.00");
  });

  it("round-trips", () => {
    for (const n of [0, 1, 9, 10, 99, 100, 12500, 41260, 240000, 9007199254740991]) expect(parseCad(formatCad(n))).toBe(n);
    for (const s of ["0.00", "0.01", "412.60", "1000.00"]) expect(formatCad(parseCad(s))).toBe(s);
  });

  it.each(["412.6", "412.600", "-1.00", "1,000.00", "1 000.00", "+5", "01.00", ".50", "5.", "1e3", "", " 1.00", "NaN", "12.3a"])(
    "rejects %j",
    (s) => {
      expect(() => parseCad(s)).toThrow();
    },
  );

  it("rejects floats and negatives in formatCad and assertMinor", () => {
    for (const bad of [412.6, -1, Number.NaN, Infinity, -0, 2 ** 53]) {
      expect(() => formatCad(bad)).toThrow();
      expect(() => assertMinor(bad)).toThrow();
    }
    expect(() => assertMinor("100")).toThrow();
    expect(() => assertMinor(100)).not.toThrow();
  });

  it("Minor schema accepts only safe integers", () => {
    expect(Minor.safeParse(70000).success).toBe(true);
    expect(Minor.safeParse(412.6).success).toBe(false);
    expect(Minor.safeParse(2 ** 53).success).toBe(false);
  });
});
