// Shared helpers for the demo:* scripts (H4): run a child process, stream its output with a prefix, locate the three runs.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { NT_DIR, ROOT } from "../lib/paths.ts";
import { readCurrent, type CurrentGroup } from "../lib/state.ts";
import { UsageError } from "../lib/args.ts";

export const TSX = join(ROOT, "node_modules", ".bin", "tsx");
export const LOG_DIR = join(ROOT, "out", "logs");
export const REPORTS = join(ROOT, "out", "reports");
export const DESK_URL = "http://localhost:5173";
export const DESK_API = "http://127.0.0.1:4020";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function currentGroup(): CurrentGroup {
  const cur = readCurrent(NT_DIR);
  if (!cur) throw new UsageError("no current group: run `pnpm demo:reset -- --scenario S0|S1` first");
  return cur;
}

export function runOf(cur: CurrentGroup, arm: string): string {
  const id = cur.runs[arm];
  if (!id) throw new UsageError(`the current group ${cur.group_id} has no ${arm} run`);
  return id;
}

export function reportPath(runId: string): string {
  return join(REPORTS, `${runId}.final-report.json`);
}
export const hasReport = (runId: string) => existsSync(reportPath(runId));

/** Environment for a child: the parent's, minus the test hooks, plus overrides. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NT_CRASH_AT;
  delete env.NT_MUTATION;
  return { ...env, ...extra };
}

export type RunResult = { code: number | null; signal: NodeJS.Signals | null; out: string; ms: number };

/** Runs a command to completion. Output goes to out/logs/<log>.log and, with `prefix`, to the terminal line by line. */
export function runCmd(o: { command: string; args: string[]; env?: NodeJS.ProcessEnv; prefix?: string; log?: string; filter?: (line: string) => boolean; quiet?: boolean }): Promise<RunResult> {
  mkdirSync(LOG_DIR, { recursive: true });
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(o.command, o.args, { cwd: ROOT, env: o.env ?? childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let carry = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      out += text;
      if (o.log) appendFileSync(join(LOG_DIR, `${o.log}.log`), text);
      if (o.quiet) return;
      carry += text;
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const l of lines) if (l.trim() !== "" && !l.startsWith("<claude-code-hint") && (!o.filter || o.filter(l))) console.log(o.prefix ? `${o.prefix} ${l}` : l);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (!o.quiet && carry && (!o.filter || o.filter(carry))) console.log(o.prefix ? `${o.prefix} ${carry}` : carry);
      resolve({ code, signal, out, ms: Date.now() - started });
    });
  });
}

export const runnerCmd = (runId: string, extra: string[] = []) => ({ command: TSX, args: ["--env-file-if-exists=.env", "apps/runner/src/cli.ts", "--run", runId, ...extra] });
export const reconcileCmd = (runId: string, extra: string[] = []) => ({ command: TSX, args: ["--env-file-if-exists=.env", "apps/reconciler/src/cli.ts", "--run", runId, ...extra] });
/** `--report-only` for a run. The control arm's report comes from the baselines CLI: the runner's own --report-only rebuilds from payment_intents, which control does not have. */
export const reportOnlyCmd = (arm: string, runId: string) =>
  arm === "control"
    ? { command: process.execPath, args: ["--env-file-if-exists=.env", "packages/baselines/src/control-cli.ts", "--run", runId, "--report-only"] }
    : runnerCmd(runId, ["--report-only"]);
export const evaluatorCheck = (runId: string) => ({ command: process.execPath, args: ["--env-file-if-exists=evaluator/.env", "evaluator/src/cli.ts", "check", "--run", runId] });

export const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
