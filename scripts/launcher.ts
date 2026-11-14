// pnpm demo:start [--no-wait] [--with-reconcilers]
// Starts what the demo needs and is available: the simulator (if not running), the desk API (if built), one runner per run of the
// current group with --pause-before-payout. Pieces that are not built yet are reported, not failed on. Pid files in .nt/pids/.
import { existsSync } from "node:fs";
import { parseArgs, runMain, UsageError } from "./lib/args.ts";
import { dbLabel, openOwnerDb, simUrl } from "./lib/env.ts";
import { DESK_SERVER, NT_DIR, RECONCILER_MAIN, ROOT, RUNNER_CLI, SIM_SERVER } from "./lib/paths.ts";
import { isAlive, listPids, startDetached } from "./lib/proc.ts";
import { SimAdmin } from "./lib/sim-admin.ts";
import { readCurrent } from "./lib/state.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

await runMain(async () => {
  const a = parseArgs(process.argv.slice(2), []);
  const cur = readCurrent(NT_DIR);
  if (!cur) throw new UsageError("no current group: run `pnpm demo:reset -- --scenario S0|S1` first");
  console.log(`database: ${dbLabel()}   group ${cur.group_id}   scenario ${cur.scenario}`);

  // Simulator
  const sim = new SimAdmin(simUrl(), "unused");
  if (await sim.healthy()) console.log("simulator: already running");
  else {
    const pid = startDetached({ ntDir: NT_DIR, name: "sim", command: NODE, args: [ENVFILE, SIM_SERVER], cwd: ROOT });
    for (let i = 0; i < 50 && !(await sim.healthy()); i++) await sleep(200);
    console.log((await sim.healthy()) ? `simulator: started (pid ${pid})` : "simulator: started but not answering /healthz yet; see .nt/logs/sim.log");
  }

  // Desk API
  if (!existsSync(DESK_SERVER)) console.log("desk-api: not built yet (task G1): skipped; use `pnpm demo:tty`");
  else if (await httpUp("http://127.0.0.1:4020/")) console.log("desk-api: already running");
  else console.log(`desk-api: started (pid ${startDetached({ ntDir: NT_DIR, name: "desk", command: NODE, args: [ENVFILE, DESK_SERVER], cwd: ROOT })})`);

  // Runners, one per run, paused before payout. Intake in replay; the mutant carries M2.
  if (!existsSync(RUNNER_CLI)) console.log("runners: apps/runner/src/cli.ts not built yet (task E4): skipped");
  else {
    for (const [arm, runId] of Object.entries(cur.runs)) {
      const name = `runner-${arm}`;
      if (running(name)) {
        console.log(`${name}: already running`);
        continue;
      }
      const env: Record<string, string> = { NT_MODEL_MODE: "replay", NT_RUN_ID: runId, NT_ARM: arm };
      if (arm === "nt_mutant") env.NT_MUTATION = "M2";
      const pid = startDetached({ ntDir: NT_DIR, name, command: NODE, args: [ENVFILE, RUNNER_CLI, "--run", runId, "--arm", arm, "--pause-before-payout"], cwd: ROOT, env });
      console.log(`${name}: started (pid ${pid}) run ${runId}`);
    }
  }

  if (a.flags.has("with-reconcilers")) {
    if (!existsSync(RECONCILER_MAIN)) console.log("reconcilers: apps/reconciler/src/main.ts not built yet (task D2): skipped");
    else
      for (const arm of ["nt", "nt_mutant"]) {
        const runId = cur.runs[arm];
        if (runId && !running(`reconciler-${arm}`)) {
          const env: Record<string, string> = { NT_RUN_ID: runId, NT_ARM: arm, NT_MODEL_MODE: "live" };
          if (arm === "nt_mutant") env.NT_MUTATION = "M2";
          console.log(`reconciler-${arm}: started (pid ${startDetached({ ntDir: NT_DIR, name: `reconciler-${arm}`, command: NODE, args: [ENVFILE, RECONCILER_MAIN, "--run", runId], cwd: ROOT, env })})`);
        }
      }
  }

  // Wait until the runners report PAUSED (status in execution_runs).
  const runners = listPids(NT_DIR).filter((p) => p.name.startsWith("runner-") && isAlive(p.pid));
  if (runners.length > 0 && !a.flags.has("no-wait")) {
    const db = await openOwnerDb("desk");
    try {
      const ids = Object.values(cur.runs);
      const deadline = Date.now() + 60_000;
      let paused = 0;
      while (Date.now() < deadline) {
        paused = await db.runs.countDocuments({ _id: { $in: ids }, status: "PAUSED" });
        if (paused >= runners.length) break;
        await sleep(1000);
      }
      console.log(paused >= runners.length ? `${paused} runners paused before payout` : `only ${paused} of ${runners.length} runners paused after 60 s; see .nt/logs/runner-*.log`);
    } finally {
      await db.close();
    }
  }
});
