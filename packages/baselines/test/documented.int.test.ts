// E5-INT (Tier 2): arm B (`documented`) against an in-memory replica set and the REAL provider simulator on an ephemeral port, scenario S0,
// replayed model cassettes. Run 2 spawns the real CLI and SIGKILLs it at CTRL_AFTER_PROVIDER_RESPONSE. What is asserted is what HANDOVER.md
// §15 predicts; whatever the arm does is what the test records (a surprise would fail the test and be reported, not hidden).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FinalReport, marker } from "@nt/contracts";
import { openNtDb, type NtDb } from "@nt/db";
import { startTestReplSet, type TestReplSet } from "@nt/db/testing";
import { runDocumented, type BaselineDoc } from "../src/index.ts";
import { K, REPO_ROOT, byKey, depsFor, listPayments, seedControlRun } from "./support/seed.ts";
import { SIM_KEYS, SimProcess } from "./support/sim-process.ts";

let repl: TestReplSet;
let db: NtDb;
let sim: SimProcess;
const reportDir = mkdtempSync(join(tmpdir(), "nt-doc-reports-"));
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

const seed = (o: Parameters<typeof seedControlRun>[2] = {}) => seedControlRun(db, sim, { ...o, arm: "documented" });
const baselineOf = async (runId: string, claimId: string): Promise<BaselineDoc> =>
  ((await db.claims.findOne({ _id: `${runId}:${claimId}` })) as unknown as { baseline: BaselineDoc }).baseline;

describe("documented arm B (S0, replayed cassettes, real simulator)", () => {
  it("(1) no faults: every owed payment paid once, with the stable key Never Twice would use", async () => {
    const { runId, account } = await seed();
    await runDocumented(depsFor(db, sim, runId, reportDir));
    const objs = await listPayments(sim, account);
    for (const k of [K.P02, K.P13, K.P11, K.P03, K.P03R]) expect(byKey(objs, k), k).toHaveLength(1);
    expect(objs).toHaveLength(5);
    const c02 = await baselineOf(runId, "C02");
    expect(c02.payments[0]!.attempts[0]!.idempotency_key).toBe(marker(runId, K.P02)); // same derivation as the nt intent id
    expect((await baselineOf(runId, "C11")).payments[0]!.attempts[0]!.idempotency_key).toBeNull(); // keyless rail: no key exists
    const run = await db.runs.findOne({ _id: runId });
    expect(run?.status).toBe("ENDED");
    expect(run?.arm).toBe("documented");
    const report = FinalReport.parse(JSON.parse(readFileSync(join(reportDir, `${runId}.final-report.json`), "utf8")));
    expect(report.complete).toBe(true);
    expect(report.arm).toBe("documented");
    expect(report.paid.map((p) => p.effect_key).sort()).toEqual([K.P02, K.P13, K.P11, K.P03, K.P03R].sort());
  }, 60_000);

  it("(2) S0 kill after the provider response for P02, restart: NOT paid twice (the stable key dedupes), step re-executed with the same key", async () => {
    const { runId, account } = await seed();
    const cwd = mkdtempSync(join(tmpdir(), "nt-doc-cwd-"));
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
      expect(byKey(await listPayments(sim, account), K.P02)).toHaveLength(1);
      const killed = await baselineOf(runId, "C02");
      expect(killed.done).toBe(false);
      expect(killed.payments).toHaveLength(0); // the answer was never checkpointed: the step will be re-executed

      const second = await runCli(env());
      expect(second.code, second.out).toBe(0);
      const objs = await listPayments(sim, account);
      expect(byKey(objs, K.P02)).toHaveLength(1); // the provider replayed the first answer: ONE payment
      for (const k of [K.P13, K.P11, K.P03, K.P03R]) expect(byKey(objs, k), k).toHaveLength(1);
      const resumed = await baselineOf(runId, "C02");
      expect(resumed.done).toBe(true);
      expect(resumed.payments[0]!.attempts.map((a) => a.idempotency_key)).toEqual([marker(runId, K.P02)]); // the same key as before the kill
      const report = FinalReport.parse(JSON.parse(readFileSync(join(cwd, "out/reports", `${runId}.final-report.json`), "utf8")));
      expect(report.complete).toBe(true);
      expect(report.paid.filter((p) => p.effect_key === K.P02)).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);

  it("(3) DROP_REQUEST on P13 (instant rail): the retry carries the SAME key and pays once", async () => {
    const { runId, account } = await seed({ faults: [{ match: { payee_ref: "payee_P13" }, fault: "DROP_REQUEST", times: 1 }] });
    await runDocumented(depsFor(db, sim, runId, reportDir));
    expect(byKey(await listPayments(sim, account), K.P13)).toHaveLength(1);
    const attempts = (await baselineOf(runId, "C13")).payments[0]!.attempts;
    expect(attempts.map((a) => a.outcome)).toEqual(["INDETERMINATE", "ACCEPTED"]);
    expect(new Set(attempts.map((a) => a.idempotency_key)).size).toBe(1);
  }, 60_000);

  it("(4) retries exhausted (four dropped requests): marked failed, the run continues, the report says complete and lists a failure", async () => {
    const { runId, account } = await seed({ faults: [{ match: { payee_ref: "payee_P13" }, fault: "DROP_REQUEST", times: 4 }] });
    await runDocumented(depsFor(db, sim, runId, reportDir));
    const objs = await listPayments(sim, account);
    expect(byKey(objs, K.P13)).toHaveLength(0); // never reached the provider
    expect(byKey(objs, K.P02)).toHaveLength(1); // the run continued
    const p = (await baselineOf(runId, "C13")).payments[0]!;
    expect(p.attempts).toHaveLength(4); // 1 + three retries
    expect(p).toMatchObject({ result: "FAILED", code: "RETRIES_EXHAUSTED" });
    const report = FinalReport.parse(JSON.parse(readFileSync(join(reportDir, `${runId}.final-report.json`), "utf8")));
    expect(report.complete).toBe(true);
    expect(report.failed_no_effect.map((f) => f.effect_key)).toContain(K.P13);
    expect(report.unresolved).toEqual([]);
  }, 60_000);

  it("(5) late commit on the keyless rail (P11): two payments at the provider; the report says complete, paid once, nothing unresolved", async () => {
    const { runId, account } = await seed({ faults: [{ match: { payee_ref: "payee_P11" }, fault: "LATE_COMMIT_ON_RELEASE", times: 1 }] });
    await runDocumented(depsFor(db, sim, runId, reportDir));
    expect(byKey(await listPayments(sim, account), K.P11)).toHaveLength(1); // the retry paid; the first request is still held
    const attempts = (await baselineOf(runId, "C11")).payments[0]!.attempts;
    expect(attempts.map((a) => a.outcome)).toEqual(["INDETERMINATE", "ACCEPTED"]);
    expect(attempts.every((a) => a.idempotency_key === null)).toBe(true); // a stable key cannot be sent on a rail that takes none
    const report = FinalReport.parse(JSON.parse(readFileSync(join(reportDir, `${runId}.final-report.json`), "utf8")));
    expect(report.complete).toBe(true);
    expect(report.unresolved).toEqual([]);
    expect(report.paid.filter((p) => p.effect_key === K.P11)).toHaveLength(1);

    await sim.release(account, { payee_ref: "payee_P11" });
    const p11 = byKey(await listPayments(sim, account), K.P11);
    expect(p11).toHaveLength(2); // measured: arm B pays twice on the keyless rail late commit, as §15 predicts
    expect(p11[0]!.metadata["nt_effect_key"]).toBe(p11[1]!.metadata["nt_effect_key"]);
  }, 60_000);
});
