// pnpm demo:resume [--investigator deterministic]
// After the kill: restart the killed runners on the same run ids (no NT_CRASH_AT, no pause), run the reconciler --until-drained for nt and
// nt_mutant, wait for the runners to finish their pass, then regenerate the final reports of all three runs (--report-only).
// DEMO_RUNBOOK §4. The mutant's M2 is set on its runner only: the reconciler refuses NT_MUTATION (NT_ARM is not nt_mutant there).
import { isAlive, listPids, removePid } from "../lib/proc.ts";
import { parseArgs, runMain, UsageError } from "../lib/args.ts";
import { NT_DIR } from "../lib/paths.ts";
import { childEnv, currentGroup, hasReport, reconcileCmd, reportOnlyCmd, runCmd, runnerCmd, runOf, secs } from "./lib.ts";

const ARMS = ["nt", "control", "nt_mutant"] as const;

await runMain(async () => {
  const a = parseArgs(process.argv.slice(2), ["investigator"]);
  const inv = a.values.get("investigator");
  if (inv !== undefined && inv !== "deterministic" && inv !== "llm") throw new UsageError("--investigator deterministic|llm");
  const cur = currentGroup();
  const t0 = Date.now();
  const pids = listPids(NT_DIR);

  // 1. Restart every runner whose process is gone without a final report (the killed ones), same run id, no kill, no pause.
  const runnerEnv = (arm: string, runId: string) =>
    childEnv({ NT_MODEL_MODE: "replay", NT_MODEL_BACKEND: process.env.NT_MODEL_BACKEND || "cli", NT_RUN_ID: runId, NT_ARM: arm, ...(arm === "nt_mutant" ? { NT_MUTATION: "M2" } : {}) });
  const runners: Promise<unknown>[] = [];
  const restarted: string[] = [];
  for (const arm of ARMS) {
    const runId = runOf(cur, arm);
    const p = pids.find((x) => x.name === `runner-${arm}`);
    if (p && isAlive(p.pid)) {
      console.log(`runner-${arm}: still running (pid ${p.pid}); not restarted`);
      continue;
    }
    if (hasReport(runId)) {
      console.log(`runner-${arm}: finished its pass already (final report exists); not restarted`);
      continue;
    }
    removePid(NT_DIR, `runner-${arm}`);
    restarted.push(arm);
    console.log(`runner-${arm}: restarted on ${runId} (no NT_CRASH_AT)`);
    const c = runnerCmd(runId, ["--arm", arm]);
    runners.push(runCmd({ ...c, env: runnerEnv(arm, runId), prefix: `[${arm.padEnd(9)}]`, log: `runner-${arm}`, filter: (l) => /dispatch|attempt|ACCEPTED|INDETERMINATE|duplicate|complete|report|adopt|resum/i.test(l) }));
  }
  if (restarted.length === 0) console.log("no runner needed a restart");

  // 2. Reconcilers (nt and nt_mutant) until drained, live investigation unless forced.
  const reconEnv = childEnv({ NT_MODEL_MODE: "live", NT_MODEL_BACKEND: process.env.NT_MODEL_BACKEND || "cli", ...(inv === "deterministic" ? { NT_RECONCILER_INVESTIGATOR: "deterministic" } : {}) });
  const recon = (["nt", "nt_mutant"] as const).map((arm) =>
    runCmd({ ...reconcileCmd(runOf(cur, arm), ["--until-drained"]), env: reconEnv, prefix: `[recon ${arm}]`.padEnd(18), log: `reconciler-${arm}` }).then((r) => {
      console.log(`reconciler ${arm}: exit ${r.code} after ${secs(r.ms)}`);
      return r;
    }),
  );
  const results = await Promise.all([...runners, ...recon]);
  const bad = (results as { code: number | null }[]).filter((r) => r.code !== 0 && r.code !== null);
  if (bad.length) console.log(`warning: ${bad.length} process(es) exited non-zero; see out/logs/`);

  // 3. Final reports for all three runs.
  for (const arm of ARMS) {
    const r = await runCmd({ ...reportOnlyCmd(arm, runOf(cur, arm)), quiet: true, log: `report-${arm}` });
    const line = r.out.trim().split("\n").filter(Boolean).pop() ?? "";
    console.log(`report ${arm.padEnd(9)} ${runOf(cur, arm)} exit ${r.code} ${secs(r.ms)}  ${line.slice(0, 160)}`);
  }
  console.log(`\nresume done in ${secs(Date.now() - t0)}`);
});
