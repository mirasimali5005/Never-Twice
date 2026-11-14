// F2-UNIT-11..14 and EVL-11/EVL-15 through the real CLI as a child process, against a stub simulator.
// Exit codes: 0 pass, 1 fail, 2 error (no certificate; stale certificate removed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubSim, simObj } from "./fixtures/stub-sim.ts";
import { EVAL_DIR, K, opsRecordPath } from "./fixtures/synthetic.ts";

const CLI = join(EVAL_DIR, "src", "cli.ts");
const RUN = "r7k2m9qa";
const GROUP = "gclitst1";
const ACCT = `acct_${RUN}`;
let sim: Awaited<ReturnType<typeof stubSim>>;
let out: string;

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? (err as { code?: number }).code ?? -1 : 0, stdout, stderr });
    });
  });
}

const ledger = [
  simObj(ACCT, "po_11", K.P11, 90000, "payee_P11"),
  simObj(ACCT, "po_13", K.P13, 70000, "payee_P13"),
  simObj(ACCT, "po_02", K.P02, 70000, "payee_P02"),
  simObj(ACCT, "po_03", K.P03C, 40000, "payee_P03"),
  { ...simObj(ACCT, "rf_03", K.P03R, 41260, "payee_P03"), kind: "refund" },
];

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const paid = ledger.map((o) => {
    const key = (o.metadata as Record<string, string>).nt_effect_key;
    return { effect_key: key, marker: `${RUN}:${key}`, amount_minor: o.amount_minor, currency: "CAD", payee_ref: o.payee_ref,
      provider: key === K.P11 ? "sim_keyless" : "sim_payout", provider_object_id: o.id };
  });
  return { run_id: RUN, group_id: GROUP, arm: "nt", scenario: "S0", generated_at: "2026-11-14T18:02:20.511Z", complete: true, paid,
    refused: [{ effect_key: K.P04, reason_code: "DELAY_UNDER_3H", rule_citation: "s. 19(1)" }],
    parked: [], awaiting_budget: [], failed_no_effect: [], unresolved: [], ...overrides };
}

function writeReport(r: Record<string, unknown>): string {
  const p = join(out, `report-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(r));
  return p;
}

const envOk = () => ({ EVAL_SIM_URL: sim.url, EVAL_SIM_READ_KEY: "evalread" });
const common = () => ["--out-dir", out, "--ops-record", opsRecordPath("S0")];

before(async () => {
  sim = await stubSim(ledger, "evalread", 2);
  out = mkdtempSync(join(tmpdir(), "nt-eval-cli-"));
  const m = await cli(["manifest", "--scenario", "S0", "--group", GROUP, ...common()]);
  assert.equal(m.code, 0, m.stderr);
});
after(async () => { await sim.close(); });

test("clean run: exit 0, certificate JSON and text written, group found through the report", async () => {
  const r = await cli(["check", "--run", RUN, "--report", writeReport(report()), ...common()], envOk());
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /SAFETY: PASS/);
  const cert = JSON.parse(readFileSync(join(out, `${RUN}.certificate.json`), "utf8"));
  assert.equal(cert.safety, "PASS");
  assert.equal(cert.group_id, GROUP);
  assert.equal(cert.ledger.sim_objects, 5);
  assert.equal(cert.ledger.stripe_objects, null);
  assert.deepEqual(cert.completion.owed_paid, [5, 5]);
  assert.ok(existsSync(join(out, `${RUN}.certificate.txt`)));
});

test("phantom in the report: exit 1 with C5", async () => {
  const rep = report();
  (rep.paid as Record<string, unknown>[])[1].provider_object_id = "MUTANT_NO_EVIDENCE";
  const r = await cli(["check", "--run", RUN, "--report", writeReport(rep), ...common()], envOk());
  assert.equal(r.code, 1);
  assert.match(r.stdout, /SAFETY: FAIL/);
  const cert = JSON.parse(readFileSync(join(out, `${RUN}.certificate.json`), "utf8"));
  assert.equal(cert.checks.C5.status, "FAIL");
});

test("--expect-hash mismatch: exit 1 with C10", async () => {
  const r = await cli(["check", "--run", RUN, "--report", writeReport(report()), "--expect-hash", "0".repeat(64), ...common()], envOk());
  assert.equal(r.code, 1);
  assert.match(r.stdout, /C10/);
});

test("errors exit 2 and remove the stale certificate: missing report, no group_id, key in two lists, run mismatch", async () => {
  const cases: string[][] = [
    ["--report", join(out, "does-not-exist.json")],
    ["--report", writeReport((() => { const r = report(); delete r.group_id; return r; })())],
    ["--report", writeReport(report({ unresolved: [{ effect_key: K.P02, state: "OUTCOME_UNKNOWN" }] }))],
    ["--report", writeReport(report({ run_id: "r0000000" }))],
  ];
  for (const extra of cases) {
    const ok = await cli(["check", "--run", RUN, "--report", writeReport(report()), ...common()], envOk());
    assert.equal(ok.code, 0);
    assert.ok(existsSync(join(out, `${RUN}.certificate.json`)));
    const r = await cli(["check", "--run", RUN, ...extra, ...common()], envOk());
    assert.equal(r.code, 2, `${extra.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(existsSync(join(out, `${RUN}.certificate.json`)), false);
    assert.equal(existsSync(join(out, `${RUN}.certificate.txt`)), false);
    assert.doesNotMatch(r.stdout, /SAFETY: PASS/);
  }
});

test("report names a group with no manifest: exit 2 (EVL-11 third case)", async () => {
  const r = await cli(["check", "--run", RUN, "--report", writeReport(report({ group_id: "gnomanif" })), ...common()], envOk());
  assert.equal(r.code, 2);
});

test("unreachable ledger and missing EVAL_SIM_* are errors, never passes", async () => {
  const a = await cli(["check", "--run", RUN, "--report", writeReport(report()), ...common()], { EVAL_SIM_URL: "http://127.0.0.1:9", EVAL_SIM_READ_KEY: "x" });
  assert.equal(a.code, 2);
  const b = await cli(["check", "--run", RUN, "--report", writeReport(report()), ...common()], {});
  assert.equal(b.code, 2);
});

test("a stripe_refund payment in the report without a Stripe reader is an error (F4 pending)", async () => {
  const rep = report();
  (rep.paid as Record<string, unknown>[])[4].provider = "stripe_refund";
  const r = await cli(["check", "--run", RUN, "--report", writeReport(rep), ...common()], { ...envOk(), EVAL_STRIPE_KEY: "rk_test_dummy" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /F4/);
});

test("manifest edited after commitment, and commitment deleted: exit 1 with C10 (EVL-11)", async () => {
  const mPath = join(out, `${GROUP}.manifest.json`);
  const cPath = join(out, `${GROUP}.commitment.json`);
  const original = readFileSync(mPath, "utf8");
  const commitment = readFileSync(cPath, "utf8");
  try {
    writeFileSync(mPath, original.replace('"amount_minor":70000', '"amount_minor":100000'));
    const a = await cli(["check", "--run", RUN, "--report", writeReport(report()), ...common()], envOk());
    assert.equal(a.code, 1);
    const certA = JSON.parse(readFileSync(join(out, `${RUN}.certificate.json`), "utf8"));
    assert.equal(certA.checks.C10.status, "FAIL");
    writeFileSync(mPath, original);
    rmSync(cPath);
    const b = await cli(["check", "--run", RUN, "--report", writeReport(report()), ...common()], envOk());
    assert.equal(b.code, 1);
    const certB = JSON.parse(readFileSync(join(out, `${RUN}.certificate.json`), "utf8"));
    assert.equal(certB.checks.C10.status, "FAIL");
    assert.equal(certB.commitment_sha256, null);
  } finally {
    writeFileSync(mPath, original);
    writeFileSync(cPath, commitment);
  }
});
