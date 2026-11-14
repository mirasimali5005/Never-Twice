// DEM-01 (task H2): scenario S0 end to end, written against the commands of DEMO_RUNBOOK.md section 4 and TEST_PLAN REC-05 / DEM-05.
//
//   seed S0 with F-DEMO into a fresh group (three arms)
//   nt arm      : runner killed at BR_DISPATCH_RESPONSE_RECEIVED@<P02 effect key>; P02 is DISPATCHING; runner restarted;
//                 reconciler --until-drained; runner --report-only; evaluator check -> SAFETY PASS
//   control arm : same kill at CTRL_AFTER_PROVIDER_RESPONSE; restart pays P02 twice; evaluator FAILs C1
//   nt_mutant   : M2 under the same kill; evaluator FAILs C5
//
// Environment: a mongodb-memory-server replica set and a simulator on an ephemeral port (default), or the event sandbox with NT_E2E_SANDBOX=1.
// Stripe: P03's ticket refund goes through Stripe test mode when NT_STRIPE_ENABLED is not "false" and STRIPE_SECRET_KEY and EVAL_STRIPE_KEY are set
// (process environment or .env / evaluator/.env, test keys only); otherwise through the simulator. Model: intake in replay; the reconciler's
// investigator is the deterministic one (no `claude` on PATH) unless NT_E2E_INVESTIGATOR=llm.
//
// The runner, reconciler and control arm are built by other tasks. Until their entry points exist this file SKIPS with "not runnable yet: missing <path>".
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NtDb } from "../../packages/db/src/index.ts";
import { auditRun, commitmentSha256, type Audit } from "../helpers/evaluator.ts";
import { runNode, tail } from "../helpers/proc.ts";
import { PATHS, REPO, reconcilerEntry, startWorld, type Seeded, type World } from "../helpers/world.ts";

// ------------------------------------------------------------------------------------------------ not runnable yet?

const rel = (p: string) => p.replace(`${REPO}/`, "");
const missing: string[] = [];
if (!existsSync(PATHS.runner)) missing.push(rel(PATHS.runner));
if (!reconcilerEntry()) missing.push("apps/reconciler/src/cli.ts (or main.ts)");
if (!existsSync(PATHS.control)) missing.push(`${rel(PATHS.control)} (the control arm, run through the runner CLI)`);
const notRunnable = missing.length > 0 ? `not runnable yet: missing ${missing.join(", ")}` : null;
if (notRunnable) console.warn(`[DEM-01] ${notRunnable}`);

// ------------------------------------------------------------------------------------------------ S0 facts (DEMO_RUNBOOK section 3)

const K = {
  P02: "ZT4H9X.P02.NT101-20261110.APPR_DELAY",
  P13: "KS2R9B.P13.NT880-20261110.APPR_DELAY",
  P11: "PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING",
} as const;
const KILL_NT = `BR_DISPATCH_RESPONSE_RECEIVED@${K.P02}`;
const KILL_CONTROL = `CTRL_AFTER_PROVIDER_RESPONSE@${K.P02}`;
const MIN = 60_000;

function defineDem01(): void {
  describe("DEM-01 S0 end to end: the kill at P02, recovery, and the auditor", () => {
  let world: World;
  let seeded: Seeded;
  let db: NtDb;
  const run = {} as Record<"nt" | "control" | "nt_mutant", string>;
  const audits = {} as Record<"nt" | "control" | "nt_mutant", Audit>;

  const runnerArgs = (arm: string, extra: string[] = []) => [PATHS.runner, "--run", run[arm as keyof typeof run], "--arm", arm, ...extra];
  const runnerEnv = (arm: string, extra: Record<string, string> = {}) => world.procEnv("runner", { NT_RUN_ID: run[arm as keyof typeof run], NT_ARM: arm, ...(arm === "nt_mutant" ? { NT_MUTATION: "M2" } : {}), ...extra });

  /** Runs the runner with the kill spec and asserts that the process died by SIGKILL (a real kill, HANDOVER section 16). */
  async function runUntilKilled(arm: "nt" | "control" | "nt_mutant", crashAt: string) {
    const r = await runNode(runnerArgs(arm), runnerEnv(arm, { NT_CRASH_AT: crashAt }), { cwd: REPO, timeoutMs: 2 * MIN, label: `runner ${arm} (kill at ${crashAt.split("@")[0]})` });
    expect(r.signal === "SIGKILL" || r.code === 137, `${arm} runner should die by SIGKILL; exit code ${r.code}, signal ${r.signal}\n${tail(r.stdout)}\n${tail(r.stderr)}`).toBe(true);
  }

  /** Restarts the runner on the same run id without a crash spec: the pass finishes and writes its report. */
  async function restartRunner(arm: "nt" | "control" | "nt_mutant") {
    const r = await runNode(runnerArgs(arm), runnerEnv(arm), { cwd: REPO, timeoutMs: 2 * MIN, label: `runner ${arm} restart` });
    expect(r.code, `${arm} runner restart\n${tail(r.stdout)}\n${tail(r.stderr)}`).toBe(0);
  }

  async function reconcileUntilDrained(arm: "nt" | "nt_mutant") {
    const entry = reconcilerEntry()!;
    const env = world.procEnv("reconciler", { NT_RUN_ID: run[arm], NT_ARM: arm, ...(arm === "nt_mutant" ? { NT_MUTATION: "M2" } : {}) });
    const r = await runNode([entry, "--run", run[arm], "--until-drained"], env, { cwd: REPO, timeoutMs: 3 * MIN, label: `reconcile ${arm} --until-drained` });
    expect(r.code, `reconcile ${arm}\n${tail(r.stdout)}\n${tail(r.stderr)}`).toBe(0);
  }

  async function reportOnly(arm: "nt" | "control" | "nt_mutant") {
    const r = await runNode(runnerArgs(arm, ["--report-only"]), runnerEnv(arm), { cwd: REPO, timeoutMs: MIN, label: `runner ${arm} --report-only` });
    expect(r.code, `report-only ${arm}\n${tail(r.stdout)}\n${tail(r.stderr)}`).toBe(0);
  }

  const intent = (arm: keyof typeof run, key: string) => db.intents.findOne({ _id: `${run[arm]}:${key}` });
  const intentsMatching = (arm: keyof typeof run, re: RegExp) => db.intents.find({ run_id: run[arm], effect_key: { $regex: re.source } }).toArray();

  beforeAll(async () => {
    world = await startWorld();
    seeded = await world.seedS0();
    for (const r of seeded.runs) run[r.arm as keyof typeof run] = r.run_id;
    db = await world.openDb();
    console.warn(`[DEM-01] database: ${world.sandbox ? "sandbox" : "in-memory replica set"}; Stripe: ${world.stripe.on ? "test mode" : `off (${world.stripe.why}); P03's refund uses the simulator`}`);
  }, 5 * MIN);

  afterAll(async () => {
    await db?.close().catch(() => {});
    await world?.stop();
  });

  it("seeds one group of three SEEDED runs and commits the manifest before any run", async () => {
    expect(seeded.group_id).toMatch(/^g[0-9a-z]{7}$/);
    expect(Object.keys(run).sort()).toEqual(["control", "nt", "nt_mutant"]);
    for (const id of Object.values(run)) expect(id).toMatch(/^r[0-9a-z]{7}$/);
    const docs = await db.runs.find({ group_id: seeded.group_id }).toArray();
    expect(docs.map((d) => d.status)).toEqual(["SEEDED", "SEEDED", "SEEDED"]);
    expect(await db.intents.countDocuments({ run_id: { $in: Object.values(run) } })).toBe(0);
    expect(commitmentSha256(seeded.group_id)).toBe(seeded.manifest_sha256);
  });

  it(
    "nt: the kill at P02 leaves P02 DISPATCHING and P13 and P11 OUTCOME_UNKNOWN",
    async () => {
      await runUntilKilled("nt", KILL_NT);
      expect((await intent("nt", K.P02))?.state).toBe("DISPATCHING");
      expect((await intent("nt", K.P13))?.state).toBe("OUTCOME_UNKNOWN");
      expect((await intent("nt", K.P11))?.state).toBe("OUTCOME_UNKNOWN");
      expect((await db.runs.findOne({ _id: run.nt }))?.status).toBe("RUNNING"); // a killed run stays RUNNING until its runner is restarted
    },
    5 * MIN,
  );

  it(
    "nt: restart, reconciler --until-drained, runner --report-only, then the intents and the investigation records",
    async () => {
      await restartRunner("nt");
      await reconcileUntilDrained("nt");
      await reportOnly("nt");

      // P02: confirmed from provider evidence, no re-send.
      const p02 = await intent("nt", K.P02);
      expect(p02?.state).toBe("CONFIRMED");
      expect(p02?.attempts).toHaveLength(1);
      expect(p02?.evidence).toMatchObject({ source: "PROBE", marker: `${run.nt}:${K.P02}`, amount_minor: 70000, currency: "CAD", payee_ref: "payee_P02" });

      // P13: one licensed same-key re-send (L1), identical request.
      const p13 = await intent("nt", K.P13);
      expect(p13?.state).toBe("CONFIRMED");
      expect(p13?.attempts.map((a) => a.licence)).toEqual(["FIRST_SEND", "L1_SAME_KEY"]);
      expect(new Set(p13?.attempts.map((a) => a.request_sha256)).size).toBe(1);
      expect(p13?.idempotency_key).toBe(p13?._id);
      expect(p13?.evidence).toMatchObject({ source: "REDISPATCH", marker: `${run.nt}:${K.P13}`, amount_minor: 70000, payee_ref: "payee_P13" });

      // P11: parked for a person; nothing re-sent on the keyless rail.
      const p11 = await intent("nt", K.P11);
      expect(p11?.state).toBe("QUARANTINED");
      expect(p11?.quarantine?.reason).toBe("NO_DEDUPE_NO_EVIDENCE");
      expect(p11?.provider).toBe("sim_keyless");
      expect(p11?.attempts).toHaveLength(1);

      // P03: both payments (400.00 compensation on the simulator, 412.60 ticket refund) confirmed; the refund through Stripe when it is on.
      const p03 = await intentsMatching("nt", /\.P03\./);
      expect(p03.map((i) => i.entitlement_type).sort()).toEqual(["APPR_REFUND_COMP", "TICKET_REFUND"]);
      for (const i of p03) expect(i.state, `${i.entitlement_type} state`).toBe("CONFIRMED");
      const refund = p03.find((i) => i.entitlement_type === "TICKET_REFUND")!;
      expect(refund.amount_minor).toBe(41260);
      if (world.stripe.on) expect(refund.provider).toBe("stripe_refund");
      else expect(refund.provider).not.toBe("stripe_refund");

      // P04: refused, never paid.
      expect(await intentsMatching("nt", /\.P04\./)).toHaveLength(0);
      const report = (await db.runs.findOne({ _id: run.nt }))?.final_report;
      expect(report?.group_id).toBe(seeded.group_id);
      expect(report?.refused.map((r) => ({ key: r.effect_key, why: r.reason_code }))).toEqual([expect.objectContaining({ why: "DELAY_UNDER_3H" })]);
      expect(report?.refused[0]?.effect_key).toMatch(/\.P04\./);
      expect(report?.complete).toBe(true); // HANDOVER §14: complete when nothing is RESERVED/DISPATCHING/OUTCOME_UNKNOWN; a parked (QUARANTINED) payment is resolved to a person, not unresolved (property P6)
      expect(report?.parked.map((p) => p.effect_key)).toContain(K.P11);
      expect((await db.runs.findOne({ _id: run.nt }))?.status).toBe("ENDED");

      // Every intent that was unresolved has a closed investigation record; one each for P02, P13 and P11.
      const records = await db.investigations.find({ run_id: run.nt, closed_at: { $ne: null } }).toArray();
      const closedFor = new Set(records.map((r) => r.intent_id));
      for (const k of [K.P02, K.P13, K.P11]) expect(closedFor.has(`${run.nt}:${k}`), `closed investigation record for ${k}`).toBe(true);
    },
    8 * MIN,
  );

  it(
    "nt: the auditor prints SAFETY: PASS and the manifest hash equals its commitment",
    async () => {
      audits.nt = await auditRun(run.nt, world.evaluatorEnv());
      const c = audits.nt.certificate;
      expect(audits.nt.exitCode, audits.nt.text).toBe(0);
      expect(c.safety, audits.nt.text).toBe("PASS");
      expect(audits.nt.text).toContain("SAFETY: PASS");
      expect(c.manifest_sha256).toBe(seeded.manifest_sha256);
      expect(c.commitment_sha256).toBe(seeded.manifest_sha256);
      expect(Object.entries(c.checks).filter(([, v]) => v.status === "FAIL")).toEqual([]);
      expect(c.completion.owed_paid).toEqual([4, 5]); // P11 is parked
      expect(c.completion.refusals_correct).toEqual([1, 1]);
      if (world.stripe.on) expect(c.ledger.stripe_objects, "the ticket refund is read from Stripe").toBeGreaterThanOrEqual(1);
    },
    MIN,
  );

  it(
    "control: the same kill pays P02 twice and the auditor FAILs check C1",
    async () => {
      await runUntilKilled("control", KILL_CONTROL);
      await restartRunner("control"); // the restart re-runs the unfinished claim under a fresh key
      await reportOnly("control");
      audits.control = await auditRun(run.control, world.evaluatorEnv());
      const c = audits.control.certificate;
      expect(audits.control.exitCode, audits.control.text).toBe(1);
      expect(c.safety).toBe("FAIL");
      expect(c.checks.C1?.status, audits.control.text).toBe("FAIL");
      const dup = c.findings.find((f) => f.check === "C1" && f.effect_key === K.P02);
      expect(dup, audits.control.text).toBeDefined();
      expect(dup?.provider_object_ids.length, "two provider objects for one entitlement").toBe(2);
    },
    8 * MIN,
  );

  it(
    "nt_mutant (M2): the auditor FAILs check C5 for the payments it marked confirmed without evidence",
    async () => {
      await runUntilKilled("nt_mutant", KILL_NT);
      await restartRunner("nt_mutant");
      await reconcileUntilDrained("nt_mutant");
      await reportOnly("nt_mutant");
      audits.nt_mutant = await auditRun(run.nt_mutant, world.evaluatorEnv());
      const c = audits.nt_mutant.certificate;
      expect(audits.nt_mutant.exitCode, audits.nt_mutant.text).toBe(1);
      expect(c.safety).toBe("FAIL");
      expect(c.checks.C5?.status, audits.nt_mutant.text).toBe("FAIL");
      const phantom = c.findings.filter((f) => f.check === "C5").map((f) => f.effect_key);
      expect(phantom, audits.nt_mutant.text).toEqual(expect.arrayContaining([K.P13, K.P11]));
    },
    10 * MIN,
  );

  it("the three certificates carry the verdicts the demo promises: PASS, FAIL (C1), FAIL (C5)", () => {
    expect([audits.nt?.certificate.safety, audits.control?.certificate.safety, audits.nt_mutant?.certificate.safety]).toEqual(["PASS", "FAIL", "FAIL"]);
    expect([audits.nt?.exitCode, audits.control?.exitCode, audits.nt_mutant?.exitCode]).toEqual([0, 1, 1]);
  });
  });
}

if (notRunnable) {
  describe("DEM-01 S0 end to end", () => {
    it.skip(notRunnable, () => {});
  });
} else {
  defineDem01();
}
