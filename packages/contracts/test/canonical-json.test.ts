// A2-UNIT-04 and PAY-17: canonical JSON and the frozen-request hash.
import { describe, expect, it } from "vitest";
import { FrozenRequest, canonicalJson, hashFrozenRequest, sha256Hex } from "../src/index.ts";

describe("canonicalJson", () => {
  it("sorts keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: null, c: [2, 1] } })).toBe('{"a":{"c":[2,1],"d":null},"b":1}');
  });

  it("is independent of key insertion order", () => {
    const x = { z: true, a: "x", m: { y: [1, { q: 1, p: 2 }], b: null } };
    const y = { m: { b: null, y: [1, { p: 2, q: 1 }] }, a: "x", z: true };
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  it("sorts by UTF-16 code unit", () => {
    expect(canonicalJson({ b: 1, B: 2, _: 3, "1": 4, é: 5 })).toBe('{"1":4,"B":2,"_":3,"b":1,"é":5}');
  });

  it("escapes strings as JSON.stringify does", () => {
    expect(canonicalJson({ s: 'a"b\\c\n\u0001é' })).toBe(`{"s":${JSON.stringify('a"b\\c\n\u0001é')}}`);
  });

  it("is the identity on canonical strings through JSON.parse", () => {
    const s = '{"a":[1,"two",null,true,false,{"x":{}}],"b":[]}';
    expect(canonicalJson(JSON.parse(s))).toBe(s);
  });

  it.each([
    ["undefined", undefined],
    ["undefined field", { a: undefined }],
    ["float", { amount_minor: 412.6 }],
    ["NaN", Number.NaN],
    ["Infinity", Infinity],
    ["-0", -0],
    ["unsafe integer", 2 ** 53],
    ["bigint", 1n],
    ["Date", new Date(0)],
    ["function", () => 1],
    ["symbol", Symbol("s")],
    ["Map", new Map()],
    ["class instance", new (class Foo {})()],
    ["sparse array", [1, , 3]],
  ])("rejects %s", (_label, v) => {
    expect(() => canonicalJson(v)).toThrow();
  });

  it("rejects cycles", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => canonicalJson(a)).toThrow();
  });

  it("allows shared non-cyclic references", () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});

describe("sha256Hex", () => {
  it("matches known vectors (lowercase hex, UTF-8)", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("é"))).toBe(sha256Hex("é"));
  });

  it("gives a stable hash for a fixed vector", () => {
    expect(sha256Hex(canonicalJson({ b: 1, a: { d: null, c: [2, 1] } }))).toBe(sha256Hex('{"a":{"c":[2,1],"d":null},"b":1}'));
  });
});

describe("frozen request bytes (PAY-17)", () => {
  const K13 = {
    provider: "sim_payout",
    operation: "PAYOUT",
    account: "acct_r7k2m9qa",
    rail: "instant",
    amount_minor: 70000,
    currency: "CAD",
    payee_ref: "payee_P13",
    parent_ref: null,
    metadata: {
      nt_marker: "r7k2m9qa:KS2R9B.P13.NT880-20261110.APPR_DELAY",
      nt_effect_key: "KS2R9B.P13.NT880-20261110.APPR_DELAY",
      nt_run_id: "r7k2m9qa",
      nt_type: "APPR_DELAY",
    },
  } as const;

  // The same request, keys in another order, read from source text that carries extra whitespace.
  const reordered = JSON.parse(`{
      "metadata": { "nt_type": "APPR_DELAY", "nt_run_id": "r7k2m9qa",
                    "nt_effect_key": "KS2R9B.P13.NT880-20261110.APPR_DELAY",
                    "nt_marker": "r7k2m9qa:KS2R9B.P13.NT880-20261110.APPR_DELAY" },
      "parent_ref": null,   "payee_ref": "payee_P13", "currency": "CAD",
      "amount_minor": 70000, "rail": "instant", "account": "acct_r7k2m9qa", "operation": "PAYOUT", "provider": "sim_payout"
    }`);

  it("serialises to identical bytes and hash", () => {
    expect(canonicalJson(reordered)).toBe(canonicalJson(K13));
    expect(hashFrozenRequest(reordered)).toBe(hashFrozenRequest(K13));
    expect(hashFrozenRequest(K13)).toBe(sha256Hex(canonicalJson(K13)));
    expect(hashFrozenRequest(K13)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a float amount fails schema validation", () => {
    expect(FrozenRequest.safeParse({ ...K13, amount_minor: 700.5 }).success).toBe(false);
    expect(() => hashFrozenRequest({ ...K13, amount_minor: 700.5 })).toThrow();
  });
});
