// A2-UNIT-05 (frozen-request part): the hash changes when any field changes; the schema is strict.
import { describe, expect, it } from "vitest";
import { FrozenRequest, frozenRequestBody, hashFrozenRequest, sha256Hex, type FrozenRequest as FR } from "../src/index.ts";

const base: FR = {
  provider: "sim_payout",
  operation: "PAYOUT",
  account: "acct_r7k2m9qa",
  rail: "instant",
  amount_minor: 70000,
  currency: "CAD",
  payee_ref: "payee_P02",
  parent_ref: null,
  metadata: {
    nt_marker: "r7k2m9qa:ZT4H9X.P02.NT101-20261110.APPR_DELAY",
    nt_effect_key: "ZT4H9X.P02.NT101-20261110.APPR_DELAY",
    nt_run_id: "r7k2m9qa",
    nt_type: "APPR_DELAY",
  },
};

describe("FrozenRequest", () => {
  it("parses the canonical example", () => {
    expect(FrozenRequest.parse(base)).toEqual(base);
  });

  it("the hash changes when any field changes", () => {
    const h = hashFrozenRequest(base);
    const variants: FR[] = [
      { ...base, provider: "sim_keyless" },
      { ...base, operation: "REFUND" },
      { ...base, account: "acct_r0000000" },
      { ...base, rail: "legacy" },
      { ...base, rail: null },
      { ...base, amount_minor: 70001 },
      { ...base, payee_ref: "payee_P03" },
      { ...base, parent_ref: "pi_123" },
      { ...base, metadata: { ...base.metadata, nt_marker: "r7k2m9qa:X" } },
      { ...base, metadata: { ...base.metadata, nt_effect_key: "X" } },
      { ...base, metadata: { ...base.metadata, nt_run_id: "r0000000" } },
      { ...base, metadata: { ...base.metadata, nt_type: "GOODWILL" } },
    ];
    const hashes = new Set(variants.map(hashFrozenRequest));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(h)).toBe(false);
  });

  it("body hash equals frozen_request_sha256 (one hash)", () => {
    expect(sha256Hex(frozenRequestBody(base))).toBe(hashFrozenRequest(base));
  });

  it.each([
    ["extra top-level field", { ...base, extra: 1 }],
    ["extra metadata field", { ...base, metadata: { ...base.metadata, nt_extra: "x" } }],
    ["USD", { ...base, currency: "USD" }],
    ["zero amount", { ...base, amount_minor: 0 }],
    ["float amount", { ...base, amount_minor: 700.5 }],
    ["unknown provider", { ...base, provider: "paypal" }],
    ["missing parent_ref", (({ parent_ref: _p, ...rest }) => rest)(base)],
  ])("rejects %s", (_label, v) => {
    expect(FrozenRequest.safeParse(v).success).toBe(false);
  });
});
