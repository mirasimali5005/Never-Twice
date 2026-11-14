// A2-UNIT-03 and CLM-04b: effect key (HANDOVER.md §9.1).
import { describe, expect, it } from "vitest";
import { EFFECT_KEY_RE, disruptionId, effectKey, parseEffectKey } from "../src/index.ts";

// The booking record reached by C02 and by C03 (ARCHITECTURE.md §5.1).
const bookingP02 = {
  booking_ref: "ZT4H9X",
  passenger_id: "P02",
  flight_no: "NT101",
  scheduled_departure: new Date("2026-11-10T13:15:00Z"),
};

describe("disruptionId", () => {
  it("uses the UTC calendar date of the scheduled departure", () => {
    expect(disruptionId("NT101", new Date("2026-11-10T13:15:00Z"))).toBe("NT101-20261110");
    expect(disruptionId("NT101", new Date("2026-11-10T23:59:59Z"))).toBe("NT101-20261110");
    expect(disruptionId("NT101", new Date("2026-11-11T00:00:00Z"))).toBe("NT101-20261111");
  });
  it("accepts a YYYY-MM-DD string as-is", () => {
    expect(disruptionId("NT101", "2026-11-10")).toBe("NT101-20261110");
  });
  it("rejects bad input", () => {
    expect(() => disruptionId("nt101", "2026-11-10")).toThrow();
    expect(() => disruptionId("NT 101", "2026-11-10")).toThrow();
    expect(() => disruptionId("NT101", "2026-11-1")).toThrow();
    expect(() => disruptionId("NT101", "2026-13-10")).toThrow();
    expect(() => disruptionId("NT101", new Date("nope"))).toThrow();
  });
});

describe("effectKey", () => {
  const parts = {
    booking_ref: bookingP02.booking_ref,
    passenger_id: bookingP02.passenger_id,
    disruption_id: disruptionId(bookingP02.flight_no, bookingP02.scheduled_departure),
  };

  it("builds the §9.1 example", () => {
    expect(effectKey(parts, "APPR_DELAY")).toBe("ZT4H9X.P02.NT101-20261110.APPR_DELAY");
  });

  it("gives the same key for two claims that reach the same booking record (C02, C03)", () => {
    const fromC02 = effectKey({ ...parts }, "APPR_DELAY");
    const fromC03 = effectKey({ booking_ref: "ZT4H9X", passenger_id: "P02", disruption_id: "NT101-20261110" }, "APPR_DELAY");
    expect(fromC02).toBe(fromC03);
    expect(EFFECT_KEY_RE.test(fromC02)).toBe(true);
  });

  it("gives P03 distinct keys for two entitlements", () => {
    const p03 = { booking_ref: "LM2P8D", passenger_id: "P03", disruption_id: "NT101-20261110" };
    const k03c = effectKey(p03, "APPR_REFUND_COMP");
    const k03r = effectKey(p03, "TICKET_REFUND");
    expect(k03c).toBe("LM2P8D.P03.NT101-20261110.APPR_REFUND_COMP");
    expect(k03r).toBe("LM2P8D.P03.NT101-20261110.TICKET_REFUND");
    expect(k03c).not.toBe(k03r);
  });

  it.each([
    ["lower-case booking ref", { ...parts, booking_ref: "zt4h9x" }],
    ["dot in a part", { ...parts, passenger_id: "P.02" }],
    ["empty part", { ...parts, booking_ref: "" }],
    ["space", { ...parts, booking_ref: "ZT4 H9X" }],
    ["colon", { ...parts, passenger_id: "P02:" }],
    ["unicode", { ...parts, booking_ref: "ZT4H9É" }],
  ])("rejects %s", (_label, bad) => {
    expect(() => effectKey(bad, "APPR_DELAY")).toThrow();
  });

  it("rejects an unknown entitlement type", () => {
    expect(() => effectKey(parts, "PAY_ME" as never)).toThrow();
  });

  it("parseEffectKey inverts effectKey", () => {
    const key = effectKey(parts, "GOODWILL");
    expect(parseEffectKey(key)).toEqual({ ...parts, entitlement_type: "GOODWILL" });
    expect(() => parseEffectKey("ZT4H9X.P02.NT101-20261110")).toThrow();
    expect(() => parseEffectKey("ZT4H9X.P02.NT101-20261110.NOPE")).toThrow();
    expect(() => parseEffectKey("zt4h9x.P02.NT101-20261110.APPR_DELAY")).toThrow();
  });
});
