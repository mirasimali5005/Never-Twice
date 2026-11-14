// pnpm demo:start [--no-wait]
// Starts what the demo needs: the simulator (if not running), the desk (`pnpm desk`: API 4020 + UI 5173, if not running), one runner per run
// of the current group with --pause-before-payout (intake in replay; the mutant carries M2). Prints the desk URL with ?group=<group_id>.
// Logs: out/logs/<name>.log. Pid files: .nt/pids/<name>.pid.
import { existsSync } from "node:fs";
import { parseArgs, runMain, UsageError } from "./lib/args.ts";
import { dbLabel, openOwnerDb, simUrl } from "./lib/env.ts";
import { NT_DIR, ROOT, RUNNER_CLI, SIM_SERVER } from "./lib/paths.ts";
import { isAlive, listPids, startDetached } from "./lib/proc.ts";
import { SimAdmin } from "./lib/sim-admin.ts";
import { readCurrent } from "./lib/state.ts";
import { DESK_API, DESK_URL, LOG_DIR, TSX, sleep } from "./demo/lib.ts";

const NODE = process.execPath;
const ENVFILE = "--env-file-if-exists=.env";

function running(name: string): boolean {
  return listPids(NT_DIR).some((p) => p.name === name && p.alive);
}

async function httpUp(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).status < 500;
  } catch {
    return false;
  }
}

async function waitFor(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(250);
  }
  return fn();
}

await runMain(async () => {
  const a = parseArgs(process.argv.slice(2), []);
  const t0 = Date.now();
  const cur = readCurrent(NT_DIR);
  if (!cur) throw new UsageError("no current group: run `pnpm demo:reset -- --scenario S0|S1` first");
  console.log(`database: ${dbLabel()}   group ${cur.group_id}   scenario ${cur.scenario}`);

  // Simulator
  const sim = new SimAdmin(simUrl(), "unused");
  if (await sim.healthy()) console.log("simulator: already running");
  else {
    const pid = startDetached({ ntDir: NT_DIR, name: "sim", command: NODE, args: [ENVFILE, SIM_SERVER], cwd: ROOT, logDir: LOG_DIR });
    const up = await waitFor(() => sim.healthy(), 10_000);
    console.log(up ? `simulator: started (pid ${pid})` : "simulator: started but not answering /healthz yet; see out/logs/sim.log");
  }

  // Desk (API + UI), through `pnpm desk` in its own process group.
  const apiUp = await httpUp(`${DESK_API}/`);
  const uiUp = await httpUp(`${DESK_URL}/`);
  if (apiUp && uiUp) console.log("desk: already running (API 4020, UI 5173)");
  else if (apiUp || uiUp) console.log(`desk: only the ${apiUp ? "API" : "UI"} answers; restart \`pnpm desk\` in its own terminal`);
  else {
    const pid = startDetached({ ntDir: NT_DIR, name: "desk", command: "pnpm", args: ["desk"], cwd: ROOT, logDir: LOG_DIR });
    const up = await waitFor(async () => (await httpUp(`${DESK_API}/`)) && (await httpUp(`${DESK_URL}/`)), 30_000);
    console.log(up ? `desk: started (pid ${pid})` : "desk: started but not answering yet; see out/logs/desk.log");
  }

  // Runners, one per run, paused before payout. Intake in replay; the mutant carries M2 (the reconciler never does).
  if (!existsSync(RUNNER_CLI)) console.log("runners: apps/runner/src/cli.ts not built yet (task E4): skipped");
  else {
    for (const [arm, runId] of Object.entries(cur.runs)) {
      const name = `runner-${arm}`;
      if (running(name)) {
        console.log(`${name}: already running`);
        continue;
      }
      const env: Record<string, string> = { NT_MODEL_MODE: "replay", NT_MODEL_BACKEND: process.env.NT_MODEL_BACKEND || "cli", NT_RUN_ID: runId, NT_ARM: arm };
      if (arm === "nt_mutant") env.NT_MUTATION = "M2";
      const pid = startDetached({ ntDir: NT_DIR, name, command: TSX, args: [ENVFILE, RUNNER_CLI, "--run", runId, "--arm", arm, "--pause-before-payout"], cwd: ROOT, env, logDir: LOG_DIR });
      console.log(`${name}: started (pid ${pid}) run ${runId}`);
    }
  }

  // Wait until the runners report PAUSED (status in execution_runs).
  const runners = listPids(NT_DIR).filter((p) => p.name.startsWith("runner-") && isAlive(p.pid));
  if (runners.length > 0 && !a.flags.has("no-wait")) {
    const db = await openOwnerDb("desk");
    try {
      const ids = Object.values(cur.runs);
      const deadline = Date.now() + 90_000;
      let paused = 0;
      while (Date.now() < deadline) {
        paused = await db.runs.countDocuments({ _id: { $in: ids }, status: "PAUSED" });
        if (paused >= runners.length) break;
        await sleep(500);
      }
      console.log(paused >= runners.length ? `${paused} runners paused before payout` : `only ${paused} of ${runners.length} runners paused after 90 s; see out/logs/runner-*.log`);
    } finally {
      await db.close();
    }
  }
  console.log(`\nDESK  ${DESK_URL}/?group=${cur.group_id}   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log(`next: pnpm demo:go -- --kill-at P02`);
});
