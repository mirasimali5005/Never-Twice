// `pnpm reconcile -- --run <run_id> [--until-drained] [--once] [--watch]` (HANDOVER.md §11.1; AGENT_TASKS.md D2).
// Worker id reconciler-<pid>. Polls every NT_RECONCILE_INTERVAL_MS. Stops cleanly on SIGTERM/SIGINT between intents.
// Exit codes: 0 drained / stopped / one pass done; 2 bad arguments or environment; 1 an unexpected error.
// The reconciler never writes the final report: scripts run the runner's --report-only afterwards (HANDOVER.md §14).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelClient, DEFAULT_MODEL } from "@nt/agents";
import { parseEnv } from "@nt/contracts";
import type { ModelClient } from "@nt/contracts";
import { openNtDb, uriFor, dbNameFrom, type NtDb } from "@nt/db";
import { makeCollect, type CollectMode } from "./collect.ts";
import { runLoop, type LoopDeps } from "./loop.ts";
import type { Barrier, ReconcilerGateway } from "./ports.ts";
import { createMongoStore } from "./store.ts";

export type CliArgs = { runId: string; untilDrained: boolean; once: boolean; watch: boolean };

export function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  let runId: string | null = null;
  let untilDrained = false;
  let once = false;
  let watch = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    else if (a === "--run") runId = argv[++i] ?? null;
    else if (a?.startsWith("--run=")) runId = a.slice("--run=".length);
    else if (a === "--until-drained") untilDrained = true;
    else if (a === "--once") once = true;
    else if (a === "--watch") watch = true;
    else if (a === "--no-watch") watch = false;
    else return { error: `unknown argument ${JSON.stringify(a)}` };
  }
  if (!runId) return { error: "--run <run_id> is required" };
  return { runId, untilDrained, once, watch };
}

/** What the gateway factory receives. The simulator write key and Stripe key reach only the gateway's provider objects. */
export type GatewayFactoryInput = { db: NtDb; runId: string; workerId: string; env: Record<string, unknown> };
export type GatewayFactory = (i: GatewayFactoryInput) => Promise<{ gateway: ReconcilerGateway; barrier: Barrier }>;

/**
 * Default wiring to @nt/gateway (task B3). B3 is finishing createGateway in parallel; the reconciler must not import @nt/providers, so
 * it asks the gateway package for a fully wired instance. Resolved by name at run time so this file typechecks before B3 merges.
 */
export const defaultGatewayFactory: GatewayFactory = async (i) => {
  const mod = (await import("@nt/gateway")) as Record<string, unknown>;
  const factory = (mod["createGatewayFromEnv"] ?? mod["createGatewayForProcess"]) as
    | ((o: { db: NtDb; runId: string; workerId: string; env: Record<string, unknown> }) => unknown)
    | undefined;
  const barrier = mod["barrier"] as Barrier | undefined;
  if (typeof factory !== "function" || typeof barrier !== "function") {
    throw new Error("@nt/gateway does not export createGatewayFromEnv and barrier yet (task B3); the reconciler cannot start");
  }
  const gw = (await factory(i)) as Partial<ReconcilerGateway>;
  for (const m of ["dispatch", "takeOverExpired", "acquireLease", "settle", "quarantine", "recordLicence", "resend", "applyResendResult", "readOnlyProviderView", "capabilitiesOf"] as const) {
    if (typeof gw[m] !== "function") throw new Error(`@nt/gateway: gateway is missing ${m} (task B3)`);
  }
  return { gateway: gw as ReconcilerGateway, barrier };
};

export async function main(argv: readonly string[], o: { gatewayFactory?: GatewayFactory; model?: ModelClient } = {}): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    process.stderr.write(`reconcile: ${args.error}\nusage: pnpm reconcile -- --run <run_id> [--until-drained] [--once] [--watch]\n`);
    return 2;
  }
  // NT_MODEL / NT_MODEL_MODE take the same defaults createModelClient applies (frozen model id, live), so a deterministic-only
  // reconciler starts without model variables. NT_ARM defaults to the system arm.
  const parsed = parseEnv("reconciler", {
    ...process.env,
    NT_RUN_ID: args.runId,
    NT_ARM: process.env.NT_ARM || "nt",
    NT_MODEL: process.env.NT_MODEL || DEFAULT_MODEL,
    NT_MODEL_MODE: process.env.NT_MODEL_MODE || "live",
  });
  if (!parsed.ok) {
    process.stderr.write(`reconcile: environment invalid:\n${parsed.errors.map((e) => `  ${e}`).join("\n")}\n`);
    return 2;
  }
  const env = parsed.env;
  const workerId = `reconciler-${process.pid}`;
  const mode: CollectMode = process.env.NT_RECONCILER_INVESTIGATOR === "deterministic" ? "deterministic" : "llm";
  const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

  const gwDb = await openNtDb({ uri: uriFor("gateway", env), dbName: dbNameFrom(env), role: "gateway" });
  const invDb = await openNtDb({ uri: uriFor("investigator", env), dbName: dbNameFrom(env), role: "investigator" });
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const { gateway, barrier } = await (o.gatewayFactory ?? defaultGatewayFactory)({ db: gwDb, runId: args.runId, workerId, env });
    let model = o.model;
    if (model === undefined && mode === "llm") {
      model = createModelClient(env);
    }
    const collect = makeCollect({ gateway, mode, model, timeoutMs: env.NT_INVESTIGATOR_TIMEOUT_MS });
    const deps: LoopDeps = {
      runId: args.runId,
      workerId,
      leaseMs: env.NT_LEASE_MS,
      watch: args.watch,
      gateway,
      store: createMongoStore({ gw: gwDb, inv: invDb, runId: args.runId }),
      collect,
      watchCollect: makeCollect({ gateway, mode: "deterministic", timeoutMs: env.NT_INVESTIGATOR_TIMEOUT_MS }),
      barrier,
      log,
      stopping: () => stopping,
    };
    log(`[${workerId}] run ${args.runId}: investigator=${mode} interval=${env.NT_RECONCILE_INTERVAL_MS}ms until_drained=${args.untilDrained} once=${args.once} watch=${args.watch}${env.NT_CRASH_AT ? ` NT_CRASH_AT=${env.NT_CRASH_AT}` : ""}`);
    const code = await runLoop(deps, { untilDrained: args.untilDrained, once: args.once, intervalMs: env.NT_RECONCILE_INTERVAL_MS });
    log(`[${workerId}] exit ${code}${args.untilDrained ? " (drained: no RESERVED, DISPATCHING or OUTCOME_UNKNOWN intent)" : ""}`);
    return code;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await gwDb.close();
    await invDb.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`reconcile: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
