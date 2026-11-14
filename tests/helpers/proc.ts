// Process helpers for the end-to-end tests (task H2): spawn node children, wait for them, wait for a condition, pick a free port.
// Output is captured in memory and never echoed, so a test failure message cannot leak an environment value.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; ms: number };

export type Spawned = { child: ChildProcess; exited: Promise<ExitInfo>; output(): { stdout: string; stderr: string }; kill(signal?: NodeJS.Signals): void };

const MAX_CAPTURE = 256 * 1024;

/** Starts `node <args>` with exactly the given environment (nothing is inherited from the test process). */
export function spawnNode(args: string[], env: Record<string, string>, opts: { cwd: string }): Spawned {
  const started = Date.now();
  const child = spawn(process.execPath, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout = (stdout + d.toString("utf8")).slice(-MAX_CAPTURE);
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString("utf8")).slice(-MAX_CAPTURE);
  });
  const exited = new Promise<ExitInfo>((resolve) => {
    child.on("error", (e) => resolve({ code: null, signal: null, stdout, stderr: `${stderr}\nspawn error: ${e.message}`, ms: Date.now() - started }));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, ms: Date.now() - started }));
  });
  return { child, exited, output: () => ({ stdout, stderr }), kill: (s = "SIGTERM") => void child.kill(s) };
}

/** Runs `node <args>` to completion; kills it with SIGKILL and rejects if it outlives `timeoutMs`. */
export async function runNode(args: string[], env: Record<string, string>, opts: { cwd: string; timeoutMs: number; label: string }): Promise<ExitInfo> {
  const p = spawnNode(args, env, { cwd: opts.cwd });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${opts.label} did not exit within ${opts.timeoutMs} ms; last output:\n${tail(p.output().stdout)}\n${tail(p.output().stderr)}`));
    }, opts.timeoutMs);
  });
  try {
    return await Promise.race([p.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const tail = (s: string, n = 1500) => (s.length > n ? `...${s.slice(-n)}` : s);

export async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, opts: { timeoutMs: number; intervalMs?: number }): Promise<T> {
  const until = Date.now() + opts.timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out after ${opts.timeoutMs} ms waiting for ${what}`);
    await sleep(opts.intervalMs ?? 250);
  }
}

/** A free TCP port on 127.0.0.1 (bound and released; a small race with other processes is accepted). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}
