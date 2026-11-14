// F1-UNIT-02: canonical JSON is key-order independent; SHA-256 through node:crypto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/canonical.ts";

test("canonical JSON sorts keys at every level and has no whitespace", () => {
  const a = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, e: "x" };
  const b = { e: "x", a: { c: null, d: [3, { y: 2, z: 1 }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1,"e":"x"}');
});

test("arrays keep their order; non-finite numbers are rejected", () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.throws(() => canonicalJson({ a: Number.NaN }));
});

test("sha256Hex", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
