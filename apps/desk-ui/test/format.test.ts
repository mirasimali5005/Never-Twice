import { describe, expect, it } from "vitest";
import { formatDelay, formatMinor, formatMoney, groupThousands, passengerOfKey } from "../src/format";

// G2-UNIT-01: money is formatted from integer cents by string operations.
describe("format", () => {
  it("formats integer cents (0, 5, 41260, 100000)", () => {
    expect(formatMinor(0)).toBe("0.00");
    expect(formatMinor(5)).toBe("0.05");
    expect(formatMinor(41260)).toBe("412.60");
    expect(formatMinor(100000)).toBe("1000.00");
    expect(formatMinor(70000)).toBe("700.00");
  });
  it("adds the dollar sign and thousands separators", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(70000)).toBe("$700.00");
    expect(formatMoney(100000)).toBe("$1,000.00");
    expect(formatMoney(311260)).toBe("$3,112.60");
    expect(groupThousands("1234567.89")).toBe("1,234,567.89");
  });
  it("refuses floats, negatives and unsafe numbers", () => {
    expect(() => formatMinor(1.5)).toThrow();
    expect(() => formatMinor(-1)).toThrow();
    expect(() => formatMinor(Number.NaN)).toThrow();
    expect(() => formatMinor(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
  it("formats delays and keys", () => {
    expect(formatDelay(532)).toBe("8 h 52");
    expect(formatDelay(null)).toBe("unknown");
    expect(passengerOfKey("ZT4H9X.P02.NT101-20261110.APPR_DELAY")).toBe("P02");
  });
});
