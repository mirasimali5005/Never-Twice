// CLI for the baseline arms A (`control`) and B (`documented`); the runner routes `--arm control|documented` here:
//   pnpm run:control -- --run <control_run_id> [--arm control] [--pause-before-payout] [--report-only]
// Honours the go file .nt/go-<group_id>.json (kill_at_passenger → NT_CRASH_AT=CTRL_AFTER_PROVIDER_RESPONSE@<effect_key>) and an
// NT_CRASH_AT already in the environment. Never prints a key or a connection string.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, type PaymentProvider, type ProviderId } from "@nt/contracts";
import { createModelClient } from "@nt/agents";
import { dbNameFrom, openNtDb, uriFor } from "@nt/db";
import { createProvider } from "@nt/providers";
import { loadPolicyBundle, parsePolicyBundle, DEFAULT_POLICY_IDS, type PolicyIds } from "@nt/rules";
import type { PolicyBundle } from "@nt/contracts";
import { buildBaselineReport, killSpecFor, runControl, writeReportFile } from "./control.ts";
import { runDocumented } from "./documented.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

type Args = { run: string | null; arm: string | null; pause: boolean; reportOnly: boolean };

function parseArgs(argv: string[]): Args {
  const a: Args = { run: null, arm: null, pause: false, reportOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--") continue;
    if (t === "--run") a.run = argv[++i] ?? null;
    else if (t.startsWith("--run=")) a.run = t.slice(6);
    else if (t === "--arm") a.arm = argv[++i] ?? null;
    else if (t.startsWith("--arm=")) a.arm = t.slice(6);
    else if (t === "--pause-before-payout") a.pause = true;
    else if (t === "--report-only") a.reportOnly = true;
    else throw new Error(`unknown argument ${t}`);
  }
  return a;
}

function die(msg: string, code = 2): never {
  console.error(`control: ${msg}`);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = args.run ?? process.env["NT_RUN_ID"] ?? die("--run <run_id> is required");
  if (args.arm !== null && args.arm !== "control" && args.arm !== "documented") die(`this entry point runs arm control or documented, not ${args.arm}`);

  const parsed = parseEnv("runner", { ...process.env, NT_RUN_ID: runId, NT_ARM: args.arm ?? "control" });
  if (!parsed.ok) die(`environment invalid:\n  ${parsed.errors.join("\n  ")}`);
  const env = parsed.env;

  const dbName = dbNameFrom(env);
  const agent = await openNtDb({ uri: uriFor("agent", env), dbName, role: "agent" });
  // The control writes the pool counter itself (it has no gateway), so it opens the gateway-role client for that one collection.
  const gw = await openNtDb({ uri: uriFor("gateway", env), dbName, role: "gateway" });
  try {
    const run = await agent.runs.findOne({ _id: runId });
    if (!run) die(`no execution_runs document for ${runId}`);
    if (run.arm !== "control" && run.arm !== "documented") die(`run ${runId} is arm ${run.arm}, not control or documented`);
    if (args.arm !== null && args.arm !== run.arm) die(`--arm ${args.arm} does not match execution_runs.arm ${run.arm}`);
    const arm = run.arm;

    const db = { claims: agent.claims, bookings: agent.bookings, runs: agent.runs, grants: gw.grants };
    const log = (line: string): void => console.log(`[${arm} ${runId}] ${line}`);

    if (args.reportOnly) {
      const report = await buildBaselineReport(runId, { db });
      const file = writeReportFile(report, join(process.cwd(), "out", "reports"));
      await agent.runs.updateOne({ _id: runId }, { $set: { final_report: report } });
      log(`report rewritten: ${file}`);
      return;
    }

    const policy = await loadPolicy(agent, DEFAULT_POLICY_IDS);
    const model = createModelClient(env);
    const providers = new Map<ProviderId, Promise<PaymentProvider>>();
    const providerFor = (id: ProviderId): Promise<PaymentProvider> => {
      let p = providers.get(id);
      if (!p) {
        p = createProvider(id, {
          NT_SIM_URL: env.NT_SIM_URL,
          NT_SIM_WRITE_KEY: env.NT_SIM_WRITE_KEY,
          NT_SIM_READ_KEY: process.env["NT_SIM_READ_KEY"],
          NT_RUN_ID: runId,
          STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
        });
        providers.set(id, p);
      }
      return p;
    };

    const already = await agent.claims.countDocuments({ run_id: runId, "baseline.payments.0": { $exists: true } });
    const resuming = already > 0;
    if (resuming) log("restart: resuming every claim not marked done");

    await (arm === "documented" ? runDocumented : runControl)({
      runId,
      db,
      model,
      policy,
      providerFor,
      stripeEnabled: env.NT_STRIPE_ENABLED,
      dispatchTimeoutMs: Number(process.env["NT_DISPATCH_TIMEOUT_MS"] ?? 3000),
      log,
      beforePayout: async (decided) => {
        if (!args.pause || resuming) return;
        await agent.runs.updateOne({ _id: runId }, { $set: { status: "PAUSED" } });
        log(`PAUSED: waiting for .nt/go-${run.group_id}.json`);
        const go = await waitForGoFile(run.group_id);
        const spec = killSpecFor(go.kill_at_passenger ?? null, decided);
        if (spec) {
          process.env["NT_CRASH_AT"] = spec;
          log(`kill armed: ${spec}`);
        } else if (go.kill_at_passenger) {
          log(`no owed statutory payment for ${go.kill_at_passenger}; continuing without a kill`);
        }
        await agent.runs.updateOne({ _id: runId }, { $set: { status: "RUNNING" } });
      },
    });
  } finally {
    await agent.close();
    await gw.close();
  }
}

async function loadPolicy(agent: Awaited<ReturnType<typeof openNtDb>>, ids: PolicyIds): Promise<PolicyBundle> {
  try {
    const [s, g] = await Promise.all([agent.policies.findOne({ _id: ids.statutory }), agent.policies.findOne({ _id: ids.goodwill })]);
    if (s && g) return parsePolicyBundle(s, g, ids);
  } catch {
    /* fall back to the fixture files */
  }
  return loadPolicyBundle(join(repoRoot, "fixtures/policies"), ids);
}

async function waitForGoFile(groupId: string): Promise<{ kill_at_passenger?: string }> {
  const file = join(process.cwd(), ".nt", `go-${groupId}.json`);
  for (;;) {
    if (existsSync(file)) {
      try {
        const v = JSON.parse(readFileSync(file, "utf8")) as { kill_at_passenger?: unknown };
        return typeof v.kill_at_passenger === "string" ? { kill_at_passenger: v.kill_at_passenger } : {};
      } catch {
        /* half-written: read again */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

main().catch((e: unknown) => {
  console.error(`control: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
