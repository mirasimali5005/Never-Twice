// Runs the auditor as a child process (never by import) and reads back the certificate it wrote (task H2; HANDOVER section 14).
// The environment holds only EVAL_* variables: no database variable, so the check also proves the auditor needs none (SEC-07).
// This file only READS evaluator/out; the evaluator is the only writer there (boundaries rule R6).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS, REPO } from "./world.ts";
import { runNode } from "./proc.ts";

export type Finding = { check: string; effect_key: string | null; claim_id: string | null; message: string; provider_object_ids: string[] };
export type Certificate = {
  run_id: string;
  group_id: string;
  arm: string;
  scenario: string;
  manifest_sha256: string;
  commitment_sha256: string | null;
  ledger: { sim_objects: number; stripe_objects: number | null };
  safety: "PASS" | "FAIL";
  checks: Record<string, { status: "PASS" | "FAIL"; count: number }>;
  findings: Finding[];
  completion: { owed_paid: [number, number]; refusals_correct: [number, number]; holds_correct: [number, number]; over_parked: number; goodwill_paid_minor: number; goodwill_eligible_minor: number };
  notes: string[];
};

export type Audit = { exitCode: number | null; text: string; certificate: Certificate };

export async function auditRun(runId: string, env: Record<string, string>): Promise<Audit> {
  const r = await runNode([PATHS.evaluator, "check", "--run", runId], env, { cwd: REPO, timeoutMs: 60_000, label: `evaluator check ${runId}` });
  const certPath = join(REPO, "evaluator", "out", `${runId}.certificate.json`);
  if (!existsSync(certPath)) throw new Error(`evaluator check ${runId} exited ${r.code} and wrote no certificate:\n${r.stdout}\n${r.stderr}`);
  return { exitCode: r.code, text: r.stdout, certificate: JSON.parse(readFileSync(certPath, "utf8")) as Certificate };
}

/** The group's pre-run commitment hash, read through the evaluator's own files (the only permitted reads: *.commitment.json). */
export function commitmentSha256(groupId: string): string {
  const p = join(REPO, "evaluator", "out", `${groupId}.commitment.json`);
  return (JSON.parse(readFileSync(p, "utf8")) as { sha256: string }).sha256;
}
