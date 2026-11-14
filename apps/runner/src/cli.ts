// `pnpm run:arm -- --run <run_id> [--arm <arm>] [--pause-before-payout] [--report-only]` (HANDOVER.md §14, §16; AGENT_TASKS.md E4).
// Two database clients: `agent` for claims, obligations and the run record; `gateway`, handed only to the gateway library.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createModelClient } from "@nt/agents";
import { Arm, parseEnv, type PolicyBundle } from "@nt/contracts";
import { closeAll, connect, type NtDb, type RoleEnv as DbRoleEnv } from "@nt/db";
import { DEFAULT_POLICY_IDS, loadPolicyBundle, parsePolicyBundle } from "@nt/rules";
import { RUNNER_WORKER } from "./audit.ts";
import { buildGateway } from "./gateway-factory.ts";
import { ORCHESTRATED_ARMS, runArm, runReportOnly } from "./orchestrator.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const log = (m: string) => process.stderr.write(`[runner] ${m}\n`);

/** Policies from the `policies` collection (seeded), else from fixtures/policies. */
async function loadPolicy(db: NtDb): Promise<PolicyBundle> {
  const [s, g] = await Promise.all([db.policies.findOne({ _id: DEFAULT_POLICY_IDS.statutory }), db.policies.findOne({ _id: DEFAULT_POLICY_IDS.goodwill })]);
  if (s && g) return parsePolicyBundle(s, g);
  log("policies not in MongoDB; reading fixtures/policies");
  return loadPolicyBundle(join(REPO_ROOT, "fixtures", "policies"));
}

export async function main(argv: string[], source: Record<string, string | undefined> = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : argv,
    options: { run: { type: "string" }, arm: { type: "string" }, "pause-before-payout": { type: "boolean", default: false }, "report-only": { type: "boolean", default: false } },
    allowPositionals: false,
  });
  const runId = values.run ?? source["NT_RUN_ID"];
  if (!runId) {
    log("usage: pnpm run:arm -- --run <run_id> [--arm <arm>] [--pause-before-payout] [--report-only]");
    return 2;
  }
  let flagArm: Arm | undefined;
  if (values.arm !== undefined) {
    const a = Arm.safeParse(values.arm);
    if (!a.success) {
      log(`--arm must be one of ${Arm.options.join(", ")}`);
      return 2;
    }
    flagArm = a.data;
  }

  // Which arm is this run? Only the database knows. This first client needs just the MongoDB variables.
  const early = await connect("agent", source as DbRoleEnv);
  try {
    const run = await early.runs.findOne({ _id: runId });
    if (!run) {
      log(`no execution_runs document for ${runId}`);
      return 1;
    }
    if (flagArm !== undefined && flagArm !== run.arm) {
      log(`--arm ${flagArm} does not match execution_runs.arm ${run.arm}; refusing to start`);
      return 1;
    }
    // The control arm builds its own report (packages/baselines); the generic builder would drop its paid list.
    if (values["report-only"] && run.arm !== "control") return await runReportOnly(early, runId, REPO_ROOT, log);

    const parsed = parseEnv("runner", { ...source, NT_RUN_ID: runId, NT_ARM: run.arm });
    if (!parsed.ok) {
      log(`environment invalid for role runner:\n${parsed.errors.map((e) => `  ${e}`).join("\n")}`);
      return 1;
    }
    const env = parsed.env;

    if (run.arm === "control") {
      // Arm A lives in packages/baselines (task E5). Run its CLI as a child with the same arguments and environment; a SIGKILL of the
      // child (the judge's kill at CTRL_AFTER_PROVIDER_RESPONSE) is propagated so callers see the same death as the nt arm.
      const { spawnSync } = await import("node:child_process");
      const { fileURLToPath } = await import("node:url");
      const script = fileURLToPath(new URL("../../../packages/baselines/src/control-cli.ts", import.meta.url));
      const fwd: string[] = [];
      const argv = process.argv.slice(2);
      for (let i = 0; i < argv.length; i++) { if (argv[i] === "--arm") { i++; continue; } fwd.push(argv[i]!); }
      const r = spawnSync(process.execPath, [script, ...fwd], { stdio: "inherit", env: process.env });
      if (r.signal === "SIGKILL") process.kill(process.pid, "SIGKILL");
      return r.status ?? 1;
    }
    if (!ORCHESTRATED_ARMS.includes(run.arm)) {
      // documented and rules_only arms are Tier 2 and not built.
      log(`arm ${run.arm} is not available in this build (Tier 2)`);
      return 1;
    }

    const model = createModelClient({ NT_MODEL: env.NT_MODEL, NT_MODEL_MODE: env.NT_MODEL_MODE, NT_MODEL_BACKEND: env.NT_MODEL_BACKEND, NT_MODEL_CASSETTE_DIR: env.NT_MODEL_CASSETTE_DIR });
    const { gateway } = await buildGateway(env, runId, RUNNER_WORKER);
    const policy = await loadPolicy(early);
    return await runArm({ runId, arm: run.arm, pauseBeforePayout: values["pause-before-payout"] === true }, { db: early, gateway, model, policy, repoRoot: REPO_ROOT, log });
  } finally {
    await closeAll();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`[runner] fatal: ${(e as Error).stack ?? String(e)}\n`);
      process.exit(1);
    },
  );
}
