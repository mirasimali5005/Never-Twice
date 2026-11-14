// pnpm demo:audit [--brief] [--no-report]
// Regenerates the final report of each run from MongoDB (--report-only; nothing is proposed or sent), then runs the independent auditor on
// nt_mutant, nt and control (evaluator check: its own read-only keys, no database credential), prints the three verdicts side by side, and runs
// the gateway's invariant scan (scanInvariants) on the nt run. DEMO_RUNBOOK §4, beats 9 to 11.
import { parseArgs, runMain } from "../lib/args.ts";
import { closeAll } from "../../packages/db/src/index.ts";
import { currentGroup, evaluatorCheck, reportOnlyCmd, runCmd, runOf, secs } from "./lib.ts";

type Verdict = { arm: string; label: string; runId: string; code: number | null; text: string; safety: string; findings: string; completion: string; manifest: string };

const ORDER: { arm: string; label: string }[] = [
  { arm: "nt_mutant", label: "MUTANT RUN — M2 — test of the auditor" },
  { arm: "nt", label: "Never Twice" },
  { arm: "control", label: "Ordinary agent (control)" },
];

function parse(arm: string, label: string, runId: string, code: number | null, text: string): Verdict {
  const lines = text.split("\n");
  const safety = lines.find((l) => l.startsWith("SAFETY:"))?.trim() ?? "NO CERTIFICATE (auditor error)";
  const counts = new Map<string, number>();
  for (const l of lines) {
    const m = /^\s+(C\d+)\s+[a-z]/.exec(l);
    if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  const findings = [...counts].map(([c, n]) => (n > 1 ? `${c} x${n}` : c)).join(" ") || "no findings";
  const completion = (lines.find((l) => l.startsWith("COMPLETION")) ?? "").replace(/^COMPLETION \(not part of the verdict\):\s*/, "").trim();
  const manifest = lines.find((l) => l.startsWith("Manifest")) ?? "";
  return { arm, label, runId, code, text, safety, findings, completion, manifest };
}

await runMain(async () => {
  const a = parseArgs(process.argv.slice(2), []);
  const cur = currentGroup();
  const t0 = Date.now();

  if (!a.flags.has("no-report")) {
    const reps = await Promise.all(ORDER.map((o) => runCmd({ ...reportOnlyCmd(o.arm, runOf(cur, o.arm)), quiet: true, log: `report-${o.arm}` })));
    reps.forEach((r, i) => {
      if (r.code !== 0) console.log(`warning: report-only for ${ORDER[i]!.arm} exited ${r.code}: ${r.out.trim().split("\n").pop()}`);
    });
    console.log(`final reports regenerated from MongoDB (${secs(Date.now() - t0)})`);
  }

  const results = await Promise.all(ORDER.map((o) => runCmd({ ...evaluatorCheck(runOf(cur, o.arm)), quiet: true, log: `audit-${o.arm}`, env: { ...process.env } as NodeJS.ProcessEnv })));
  const verdicts = ORDER.map((o, i) => parse(o.arm, o.label, runOf(cur, o.arm), results[i]!.code, results[i]!.out));

  console.log("");
  for (const v of verdicts) {
    if (!a.flags.has("brief")) console.log(`${v.text.trim()}\n`);
  }

  const hash = cur.manifest_sha256;
  const allEqual = verdicts.every((v) => v.manifest.includes(hash) && /equal\s*$/.test(v.manifest.trim()));
  console.log(`manifest sha256 ${hash}`);
  console.log(`matches pre-run commitment: ${allEqual ? "yes (all three certificates)" : "NO: check the certificates above"}`);
  console.log("");
  const w = Math.max(...verdicts.map((v) => v.arm.length));
  for (const v of verdicts) console.log(`${v.arm.padEnd(w)}  ${v.runId}  ${v.safety.padEnd(13)} ${v.findings.padEnd(18)} ${v.completion}${v.arm === "nt_mutant" ? "   [" + v.label + "]" : ""}`);

  // Invariant scan on the nt run (reads MongoDB through the gateway role and the provider through its read view).
  console.log("");
  try {
    const { createGatewayFromEnv } = await import("../../packages/gateway/src/index.ts");
    const runId = runOf(cur, "nt");
    const gw = await createGatewayFromEnv("reconciler", { ...process.env, NT_RUN_ID: runId, NT_ARM: "nt" } as never, { runId, workerId: "demo-audit" });
    const rep = await gw.scanInvariants(runId);
    console.log(`invariant scan (nt ${runId}): ${rep.ok ? "OK" : "VIOLATIONS"}  ${rep.intents} intents, ${rep.violations.length} violation(s)`);
    for (const x of rep.violations) console.log(`  ${x.code} ${x.intent_id ?? "-"} ${x.detail}`);
    if (!rep.ok) process.exitCode = 1;
  } catch (e) {
    console.log(`invariant scan did not run: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await closeAll().catch(() => {});
  }
  console.log(`\naudit done in ${secs(Date.now() - t0)}`);
});
