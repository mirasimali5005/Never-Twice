// F1-UNIT-03..08 (EVL-14): manifest totals for S0 and S1, acceptable lists, determinism, and the manifest command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestSha256, withGroup } from "../src/manifest.ts";
import { canonicalJson } from "../src/canonical.ts";
import { parseOpsRecord, InputError } from "../src/ops-record.ts";
import { loadManifest, opsRecordPath, EVAL_DIR, K } from "./fixtures/synthetic.ts";

const run = promisify(execFile);
const CLI = join(EVAL_DIR, "src", "cli.ts");
const REAL = (s: string) => join(EVAL_DIR, "..", "fixtures", "scenarios", s, "ops-record.json");

test("S0 totals: five payments 311260 (P02 70000, P03 40000 + 41260 refund, P11 90000, P13 70000), one refusal P04, grant 0", () => {
  const m = loadManifest("S0");
  const t = m.totals;
  assert.equal(t.payments_owed_count, 5);
  assert.equal(t.payments_owed_minor, 311260);
  assert.equal(t.statutory_owed_count, 4);
  assert.equal(t.statutory_owed_minor, 270000);
  assert.equal(t.ticket_refund_minor, 41260);
  assert.equal(t.refusals, 1);
  assert.equal(t.holds, 0);
  assert.equal(t.goodwill_grant_minor, 0);
  assert.equal(t.goodwill_eligible_minor, 0);
  const amt = (k: string) => (m.entries.find((e) => e.effect_key === k)!.acceptable[0] as { amount_minor: number }).amount_minor;
  assert.equal(amt(K.P02), 70000);
  assert.equal(amt(K.P03C), 40000);
  assert.equal(amt(K.P03R), 41260);
  assert.equal(amt(K.P11), 90000);
  assert.equal(amt(K.P13), 70000);
  assert.deepEqual(m.entries.find((e) => e.effect_key === K.P04)!.acceptable, [{ outcome: "REFUSE", reason: "DELAY_UNDER_3H" }]);
});

test("S1 totals: 820000 across 9 (860000 across 10 with P08), refund 41260, 4 refusals, 3 holds + C17, goodwill 80000 eligible vs 50000", () => {
  const t = loadManifest("S1").totals;
  assert.equal(t.statutory_owed_minor, 820000);
  assert.equal(t.statutory_owed_count, 9);
  assert.equal(t.statutory_owed_minor_if_alternatives_paid, 860000);
  assert.equal(t.statutory_owed_count_if_alternatives_paid, 10);
  assert.equal(t.ticket_refund_minor, 41260);
  assert.equal(t.ticket_refund_count, 1);
  assert.equal(t.refusals, 4);
  assert.equal(t.holds, 3);
  assert.equal(t.claims_without_entitlement, 1);
  assert.equal(t.unclaimed_passengers, 1);
  assert.equal(t.goodwill_eligible_minor, 80000);
  assert.equal(t.goodwill_eligible_count, 5);
  assert.equal(t.goodwill_grant_minor, 50000);
});

test("P08 has exactly two acceptable outcomes; every other entry one", () => {
  const m = loadManifest("S1");
  for (const e of m.entries) {
    if (e.effect_key === K.P08) {
      assert.deepEqual(e.acceptable, [
        { outcome: "HOLD", reason: "PAYEE_CHANGE_REQUESTED" },
        { outcome: "PAY", amount_minor: 40000, currency: "CAD", payee_ref: "payee_P08" },
      ]);
    } else {
      assert.equal(e.acceptable.length, 1, e.effect_key);
    }
  }
});

test("P17 is NO_CLAIM; C17 is a claim-level hold BOOKING_UNRESOLVED only; P07 pays the guardian payee", () => {
  const m = loadManifest("S1");
  assert.deepEqual(m.entries.find((e) => e.effect_key === K.P17)!.acceptable, [{ outcome: "NO_CLAIM" }]);
  assert.deepEqual(m.claim_level, [{ claim_id: "C17", acceptable: [{ outcome: "HOLD", reason: "BOOKING_UNRESOLVED" }] }]);
  const p07 = m.entries.find((e) => e.passenger_id === "P07" && e.entitlement_type === "APPR_DELAY")!;
  assert.deepEqual(p07.acceptable, [{ outcome: "PAY", amount_minor: 100000, currency: "CAD", payee_ref: "payee_P07_guardian" }]);
});

test("same inputs give the same hash twice; the hash does not depend on group_id; no timestamp in the manifest", () => {
  const a = loadManifest("S1", "gaaaaaaa");
  const b = loadManifest("S1", "gbbbbbbb");
  assert.equal(manifestSha256(a), manifestSha256(b));
  assert.equal(manifestSha256(a), manifestSha256(loadManifest("S1", "gaaaaaaa")));
  assert.doesNotMatch(canonicalJson(a), /T\d\d:\d\d/);
  assert.notEqual(manifestSha256(withGroup(loadManifest("S0"), "gx")), manifestSha256(a));
});

test("ops-record reader names the missing field", () => {
  const raw = JSON.parse(readFileSync(opsRecordPath("S0"), "utf8"));
  delete raw.bookings[0].passenger.refund_elected;
  assert.throws(() => parseOpsRecord(raw), (e: Error) => e instanceof InputError && /bookings\[0\]\.passenger\.refund_elected/.test(e.message));
});

test("the real A3 fixtures (if present) give the same manifest as the frozen test copies", { skip: !existsSync(REAL("S0")) }, () => {
  for (const s of ["S0", "S1"] as const) {
    if (!existsSync(REAL(s))) continue;
    const real = parseOpsRecord(JSON.parse(readFileSync(REAL(s), "utf8")));
    const frozen = parseOpsRecord(JSON.parse(readFileSync(opsRecordPath(s), "utf8")));
    assert.deepEqual(real, frozen, `${s} ops-record differs from evaluator/test/fixtures copy`);
  }
});

test("manifest command writes manifest + commitment, prints the hash, refuses to overwrite (F1-UNIT-08)", async () => {
  const out = mkdtempSync(join(tmpdir(), "nt-eval-"));
  const args = [CLI, "manifest", "--scenario", "S0", "--group", "gtest001", "--ops-record", opsRecordPath("S0"), "--out-dir", out];
  const { stdout } = await run(process.execPath, args);
  const m = /manifest sha256 ([0-9a-f]{64})/.exec(stdout);
  assert.ok(m, stdout);
  const commitment = JSON.parse(readFileSync(join(out, "gtest001.commitment.json"), "utf8"));
  assert.deepEqual(Object.keys(commitment).sort(), ["committed_at", "group_id", "sha256"]);
  assert.equal(commitment.group_id, "gtest001");
  assert.equal(commitment.sha256, m[1]);
  const stored = JSON.parse(readFileSync(join(out, "gtest001.manifest.json"), "utf8"));
  assert.equal(manifestSha256(stored), m[1]);
  assert.equal(stored.group_id, "gtest001");
  await assert.rejects(run(process.execPath, args), (e: { code: number }) => e.code === 2);
  assert.equal(JSON.parse(readFileSync(join(out, "gtest001.commitment.json"), "utf8")).sha256, m[1]);
});
