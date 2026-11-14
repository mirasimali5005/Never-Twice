// Starts the REAL provider simulator (apps/provider-sim/src/server.ts) as a child process on an ephemeral port with test keys
// and a temporary data directory. Nothing is imported from apps/provider-sim: the simulator stays an external process.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SIM_KEYS = {
  write: "it-write-key",
  read: "it-read-key",
  evalRead: "it-eval-read-key",
  admin: "it-admin-key",
};

const SERVER_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/provider-sim/src/server.ts");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export class SimProcess {
  baseUrl = "";
  #child!: ChildProcess;
  #dir = "";
  #n = 0;
  #log = "";

  static async start(): Promise<SimProcess> {
    const sim = new SimProcess();
    const port = await freePort();
    sim.#dir = fs.mkdtempSync(path.join(os.tmpdir(), "nt-baselines-it-"));
    sim.baseUrl = `http://127.0.0.1:${port}`;
    sim.#child = spawn(process.execPath, [SERVER_TS], {
      env: {
        PATH: process.env.PATH ?? "",
        NT_SIM_PORT: String(port),
        NT_SIM_DATA_DIR: sim.#dir,
        NT_SIM_WRITE_KEY: SIM_KEYS.write,
        NT_SIM_READ_KEY: SIM_KEYS.read,
        NT_SIM_EVAL_READ_KEY: SIM_KEYS.evalRead,
        NT_SIM_ADMIN_KEY: SIM_KEYS.admin,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    sim.#child.stdout?.on("data", (d: Buffer) => (sim.#log += d.toString()));
    sim.#child.stderr?.on("data", (d: Buffer) => (sim.#log += d.toString()));
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const r = await fetch(`${sim.baseUrl}/healthz`, { signal: AbortSignal.timeout(500) });
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      if (sim.#child.exitCode !== null) throw new Error(`simulator exited early: ${sim.#log.slice(0, 500)}`);
      if (Date.now() > deadline) throw new Error(`simulator did not start: ${sim.#log.slice(0, 500)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return sim;
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      });
    }
    fs.rmSync(this.#dir, { recursive: true, force: true });
  }

  async admin<T = any>(method: "GET" | "POST", p: string, body?: object): Promise<{ status: number; json: T }> {
    const init: RequestInit = { method, headers: { Authorization: `Bearer ${SIM_KEYS.admin}`, "Content-Type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(`${this.baseUrl}${p}`, init);
    const text = await r.text();
    return { status: r.status, json: (text ? JSON.parse(text) : null) as T };
  }

  /** A fresh account per call so tests never share state. */
  async account(o: { retention_ms?: number; max_in_flight_ms?: number | null; search_lag_ms?: number } = {}): Promise<string> {
    const account = `acct_it${++this.#n}${Math.random().toString(36).slice(2, 7)}`;
    const r = await this.admin("POST", "/admin/accounts", { account, ...o });
    if (r.status !== 201) throw new Error(`account creation failed: ${r.status}`);
    return account;
  }

  async faults(account: string, faults: object[]): Promise<void> {
    const r = await this.admin("POST", "/admin/faults", { account, faults });
    if (r.status !== 200) throw new Error(`fault install failed: ${r.status}`);
  }

  async release(account: string, filter: { payee_ref?: string; marker?: string }): Promise<unknown> {
    return (await this.admin("POST", "/admin/faults/release", { account, ...filter })).json;
  }

  async requestLog(account: string): Promise<Array<{ method: string; path: string; idempotency_key: string | null; body_sha256: string | null; fault: string | null; outcome: string; status: number | null }>> {
    return (await this.admin<{ data: any[] }>("GET", `/admin/request-log?account=${account}`)).json.data;
  }
}
