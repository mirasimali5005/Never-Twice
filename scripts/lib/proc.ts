// Pid files under `.nt/pids/<name>.pid` and process control for the demo launcher and reset.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type PidEntry = { name: string; pid: number; alive: boolean };

export function listPids(ntDir: string): PidEntry[] {
  const dir = join(ntDir, "pids");
  if (!existsSync(dir)) return [];
  const out: PidEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".pid")) continue;
    const pid = Number(readFileSync(join(dir, f), "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) out.push({ name: f.slice(0, -4), pid, alive: isAlive(pid) });
  }
  return out;
}

export function writePid(ntDir: string, name: string, pid: number): void {
  const dir = join(ntDir, "pids");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.pid`), `${pid}\n`);
}

export function removePid(ntDir: string, name: string): void {
  rmSync(join(ntDir, "pids", `${name}.pid`), { force: true });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM, wait up to graceMs, then SIGKILL. Removes the pid file. Returns the names it stopped (alive when found). */
export async function stopProcesses(ntDir: string, match: (name: string) => boolean, graceMs = 3000): Promise<string[]> {
  const stopped: string[] = [];
  for (const p of listPids(ntDir).filter((x) => match(x.name))) {
    if (p.alive) {
      try {
        process.kill(p.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      const until = Date.now() + graceMs;
      while (isAlive(p.pid) && Date.now() < until) await sleep(100);
      if (isAlive(p.pid)) {
        try {
          process.kill(p.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      stopped.push(p.name);
    }
    removePid(ntDir, p.name);
  }
  return stopped;
}

/** Starts a detached process with stdout and stderr appended to `.nt/logs/<name>.log`, writes its pid file, returns the pid. */
export function startDetached(opts: {
  ntDir: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Default `<ntDir>/logs`; the demo scripts pass `out/logs`. */
  logDir?: string;
}): number {
  const logDir = opts.logDir ?? join(opts.ntDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const fd = openSync(join(logDir, `${opts.name}.log`), "a");
  try {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`could not start ${opts.name}`);
    writePid(opts.ntDir, opts.name, child.pid);
    return child.pid;
  } finally {
    closeSync(fd);
  }
}
