// Test helpers: start the real simulator on an ephemeral port with a temporary data dir and talk HTTP to it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson } from "../src/canonical.ts";
import { startServer } from "../src/server.ts";
import type { RunningSim } from "../src/server.ts";

export const KEYS = { write: "test-write-key", read: "test-read-key", evalRead: "test-eval-read-key", admin: "test-admin-key" };

export type FrozenOpts = {
  account: string;
  payee_ref?: string;
  amount_minor?: number;
  currency?: string;
  rail?: "instant" | "legacy";
  operation?: "PAYOUT" | "REFUND";
  marker?: string;
  parent_ref?: string | null;
};

export function frozen(o: FrozenOpts): string {
  const payee = o.payee_ref ?? "payee_P02";
  const marker = o.marker ?? `run1:EFFECT.${payee}`;
  return canonicalJson({
    provider: o.rail === "legacy" ? "sim_keyless" : "sim_payout",
    operation: o.operation ?? "PAYOUT",
    account: o.account,
    rail: o.rail ?? "instant",
    amount_minor: o.amount_minor ?? 70000,
    currency: o.currency ?? "CAD",
    payee_ref: payee,
    parent_ref: o.parent_ref ?? null,
    metadata: { nt_marker: marker, nt_effect_key: marker.split(":")[1] ?? marker, nt_run_id: "run1", nt_type: "APPR_DELAY" },
  });
}

export type Res = { status: number; headers: Headers; json: any } | { timeout: true };

export class TestSim {
  sim!: RunningSim;
  base!: string;
  dir!: string;
  private n = 0;

  static async start(dir?: string): Promise<TestSim> {
    const t = new TestSim();
    t.dir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "nt-sim-test-"));
    t.sim = await startServer({ port: 0, dataDir: t.dir, keys: KEYS });
    t.base = `http://127.0.0.1:${t.sim.port}`;
    return t;
  }

  async stop(removeDir = true): Promise<void> {
    await this.sim.close();
    if (removeDir) fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Raw request. A `timeout` result means the server never answered within timeoutMs. */
  async call(method: string, p: string, o: { key?: string | null; body?: string | object; idem?: string; timeoutMs?: number } = {}): Promise<Res> {
    const headers: Record<string, string> = {};
    const key = o.key === undefined ? KEYS.write : o.key;
    if (key !== null) headers.Authorization = `Bearer ${key}`;
    if (o.idem) headers["Idempotency-Key"] = o.idem;
    let body: string | undefined;
    if (o.body !== undefined) {
      body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
      headers["Content-Type"] = "application/json";
    }
    try {
      const r = await fetch(this.base + p, { method, headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 5000) });
      const text = await r.text();
      return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { timeout: true };
      throw e;
    }
  }

  get(p: string, key: string | null = KEYS.write) {
    return this.call("GET", p, { key });
  }

  admin(method: "GET" | "POST", p: string, body?: object) {
    return this.call(method, p, { key: KEYS.admin, body });
  }

  /** Fresh account per call so tests never share state. */
  async account(o: { retention_ms?: number; search_lag_ms?: number; max_in_flight_ms?: number | null } = {}): Promise<string> {
    const account = `acct_t${++this.n}_${Math.random().toString(36).slice(2, 7)}`;
    const r = await this.admin("POST", "/admin/accounts", { account, ...o });
    if ("timeout" in r || r.status !== 201) throw new Error("account creation failed: " + JSON.stringify(r));
    return account;
  }

  async faults(account: string, faults: object[]) {
    const r = await this.admin("POST", "/admin/faults", { account, faults });
    if ("timeout" in r || r.status !== 200) throw new Error("fault install failed: " + JSON.stringify(r));
  }

  /** POST /v1/payouts with a client timeout (short, for requests the simulator is meant to leave unanswered). */
  pay(body: string, o: { idem?: string; timeoutMs?: number; key?: string | null } = {}) {
    return this.call("POST", "/v1/payouts", { body, idem: o.idem, timeoutMs: o.timeoutMs ?? 5000, key: o.key });
  }
}

export function ok(r: Res): { status: number; headers: Headers; json: any } {
  if ("timeout" in r) throw new Error("expected a response, got a timeout");
  return r;
}

export const NO_RESPONSE_MS = 300;
