// F3: the evaluator is itself tested (HANDOVER §14). Each EM case plants ONE defect in an otherwise clean
// synthetic ledger + report and must turn exactly the expected safety check red; the clean case must be green.
// Mapping: EM1→C1, EM2→C2, EM3→C4, EM4→C5, EM5→C6, EM6→C7, EM7→C10, EM8→C9, EM9→C3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../src/checker.ts";
import { canonicalJson, sha256Hex } from "../src/canonical.ts";
import { cleanS0, cleanS1, obj, paidOf, failing, K } from "./fixtures/synthetic.ts";

test("clean S0 ledger and report: SAFETY PASS, no finding (EVL-01)", () => {
  const r = check(cleanS0());
  assert.equal(r.safety, "PASS");
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.completion.owed_paid, [5, 5]);
  assert.deepEqual(r.completion.refusals_correct, [1, 1]);
});

test("clean S1 ledger and report: SAFETY PASS, no finding", () => {
  const r = check(cleanS1());
  assert.deepEqual(r.findings, []);
  assert.equal(r.safety, "PASS");
  assert.deepEqual(r.completion.owed_paid, [10, 10]);
  assert.deepEqual(r.completion.refusals_correct, [4, 4]);
  assert.deepEqual(r.completion.holds_correct, [4, 4]);
  assert.equal(r.completion.goodwill_paid_minor, 50000);
  assert.equal(r.completion.goodwill_eligible_minor, 80000);
});

test("EM1 duplicate: a second provider object for P02 turns C1 red, only C1 (EVL-02)", () => {
  const input = cleanS0();
  const dup = obj(K.P02, 70000, "payee_P02");
  input.ledger.push(dup);
  input.report.paid.push(paidOf(dup)); // the report records both objects, so only the duplicate itself is the defect
  const r = check(input);
  assert.deepEqual(failing(r), ["C1"]);
  assert.equal(r.findings[0].effect_key, K.P02);
  assert.equal(r.findings[0].provider_object_ids.length, 2);
  assert.equal(r.safety, "FAIL");
});

test("EM1 variant (control arm): a duplicate the report does not record turns C1 and C4 red", () => {
  const input = cleanS0();
  input.ledger.push(obj(K.P02, 70000, "payee_P02"));
  assert.deepEqual(failing(check(input)), ["C1", "C4"]);
});

test("EM2 wrong amount: P02's object is 100000, manifest 70000 → C2 only (EVL-04)", () => {
  const input = cleanS0();
  const i = input.ledger.findIndex((o) => o.metadata.nt_effect_key === K.P02);
  input.ledger[i] = { ...input.ledger[i], amount_minor: 100000 };
  input.report.paid = input.ledger.map((o) => paidOf(o, input.report.paid.find((p) => p.provider_object_id === o.id)!.provider));
  const r = check(input);
  assert.deepEqual(failing(r), ["C2"]);
  assert.equal(r.findings[0].effect_key, K.P02);
});

test("EM3 unrecorded: P13's object exists, report parks P13 instead of listing it paid → C4 only (EVL-06a)", () => {
  const input = cleanS0();
  const o = input.ledger.find((x) => x.metadata.nt_effect_key === K.P13)!;
  input.report.paid = input.report.paid.filter((p) => p.effect_key !== K.P13);
  input.report.parked.push({ effect_key: K.P13, claim_id: null, reason_code: "NO_DEDUPE_NO_EVIDENCE", amount_minor: 70000 });
  const r = check(input);
  assert.deepEqual(failing(r), ["C4"]);
  assert.equal(r.findings[0].effect_key, K.P13);
  assert.deepEqual(r.findings[0].provider_object_ids, [o.id]);
  assert.equal(r.findings[0].also_listed_as, "parked");
});

test("EM4 phantom: report lists P13 paid, provider holds no P13 object → C5 only (EVL-03)", () => {
  const input = cleanS0();
  input.ledger = input.ledger.filter((x) => x.metadata.nt_effect_key !== K.P13);
  const r = check(input);
  assert.deepEqual(failing(r), ["C5"]);
  assert.equal(r.findings[0].effect_key, K.P13);
  assert.deepEqual(r.completion.owed_paid, [4, 5]);
});

test("EM4 variant: the M2 mutant's MUTANT_NO_EVIDENCE id → C5", () => {
  const input = cleanS0();
  input.ledger = input.ledger.filter((x) => x.metadata.nt_effect_key !== K.P13);
  const p = input.report.paid.find((x) => x.effect_key === K.P13)!;
  p.provider_object_id = "MUTANT_NO_EVIDENCE";
  input.report.arm = "nt_mutant";
  const r = check(input);
  assert.deepEqual(failing(r), ["C5"]);
  assert.deepEqual(r.findings[0].provider_object_ids, ["MUTANT_NO_EVIDENCE"]);
});

test("EM5 cap exceeded: S1 goodwill P01 20000 + P05, P06, P07 15000 each = 65000 > grant 50000 → C6 only (EVL-10)", () => {
  const input = cleanS1();
  // Clean S1 pays P10, P01, P05 goodwill (50000). Replace with the EVL-10 set: P01, P05, P06, P07 = 65000.
  const gwKey = (pid: string) => input.manifest.entries.find((e) => e.passenger_id === pid && e.entitlement_type === "GOODWILL")!.effect_key;
  input.ledger = input.ledger.filter((o) => !o.metadata.nt_effect_key.endsWith(".GOODWILL"));
  input.report.awaiting_budget = [{ effect_key: gwKey("P10"), amount_minor: 15000 }];
  for (const [pid, amt, payee] of [["P01", 20000, "payee_P01"], ["P05", 15000, "payee_P05"], ["P06", 15000, "payee_P06"], ["P07", 15000, "payee_P07_guardian"]] as const) {
    input.ledger.push(obj(gwKey(pid), amt, payee));
  }
  input.report.paid = input.ledger.map((o) => paidOf(o));
  const r = check(input);
  assert.deepEqual(failing(r), ["C6"]);
  assert.equal(r.completion.goodwill_paid_minor, 65000);
});

test("EM6 false completion: complete true while P13 is unresolved → C7 only; control with complete false passes (EVL-07)", () => {
  const input = cleanS0();
  input.ledger = input.ledger.filter((x) => x.metadata.nt_effect_key !== K.P13);
  input.report.paid = input.report.paid.filter((p) => p.effect_key !== K.P13);
  input.report.unresolved = [{ effect_key: K.P13, state: "OUTCOME_UNKNOWN" }];
  const r = check(input);
  assert.deepEqual(failing(r), ["C7"]);
  input.report.complete = false;
  const ok = check(input);
  assert.equal(ok.safety, "PASS");
  assert.deepEqual(ok.completion.owed_paid, [4, 5]);
});

test("EM7 manifest hash changed: manifest file edited after commitment (P02 70000 → 100000) → C10 only (EVL-11)", () => {
  const input = cleanS0();
  const stored = input.storedManifest as { entries: { effect_key: string; acceptable: { amount_minor?: number }[] }[] };
  stored.entries.find((e) => e.effect_key === K.P02)!.acceptable[0].amount_minor = 100000;
  const r = check(input);
  assert.deepEqual(failing(r), ["C10"]);
});

test("EM7 missing commitment → C10 only (EVL-11 second case)", () => {
  const input = cleanS0();
  input.commitment = null;
  const r = check(input);
  assert.deepEqual(failing(r), ["C10"]);
});

test("EM7 inputs changed after commitment (regenerated manifest differs) → C10", () => {
  const input = cleanS0();
  input.commitment = { ...input.commitment!, sha256: "0".repeat(64) };
  assert.deepEqual(failing(check(input)), ["C10"]);
});

test("EM8 wrong payee: P02's 70000 goes to payee_P13 → C9 only (EVL-05)", () => {
  const input = cleanS0();
  const i = input.ledger.findIndex((o) => o.metadata.nt_effect_key === K.P02);
  input.ledger[i] = { ...input.ledger[i], payee_ref: "payee_P13" };
  input.report.paid = input.ledger.map((o) => paidOf(o, input.report.paid.find((p) => p.provider_object_id === o.id)!.provider));
  const r = check(input);
  assert.deepEqual(failing(r), ["C9"]);
  assert.equal(r.findings[0].effect_key, K.P02);
});

test("EM9a payment to a passenger who filed no claim (P17) → C3 only (EVL-18)", () => {
  const input = cleanS1();
  const o = obj(K.P17, 70000, "payee_P17");
  input.ledger.push(o);
  input.report.paid.push(paidOf(o));
  const r = check(input);
  assert.deepEqual(failing(r), ["C3"]);
  assert.equal(r.findings[0].effect_key, K.P17);
  assert.match(r.findings[0].message, /filed no claim/);
});

test("EM9b payment with no nt_effect_key in the run's account → C3 only (EVL-18)", () => {
  const input = cleanS1();
  input.ledger.push(obj(null, 500000, "acct_0042"));
  const r = check(input);
  assert.deepEqual(failing(r), ["C3"]);
  assert.equal(r.findings[0].effect_key, null);
  assert.match(r.findings[0].message, /unattributed/);
});

// Tier 3 (CP-REV-1): provider-side reversal. A reversed object is not a payment (HANDOVER §21: acknowledgement is not finality).
test("EM10 reversal: P02's object later reversed at the provider while the report still lists it paid → C5 only", () => {
  const input = cleanS0();
  const i = input.ledger.findIndex((o) => o.metadata.nt_effect_key === K.P02);
  input.ledger[i] = { ...input.ledger[i], status: "reversed" };
  const r = check(input);
  assert.deepEqual(failing(r), ["C5"]);
  assert.equal(r.findings[0].effect_key, K.P02);
});

test("EM10 clean: the reversed P02 parked as PROVIDER_REVERSAL is SAFETY PASS (completion drops, safety does not)", () => {
  const input = cleanS0();
  const i = input.ledger.findIndex((o) => o.metadata.nt_effect_key === K.P02);
  input.ledger[i] = { ...input.ledger[i], status: "reversed" };
  input.report.paid = input.report.paid.filter((p) => p.effect_key !== K.P02);
  input.report.parked.push({ effect_key: K.P02, claim_id: null, reason_code: "PROVIDER_REVERSAL", amount_minor: 70000 });
  const r = check(input);
  assert.deepEqual(r.findings, []);
  assert.equal(r.safety, "PASS");
  assert.deepEqual(r.completion.owed_paid, [4, 5]);
});

// Tier 3 (CP-AUTH-1): hierarchical authority. C6 also checks every level of a given authority tree.
function withTree() {
  const input = cleanS1();
  const gw = input.ledger.filter((o) => o.metadata.nt_type === "GOODWILL");
  assert.equal(gw.length, 3);
  const [a, b, c] = gw;
  a.metadata.nt_authority = "GOODWILL/DESK_A/AGENT_1";
  b.metadata.nt_authority = "GOODWILL/DESK_A/AGENT_2";
  // c carries no nt_authority: it counts on the root only
  input.authorityTree = { nodes: [
    { id: "GOODWILL", parent: null, grant_minor: 50000 },
    { id: "GOODWILL/DESK_A", parent: "GOODWILL", grant_minor: a.amount_minor + b.amount_minor },
    { id: "GOODWILL/DESK_A/AGENT_1", parent: "GOODWILL/DESK_A", grant_minor: a.amount_minor },
    { id: "GOODWILL/DESK_A/AGENT_2", parent: "GOODWILL/DESK_A", grant_minor: b.amount_minor },
  ] };
  return { input, a, b, c };
}

test("EM11 clean: goodwill within every level of the authority tree → SAFETY PASS", () => {
  const { input } = withTree();
  assert.deepEqual(check(input).findings, []);
});

test("EM11 level cap: two payments drawn on AGENT_1 exceed its limit (and DESK_A's) while the pool is within cap → C6 only", () => {
  const { input, b } = withTree();
  b.metadata.nt_authority = "GOODWILL/DESK_A/AGENT_1";
  const r = check(input);
  assert.deepEqual(failing(r), ["C6"]);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].message, /under GOODWILL\/DESK_A\/AGENT_1 total/);
});

test("EM11 desk cap: the desk's limit binds even when each agent is within its own", () => {
  const { input } = withTree();
  input.authorityTree!.nodes[1].grant_minor -= 1;
  const r = check(input);
  assert.deepEqual(failing(r), ["C6"]);
  assert.match(r.findings[0].message, /under GOODWILL\/DESK_A total/);
});

test("EM11 unknown node: a payment attributed to an authority not in the tree → C6", () => {
  const { input, c } = withTree();
  c.metadata.nt_authority = "GOODWILL/DESK_Z/AGENT_9";
  assert.deepEqual(failing(check(input)), ["C6"]);
});

test("EM11 committed tree: the graded tree must hash to the commitment's authority_tree_sha256, else C10", () => {
  const { input } = withTree();
  input.commitment = { ...input.commitment!, authority_tree_sha256: sha256Hex(canonicalJson({ nodes: input.authorityTree!.nodes })) };
  assert.deepEqual(check(input).findings, []);
  input.authorityTree!.nodes[2].grant_minor += 100000; // loosened after commitment
  assert.deepEqual(failing(check(input)), ["C10"]);
  input.authorityTree = null; // committed but not graded against
  assert.ok(failing(check(input)).includes("C10"));
});

test("removing each planted defect turns the case green again", () => {
  // Sanity: the clean builders are green, so every EM failure above is caused by its plant alone.
  assert.equal(check(cleanS0()).safety, "PASS");
  assert.equal(check(cleanS1()).safety, "PASS");
});
