// CP-LETTER-1: decision letters are graded separately from payments (L1 duplicate, L2 phantom, L3 unreported).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeLetters, parseLetters, renderLetters } from "../src/letters.ts";
import { parseFinalReport } from "../src/report.ts";

const RUN = "r1234567";
const L = (claim: string, over: Record<string, unknown> = {}) => ({
  effect_key: `LETTER.${claim}`, claim_id: claim, marker: `${RUN}:LETTER.${claim}`, payee_ref: "payee_P02", state: "CONFIRMED", provider_object_id: `msg_${claim}`, quarantine_reason: null, ...over,
});
const M = (claim: string, id = `msg_${claim}`) => ({ id, marker: `${RUN}:LETTER.${claim}`, run_id: RUN });

test("a report without letters grades NONE and the payment parser ignores the letters field", () => {
  assert.equal(gradeLetters(RUN, [], []).status, "NONE");
  assert.deepEqual(parseLetters({}), []);
  const raw = { run_id: RUN, group_id: "g1234567", arm: "nt", scenario: "S0", generated_at: "x", complete: true, paid: [], refused: [], parked: [], awaiting_budget: [], failed_no_effect: [], unresolved: [], letters: [L("C02")] };
  assert.equal(parseFinalReport(raw).paid.length, 0); // a letter is never a payment
  assert.equal(parseLetters(raw).length, 1);
});

test("one message per confirmed letter: PASS", () => {
  const g = gradeLetters(RUN, parseLetters({ letters: [L("C02"), L("C03")] }), [M("C02"), M("C03")]);
  assert.equal(g.status, "PASS");
  assert.match(renderLetters(g), /^LETTERS \(graded separately; letters are not payments\): PASS/);
});

test("L1 duplicate, L2 phantom, L3 unreported", () => {
  assert.deepEqual(gradeLetters(RUN, [L("C02")], [M("C02"), M("C02", "msg_x")]).findings.map((f) => f.check), ["L1"]);
  assert.deepEqual(gradeLetters(RUN, [L("C02")], []).findings.map((f) => f.check), ["L2"]);
  assert.deepEqual(gradeLetters(RUN, [L("C02")], [M("C02"), M("C09")]).findings.map((f) => f.check), ["L3"]);
  assert.equal(gradeLetters(RUN, [L("C02")], [M("C02"), { id: "m", marker: "rzzzzzzz:LETTER.C1", run_id: "rzzzzzzz" }]).status, "PASS"); // other runs ignored
});

test("a quarantined letter with a message is a note, not a failure (the system refused to guess)", () => {
  const g = gradeLetters(RUN, [L("C04", { state: "QUARANTINED", provider_object_id: null, quarantine_reason: "PROBE_NOT_ADMITTED" })], [M("C04")]);
  assert.equal(g.status, "PASS");
  assert.equal(g.notes.length, 1);
});

test("a malformed letters list is a report error", () => {
  assert.throws(() => parseLetters({ letters: [{ effect_key: 1 }] }), /letters\[0\]/);
});
