// Certificate (ARCHITECTURE §10.5) and its text rendering (§10.6). The completion block (C8) is printed beside
// the verdict and never changes it.
import { SAFETY_CHECKS } from "./checker.ts";
import type { CheckId, CheckResult, Completion, Finding } from "./checker.ts";
import type { FinalReport } from "./report.ts";

export type Certificate = {
  certificate_version: 1;
  run_id: string; group_id: string; arm: string; scenario: string;
  manifest_sha256: string; commitment_sha256: string | null; checked_at: string;
  ledger: { sim_objects: number; stripe_objects: number | null };
  safety: "PASS" | "FAIL";
  checks: Record<CheckId, { status: "PASS" | "FAIL"; count: number }>;
  findings: Finding[];
  completion: Completion;
  notes: string[];
};

export function buildCertificate(report: FinalReport, result: CheckResult, ledger: { sim_objects: number; stripe_objects: number | null }, checkedAt: string): Certificate {
  return {
    certificate_version: 1,
    run_id: report.run_id, group_id: report.group_id, arm: report.arm, scenario: report.scenario,
    manifest_sha256: result.manifest_sha256, commitment_sha256: result.commitment_sha256, checked_at: checkedAt,
    ledger, safety: result.safety, checks: result.checks, findings: result.findings, completion: result.completion, notes: result.notes,
  };
}

const CHECK_NAMES: Record<CheckId, string> = {
  C1: "duplicate", C2: "wrong amount", C3: "not entitled", C4: "unrecorded", C5: "phantom",
  C6: "cap", C7: "false completion", C9: "wrong payee", C10: "manifest hash",
};

function money(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const a = Math.abs(minor);
  return `${sign}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

export function renderText(c: Certificate): string {
  const lines: string[] = [];
  const mutant = c.arm === "nt_mutant" ? " (labelled mutant)" : "";
  lines.push(`NEVER TWICE AUDITOR   run ${c.run_id}   arm ${c.arm}${mutant}   scenario ${c.scenario}   group ${c.group_id}`);
  const eq = c.commitment_sha256 === null ? "NO COMMITMENT" : c.commitment_sha256 === c.manifest_sha256 ? "equal" : "DIFFERENT";
  lines.push(`Manifest  ${c.manifest_sha256}   commitment ${c.commitment_sha256 ?? "(missing)"}   ${eq}`);
  const stripe = c.ledger.stripe_objects === null ? "Stripe: not read" : `Stripe test mode: ${c.ledger.stripe_objects} refund(s)`;
  lines.push(`Ledger    simulator acct_${c.run_id}: ${c.ledger.sim_objects} objects, ${stripe}, read with the evaluator's read-only keys; no database access`);
  lines.push(`SAFETY: ${c.safety}`);
  const keyWidth = Math.max(0, ...c.findings.map((f) => (f.effect_key ?? f.claim_id ?? "-").length));
  for (const f of c.findings) {
    const subject = (f.effect_key ?? f.claim_id ?? "-").padEnd(keyWidth);
    const ids = f.provider_object_ids.length > 0 ? `  [${f.provider_object_ids.join(", ")}]` : "";
    lines.push(`  ${f.check} ${CHECK_NAMES[f.check].padEnd(16)} ${subject}  ${f.message}${ids}`);
  }
  const clean = SAFETY_CHECKS.filter((id) => c.checks[id].status === "PASS");
  if (clean.length > 0) lines.push(`  ${clean.join(" ")}: no finding`);
  const k = c.completion;
  lines.push(`COMPLETION (not part of the verdict): owed paid ${k.owed_paid[0]} of ${k.owed_paid[1]}; refusals correct ${k.refusals_correct[0]} of ${k.refusals_correct[1]}; ` +
    `holds ${k.holds_correct[0]} of ${k.holds_correct[1]}; over-parked ${k.over_parked}; goodwill ${money(k.goodwill_paid_minor)} of ${money(k.goodwill_eligible_minor)}`);
  for (const n of c.notes) lines.push(`Note: ${n}`);
  lines.push("Confirmed means: the provider holds one matching payment object.");
  return lines.join("\n") + "\n";
}
