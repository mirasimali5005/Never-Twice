// The test world for end-to-end tests (task H2): an in-memory replica set (or the event sandbox when NT_E2E_SANDBOX=1), a simulator child process on an
// ephemeral port with random local keys, and the seed script run as a child. Every process gets an explicit, minimal environment; nothing is inherited.
// Keys are generated here or read (never printed) from .env files; no value is written to a log or a message.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openNtDb, type NtDb } from "../../packages/db/src/index.ts";
import { startTestReplSet, type TestReplSet } from "../../packages/db/src/testing.ts";
import { freePort, runNode, spawnNode, tail, waitFor, type Spawned } from "./proc.ts";

export const REPO = resolve(import.meta.dirname, "..", "..");
export const PATHS = {
  sim: join(REPO, "apps", "provider-sim", "src", "server.ts"),
  runner: join(REPO, "apps", "runner", "src", "cli.ts"),
  reconcilerCandidates: [join(REPO, "apps", "reconciler", "src", "cli.ts"), join(REPO, "apps", "reconciler", "src", "main.ts")],
  control: join(REPO, "packages", "baselines", "src", "control.ts"),
  seed: join(REPO, "scripts", "seed.ts"),
  evaluator: join(REPO, "evaluator", "src", "cli.ts"),
  cassettes: join(REPO, "fixtures", "cassettes"),
} as const;

/** The reconciler's entry point: apps/reconciler/src/cli.ts (task brief) or main.ts (AGENT_TASKS D2 and scripts/lib/paths.ts). */
export function reconcilerEntry(): string | null {
  return PATHS.reconcilerCandidates.find((p) => existsSync(p)) ?? null;
}

// ------------------------------------------------------------------------------------------------ dotenv (values are never printed)

function parseDotenvFile(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, "");
    if (v !== "") out.set(m[1]!, v);
  }
  return out;
}

const rootEnv = () => parseDotenvFile(join(REPO, ".env"));
const evaluatorEnv = () => parseDotenvFile(join(REPO, "evaluator", ".env"));

// ------------------------------------------------------------------------------------------------ Stripe

export type StripeMode = { on: false; why: string } | { on: true; secretKey: string; evalKey: string; why: string };

/** Stripe test mode is used only when it is not switched off, both keys are present, and both are test-mode keys; otherwise the simulator REFUND path. */
export function stripeMode(): StripeMode {
  if ((process.env.NT_STRIPE_ENABLED ?? rootEnv().get("NT_STRIPE_ENABLED")) === "false") return { on: false, why: "NT_STRIPE_ENABLED=false" };
  const secretKey = process.env.STRIPE_SECRET_KEY || rootEnv().get("STRIPE_SECRET_KEY");
  const evalKey = process.env.EVAL_STRIPE_KEY || evaluatorEnv().get("EVAL_STRIPE_KEY");
  if (!secretKey) return { on: false, why: "STRIPE_SECRET_KEY is not set" };
  if (!evalKey) return { on: false, why: "EVAL_STRIPE_KEY is not set" };
  if (!/^(sk|rk)_test_/.test(secretKey)) throw new Error("STRIPE_SECRET_KEY is not a test-mode key; refusing to run (value not shown)");
  if (!/^(sk|rk)_test_/.test(evalKey)) throw new Error("EVAL_STRIPE_KEY is not a test-mode key; refusing to run (value not shown)");
  return { on: true, secretKey, evalKey, why: "test keys present" };
}

// ------------------------------------------------------------------------------------------------ the world

export type Arm = "nt" | "control" | "nt_mutant";
export type SeededRun = { arm: string; run_id: string; sim_account: string };
export type Seeded = { group_id: string; runs: SeededRun[]; manifest_sha256: string; stdout: string };

export type World = {
  repl: TestReplSet;
  simUrl: string;
  dbName: string;
  stripe: StripeMode;
  sandbox: boolean;
  /** Environment for a system process (runner, reconciler, seed). Explicit and minimal; the Stripe key only when Stripe is on. */
  procEnv(role: "runner" | "reconciler" | "seed", extra?: Record<string, string>): Record<string, string>;
  /** Environment for the evaluator: only EVAL_* variables, never a database variable (SEC-07). */
  evaluatorEnv(): Record<string, string>;
  seedS0(arms?: Arm[]): Promise<Seeded>;
  openDb(): Promise<NtDb>;
  stop(): Promise<void>;
};

const hex = (n = 16) => randomBytes(n).toString("hex");

export async function startWorld(): Promise<World> {
  const sandbox = process.env.NT_E2E_SANDBOX === "1";
  const stripe = stripeMode();
  const dirs: string[] = [];
  const spawned: Spawned[] = [];
  let repl: TestReplSet | undefined;
  try {
    // Database.
    let nodeEnv: "local" | "sandbox" = "local";
    if (sandbox) {
      const env = rootEnv();
      const uri = process.env.NT_MONGODB_URI || env.get("NT_MONGODB_URI");
      if (!uri) throw new Error("NT_E2E_SANDBOX=1 needs NT_MONGODB_URI (in the environment or .env)");
      process.env.NT_TEST_MONGODB_URI = uri;
      nodeEnv = "sandbox";
      repl = await startTestReplSet({ dbName: process.env.NT_DB_NAME || env.get("NT_DB_NAME") || "never_twice" });
    } else {
      delete process.env.NT_TEST_MONGODB_URI;
      repl = await startTestReplSet();
    }
    const dbName = repl.dbName;

    // Simulator on an ephemeral port with random local keys (they exist only for this test).
    const keys = { write: hex(), read: hex(), admin: hex(), evalRead: hex() };
    const port = await freePort();
    const simUrl = `http://127.0.0.1:${port}`;
    const dataDir = mkdtempSync(join(tmpdir(), "nt-e2e-sim-"));
    dirs.push(dataDir);
    const sim = spawnNode([PATHS.sim], { NT_SIM_PORT: String(port), NT_SIM_DATA_DIR: dataDir, NT_SIM_URL: simUrl, NT_SIM_WRITE_KEY: keys.write, NT_SIM_READ_KEY: keys.read, NT_SIM_ADMIN_KEY: keys.admin, NT_SIM_EVAL_READ_KEY: keys.evalRead }, { cwd: REPO });
    spawned.push(sim);
    await waitFor(
      "the simulator's /healthz",
      async () => {
        try {
          return (await fetch(`${simUrl}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 15_000, intervalMs: 150 },
    ).catch((e: Error) => {
      throw new Error(`${e.message}\n${tail(sim.output().stdout)}\n${tail(sim.output().stderr)}`);
    });

    const path = process.env.PATH ?? "/usr/bin:/bin";
    const base = (): Record<string, string> => ({
      NT_ENV: nodeEnv,
      NT_MONGODB_URI: repl!.uri,
      NT_DB_NAME: dbName,
      NT_SIM_URL: simUrl,
      NT_MODEL: process.env.NT_MODEL || rootEnv().get("NT_MODEL") || "claude-opus-5-5",
      NT_MODEL_BACKEND: "cli",
      NT_MODEL_CASSETTE_DIR: PATHS.cassettes,
      NT_STRIPE_ENABLED: stripe.on ? "true" : "false",
      ...(stripe.on ? { STRIPE_SECRET_KEY: stripe.secretKey } : {}),
    });

    const world: World = {
      repl,
      simUrl,
      dbName,
      stripe,
      sandbox,
      procEnv(role, extra = {}) {
        const timing = { NT_DISPATCH_TIMEOUT_MS: "3000", NT_LEASE_MS: "8000", NT_RECONCILE_INTERVAL_MS: "500" };
        if (role === "seed") return { ...base(), PATH: path, NT_SIM_ADMIN_KEY: keys.admin, NT_SIM_WRITE_KEY: keys.write, ...extra };
        if (role === "runner") return { ...base(), ...timing, PATH: path, NT_MODEL_MODE: "replay", NT_SIM_WRITE_KEY: keys.write, ...extra };
        // The reconciler's investigator: no `claude` on PATH and a short investigator timeout, so the model path fails fast and the specified
        // deterministic fallback (HANDOVER section 11.2) runs, which makes the test independent of a live model. NT_E2E_INVESTIGATOR=llm keeps PATH.
        const rpath = process.env.NT_E2E_INVESTIGATOR === "llm" ? path : "/nonexistent-nt-e2e";
        return { ...base(), ...timing, PATH: rpath, NT_MODEL_MODE: process.env.NT_E2E_INVESTIGATOR === "llm" ? "live" : "replay", NT_INVESTIGATOR_TIMEOUT_MS: "3000", NT_SIM_WRITE_KEY: keys.write, NT_SIM_READ_KEY: keys.read, ...extra };
      },
      evaluatorEnv() {
        return { PATH: path, EVAL_SIM_URL: simUrl, EVAL_SIM_READ_KEY: keys.evalRead, ...(stripe.on ? { EVAL_STRIPE_KEY: stripe.evalKey } : {}) };
      },
      async seedS0(arms = ["nt", "control", "nt_mutant"]) {
        const r = await runNode([PATHS.seed, "--scenario", "S0", "--arms", arms.join(","), "--faults", "F-DEMO"], world.procEnv("seed"), { cwd: REPO, timeoutMs: 120_000, label: "seed" });
        if (r.code !== 0) throw new Error(`seed exited ${r.code}\n${tail(r.stdout)}\n${tail(r.stderr)}`);
        const group = /^group_id\s+(g[0-9a-z]{7})\b/m.exec(r.stdout)?.[1];
        const hash = /^manifest sha256 ([0-9a-f]{64})/m.exec(r.stdout)?.[1];
        const runs = [...r.stdout.matchAll(/^run_id\s+(r[0-9a-z]{7})\s+arm\s+(\S+)\s+account\s+(\S+)/gm)].map((m) => ({ run_id: m[1]!, arm: m[2]!, sim_account: m[3]! }));
        if (!group || !hash || runs.length !== arms.length) throw new Error(`could not parse the seed output:\n${tail(r.stdout)}`);
        return { group_id: group, runs, manifest_sha256: hash, stdout: r.stdout };
      },
      openDb: () => openNtDb({ uri: repl!.uri, dbName }),
      async stop() {
        for (const s of spawned) s.kill("SIGTERM");
        await Promise.race([Promise.all(spawned.map((s) => s.exited)), new Promise((r) => setTimeout(r, 3000))]);
        for (const s of spawned) s.kill("SIGKILL");
        await repl?.stop().catch(() => {});
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
      },
    };
    return world;
  } catch (e) {
    for (const s of spawned) s.kill("SIGKILL");
    await repl?.stop().catch(() => {});
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    throw e;
  }
}
