// E5-INT: arm A (`control`) against an in-memory replica set and the REAL provider simulator on an ephemeral port, scenario S0, replayed
// model cassettes. No model call is made. Run 2 spawns the real CLI and SIGKILLs it at CTRL_AFTER_PROVIDER_RESPONSE.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FinalReport } from "@nt/contracts";
import { openNtDb, type NtDb } from "@nt/db";
import { startTestReplSet, type TestReplSet } from "@nt/db/testing";
import { buildBaselineReport, runControl, type BaselineDoc } from "../src/index.ts";
import { K, REPO_ROOT, byKey, depsFor, listPayments, seedControlRun } from "./support/seed.ts";
import { SIM_KEYS, SimProcess } from "./support/sim-process.ts";

let repl: TestReplSet;
let db: NtDb;
let sim: SimProcess;
const reportDir = mkdtempSync(join(tmpdir(), "nt-ctrl-reports-"));
const CLI = join(REPO_ROOT, "packages/baselines/src/control-cli.ts");

beforeAll(async () => {
  repl = await startTestReplSet();
  db = await openNtDb({ uri: repl.uri, dbName: repl.dbName });
  sim = await SimProcess.start();
}, 180_000);

afterAll(async () => {
  await sim?.stop();
  await db?.close();
  await repl?.stop();
  rmSync(reportDir, { recursive: true, force: true });
});

const baselineOf = async (runId: string, claimId: string): Promise<BaselineDoc> =>
  ((await db.claims.findOne({ _id: `${runId}:${claimId}` })) as unknown as { baseline: BaselineDoc }).baseline;

describe("control arm A (S0, replayed cassettes, real simulator)", () => {
  it("(1) no faults: every owed payment is paid once and the report says complete", async () => {
    const { runId, account } = await seedControlRun(db, sim);
    await runControl(depsFor(db, sim, runId, reportDir));

    const objs = await listPayments(sim, account);
    for (const k of [K.P02, K.P13, K.P11, K.P03, K.P03R]) expect(byKey(objs, k), k).toHaveLength(1);
    expect(objs).toHaveLength(5); // P04's refusal sends nothing
    expect(objs.find((o) => o.metadata["nt_effect_key"] === K.P03R)?.kind).toBe("refund"); // Stripe off: the simulator's REFUND leg
    for (const o of objs) {
      expect(o.metadata["nt_run_id"]).toBe(runId);
      expect(o.metadata["nt_marker"]).toBe(`${runId}:${o.metadata["nt_effect_key"]}`);
    }
    expect(byKey(objs, K.P02)[0]).toMatchObject({ amount_minor: 70000, payee_ref: "payee_P02" });
    expect(byKey(objs, K.P11)[0]).toMatchObject({ amount_minor: 90000 });

    const run = await db.runs.findOne({ _id: runId });
    expect(run?.status).toBe("ENDED");
    const report = FinalReport.parse(JSON.parse(readFileSync(join(reportDir, `${runId}.final-report.json`), "utf8")));
    expect(report.complete).toBe(true);
    expect(report.unresolved).toEqual([]);
    expect(report.paid.map((p) => p.effect_key).sort()).toEqual([K.P02, K.P13, K.P11, K.P03, K.P03R].sort());
    expect(report.refused).toEqual([expect.objectContaining({ reason_code: "DELAY_UNDER_3H" })]);
    expect(report.paid.every((p) => objs.some((o) => o.id === p.provider_object_id))).toBe(true);
    expect(report.group_id).toBe(run?.group_id);
    expect(run?.final_report).toMatchObject({ complete: true });

    // E5-UNIT-01/02: one attempt per payment, a key on the instant rail, none on the keyless rail
    const c02 = await baselineOf(runId, "C02");
    expect(c02.done).toBe(true);
    expect(c02.payments[0]!.attempts).toHaveLength(1);
    expect(c02.payments[0]!.attempts[0]!.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect((await baselineOf(runId, "C11")).payments[0]!.attempts[0]!.idempotency_key).toBeNull();
  }, 60_000);

  it("(2) SIGKILL after the provider response for P02, then restart: P02 is paid TWICE at the provider", async () => {
    const { runId, account } = await seedControlRun(db, sim);
    const cwd = mkdtempSync(join(tmpdir(), "nt-ctrl-cwd-"));
    const env = (crashAt?: string): Record<string, string> => ({
      PATH: process.env["PATH"] ?? "",
      NT_ENV: "local",
      NT_MONGODB_URI: repl.uri,
      NT_DB_NAME: repl.dbName,
      NT_MODEL: "claude-opus-5-5",
      NT_MODEL_MODE: "replay",
      NT_MODEL_CASSETTE_DIR: join(REPO_ROOT, "fixtures/cassettes"),
      NT_STRIPE_ENABLED: "false",
      NT_SIM_URL: sim.baseUrl,
      NT_SIM_WRITE_KEY: SIM_KEYS.write,
      NT_SIM_READ_KEY: SIM_KEYS.read,
      ...(crashAt ? { NT_CRASH_AT: crashAt } : {}),
    });
    const runCli = (e: Record<string, string>): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, "--run", runId], { cwd, env: e, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (out += d.toString()));
        child.on("exit", (code, signal) => resolve({ code, signal, out }));
      });

    try {
      const first = await runCli(env(`CTRL_AFTER_PROVIDER_RESPONSE@${K.P02}`));
      expect(first.signal, first.out).toBe("SIGKILL");
      let objs = await listPayments(sim, account);
      expect(byKey(objs, K.P02)).toHaveLength(1); // the provider applied it...
      const killed = await baselineOf(runId, "C02");
      expect(killed.done).toBe(false); // ...and the control never marked the claim done
      expect(killed.payments[0]!.attempts).toHaveLength(1);
      expect((await db.runs.findOne({ _id: runId }))?.status).toBe("RUNNING"); // a killed run stays RUNNING

      const second = await runCli(env());
      expect(second.code, second.out).toBe(0);
      objs = await listPayments(sim, account);
      const p02 = byKey(objs, K.P02);
      expect(p02).toHaveLength(2); // the demonstration: two objects, one entitlement, the same nt_effect_key
      expect(p02[0]!.id).not.toBe(p02[1]!.id);
      expect(p02[0]!.metadata["nt_effect_key"]).toBe(p02[1]!.metadata["nt_effect_key"]);
      expect(byKey(objs, K.P13)).toHaveLength(1); // claims marked done before the kill are not re-run
      expect(byKey(objs, K.P11)).toHaveLength(1);
      expect(byKey(objs, K.P03)).toHaveLength(1);

      const resumed = await baselineOf(runId, "C02");
      expect(resumed.done).toBe(true);
      const keys = resumed.payments[0]!.attempts.map((a) => a.idempotency_key);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2); // a fresh key on the second try
      const report = FinalReport.parse(JSON.parse(readFileSync(join(cwd, "out/reports", `${runId}.final-report.json`), "utf8")));
      expect(report.complete).toBe(true);
      expect(report.paid.filter((p) => p.effect_key === K.P02)).toHaveLength(1); // what the control believes: paid once
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);

  it("(3) DROP_REQUEST on P13: the blind retry succeeds, paid once", async () => {
    const { runId, account } = await seedControlRun(db, sim, { faults: [{ match: { payee_ref: "payee_P13" }, fault: "DROP_REQUEST", times: 1 }] });
    await runControl(depsFor(db, sim, runId, reportDir));
    const objs = await listPayments(sim, account);
    expect(byKey(objs, K.P13)).toHaveLength(1);
    const attempts = (await baselineOf(runId, "C13")).payments[0]!.attempts;
    expect(attempts.map((a) => a.outcome)).toEqual(["INDETERMINATE", "ACCEPTED"]);
    expect(new Set(attempts.map((a) => a.idempotency_key)).size).toBe(2);
    const report = await buildBaselineReport(runId, { db });
    expect(report.paid.filter((p) => p.effect_key === K.P13)).toHaveLength(1);
    expect(report.complete).toBe(true);
  }, 60_000);

  it("(4) LATE_COMMIT_ON_RELEASE on P11 (legacy rail): the retry pays, then the original lands after release: two objects", async () => {
    const { runId, account } = await seedControlRun(db, sim, { faults: [{ match: { payee_ref: "payee_P11" }, fault: "LATE_COMMIT_ON_RELEASE", times: 1 }] });
    await runControl(depsFor(db, sim, runId, reportDir));
    let objs = await listPayments(sim, account);
    expect(byKey(objs, K.P11)).toHaveLength(1); // the retry paid; the first request is still held
    const attempts = (await baselineOf(runId, "C11")).payments[0]!.attempts;
    expect(attempts.map((a) => a.outcome)).toEqual(["INDETERMINATE", "ACCEPTED"]);
    expect(attempts.every((a) => a.idempotency_key === null)).toBe(true); // the legacy rail takes no key at all
    const report = await buildBaselineReport(runId, { db });
    expect(report.paid.filter((p) => p.effect_key === K.P11)).toHaveLength(1); // the control believes it paid once

    const rel = await sim.release(account, { payee_ref: "payee_P11" });
    expect(rel).toBeTruthy();
    objs = await listPayments(sim, account);
    const p11 = byKey(objs, K.P11);
    expect(p11).toHaveLength(2); // the original landed: paid twice
    expect(p11[0]!.metadata["nt_effect_key"]).toBe(p11[1]!.metadata["nt_effect_key"]);
  }, 60_000);

  it("(5) --pause-before-payout waits for the go file; kill_at_passenger arms the barrier for P02's statutory payment", async () => {
    const { runId, groupId, account } = await seedControlRun(db, sim);
    const cwd = mkdtempSync(join(tmpdir(), "nt-ctrl-go-"));
    try {
      const child = spawn(process.execPath, [CLI, "--run", runId, "--pause-before-payout"], {
        cwd,
        env: {
          PATH: process.env["PATH"] ?? "",
          NT_ENV: "local",
          NT_MONGODB_URI: repl.uri,
          NT_DB_NAME: repl.dbName,
          NT_MODEL: "claude-opus-5-5",
          NT_MODEL_MODE: "replay",
          NT_MODEL_CASSETTE_DIR: join(REPO_ROOT, "fixtures/cassettes"),
          NT_STRIPE_ENABLED: "false",
          NT_SIM_URL: sim.baseUrl,
          NT_SIM_WRITE_KEY: SIM_KEYS.write,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_c, sig) => resolve(sig)));
      const deadline = Date.now() + 20_000;
      while ((await db.runs.findOne({ _id: runId }))?.status !== "PAUSED") {
        if (Date.now() > deadline) throw new Error("run never reached PAUSED");
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await listPayments(sim, account)).toHaveLength(0); // nothing is paid before the go file
      mkdirSync(join(cwd, ".nt"));
      writeFileSync(join(cwd, ".nt", `go-${groupId}.json`), JSON.stringify({ kill_at_passenger: "P02" }));
      expect(await exited).toBe("SIGKILL");
      const objs = await listPayments(sim, account);
      expect(byKey(objs, K.P13)).toHaveLength(1); // C13 came first and was marked done
      expect(byKey(objs, K.P02)).toHaveLength(1); // killed right after the provider applied it
      expect((await baselineOf(runId, "C02")).done).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
