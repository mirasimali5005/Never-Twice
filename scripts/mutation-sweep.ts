// pnpm sweep:mutations: the system mutation sweep M1..M5, TEST_PLAN.md section 4.4 and HANDOVER.md section 16 (task H3, Tier 2).
//
// One fresh world per scenario (in-memory replica set, simulator on an ephemeral port, Stripe OFF so the ticket refund is a simulator REFUND), one seeded
// group holding an unmutated `nt` arm and the `nt_mutant` arm(s) on the same inputs and the same fault schedule. Every arm is run with the real runner,
// the real reconciler (deterministic investigator), `--report-only`, the independent auditor and the gateway's invariant scan. A mutation counts as
// DETECTED only when the mutant arm is red (auditor SAFETY: FAIL, or an invariant scan finding) AND the unmutated arm of the same scenario is green.
// Plus one clean control (S0, F-NONE, no mutation) that must stay green.
//
//   scenario                                     what the mutant must trip (TEST_PLAN 4.4)
//   CTRL  S0 / F-NONE, nt only                   nothing (green)
//   M1    S1 / F-NONE, five goodwill proposals   auditor C6 (G06 and G07 are paid beyond the 50000 grant)
//   M2    S0 / F-DEMO, no kill                   auditor C5 (P13 unknown outcome with no provider object, P11 likewise)
//   M3    S0 / F-DEMO, keyless P11 late commit   auditor C1 / C4 after the late commit; see the harness note below
//   M4    S0 / F-DEMO, P13 DROP_REQUEST          the re-sent request carries a changed body: auditor C2
//   M5    S0 / F-NONE, kill after reserve commit of P11, restart proposes again   invariant scan P1; auditor C1 on the keyless rail
//
// M3 harness note. The gateway implements M3 as an option on `resend` ({ unlicensed: true }, accepted only while NT_MUTATION=M3). The product
// reconciler's apply() (apps/reconciler/src/investigate.ts) never passes that option, so running the real reconciler with NT_MUTATION=M3 does not
// exercise the mutation. That is measured here (arm `nt_mutant (real reconciler)`), and the mutation is then exercised by a harness in this script that
// stands in for a mutated reconciler apply: for each OUTCOME_UNKNOWN intent it takes the lease, looks for evidence, and on "not found" re-sends with
// { unlicensed: true } and applies the result. That tests the gateway and the auditor, not a mutated reconciler binary.
//
// Usage: pnpm sweep:mutations [-- --only M4] [--out-name mutation-sweep]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditRun, type Audit } from "../tests/helpers/evaluator.ts";
import { runNode, sleep, tail } from "../tests/helpers/proc.ts";
import { PATHS, REPO, reconcilerEntry, startWorld, type World } from "../tests/helpers/world.ts";
import type { NtDb } from "../packages/db/src/index.ts";
import { parseArgs, runMain } from "./lib/args.ts";
import { evaluatorManifest, seedGroup } from "./lib/seed-core.ts";
import { SimAdmin } from "./lib/sim-admin.ts";

const OUT_DIR = join(REPO, "out", "sweeps");
const MIN = 60_000;

const K = {
  P11: "PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING",
  P13: "KS2R9B.P13.NT880-20261110.APPR_DELAY",
} as const;

type ArmSpec = { label: string; arm: "nt" | "nt_mutant"; mutation: string | null; mutated: boolean; reconciler: "real" | "harness-m3" };
type ArmResult = {
  label: string;
  arm: string;
  mutation: string | null;
  run_id: string;
  runner_exit: string[];
  auditor_safety: string;
  auditor_exit: number | null;
  failed_checks: string[]; // e.g. C5x2
  findings: string[];
  scan_ok: boolean | null;
  scan_findings: string[];
  intents: { effect_key: string; state: string; quarantine_reason: string | null; attempts: number }[];
  provider_objects: number | null;
  provider_objects_per_marker_max: number | null;
  completion: string;
  red: boolean;
  notes: string[];
};
type ScenarioResult = {
  id: string;
  mutation: string | null;
  scenario: string;
  faults: string;
  description: string;
  must_turn_red: string;
  arms: ArmResult[];
  verdict: "DETECTED" | "DETECTED_HARNESS_ONLY" | "NOT_DETECTED" | "CONTROL_GREEN" | "CONTROL_RED" | "UNMUTATED_RED" | "NOT_RUN";
  verdict_detail: string;
  duration_ms: number;
  error: string | null;
};

// ------------------------------------------------------------------------------------------------ helpers

const died = (r: { signal: NodeJS.Signals | null; code: number | null }) => r.signal === "SIGKILL" || r.code === 137;
const exitLabel = (name: string, r: { signal: NodeJS.Signals | null; code: number | null; ms: number }) => `${name}: ${r.signal ?? `exit ${r.code}`} in ${(r.ms / 1000).toFixed(1)} s`;

let startChain: Promise<unknown> = Promise.resolve();
function startWorldSerialized(): Promise<World> {
  const attempt = async (): Promise<World> => {
    let last: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        return await startWorld();
      } catch (e) {
        last = e;
        await sleep(500 * (i + 1));
      }
    }
    throw last;
  };
  const p = startChain.then(attempt, attempt);
  startChain = p.catch(() => undefined);
  return p;
}

type Provided = { id: string; payee_ref: string; metadata: Record<string, string> };
async function listObjects(world: World, account: string): Promise<Provided[]> {
  const readKey = world.evaluatorEnv().EVAL_SIM_READ_KEY!;
  const out: Provided[] = [];
  let after = "";
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${world.simUrl}/v1/payouts?account=${encodeURIComponent(account)}&limit=100${after ? `&starting_after=${after}` : ""}`, { headers: { Authorization: `Bearer ${readKey}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`provider list answered ${res.status}`);
    const body = (await res.json()) as { data: Provided[]; has_more: boolean; next_cursor: string | null };
    out.push(...body.data);
    if (!body.has_more || !body.next_cursor) break;
    after = body.next_cursor;
  }
  return out;
}

/** The scan runs in this process through a gateway built from the reconciler's environment; NT_MUTATION is never set while it runs. */
async function scanRun(world: World, runId: string): Promise<{ ok: boolean; findings: string[] }> {
  const { createGatewayFromEnv } = await import("../packages/gateway/src/index.ts");
  const { closeAll } = await import("../packages/db/src/index.ts");
  const env = { ...world.procEnv("reconciler", { NT_RUN_ID: runId, NT_ARM: "nt" }) } as never;
  try {
    const gw = await createGatewayFromEnv("reconciler", env, { runId, workerId: "mutation-sweep-scan" });
    const rep = await gw.scanInvariants(runId);
    return { ok: rep.ok, findings: rep.violations.map((v) => `${v.code} ${v.detail}`.slice(0, 260)) };
  } finally {
    await closeAll().catch(() => {});
  }
}

type Ctx = { world: World; db: NtDb; sim: SimAdmin; adminKey: string; simAccounts: Map<string, string> };

// ------------------------------------------------------------------------------------------------ one arm

async function runnerStep(ctx: Ctx, spec: ArmSpec, runId: string, notes: string[], opts: { crashAt?: string; report?: boolean } = {}) {
  const env = ctx.world.procEnv("runner", { NT_RUN_ID: runId, NT_ARM: spec.arm, ...(spec.mutation ? { NT_MUTATION: spec.mutation } : {}), ...(opts.crashAt ? { NT_CRASH_AT: opts.crashAt } : {}) });
  const args = [PATHS.runner, "--run", runId, "--arm", spec.arm, ...(opts.report ? ["--report-only"] : [])];
  const r = await runNode(args, env, { cwd: REPO, timeoutMs: 3 * MIN, label: `runner ${spec.label}${opts.report ? " --report-only" : ""}` });
  notes.push(exitLabel(opts.report ? "report-only" : opts.crashAt ? `runner (armed ${opts.crashAt.split("@")[0]})` : "runner", r));
  return r;
}

async function reconcileStep(ctx: Ctx, spec: ArmSpec, runId: string, notes: string[], extra: string[] = ["--until-drained"]) {
  const entry = reconcilerEntry();
  if (!entry) throw new Error("no reconciler entry point");
  const env = ctx.world.procEnv("reconciler", {
    NT_RUN_ID: runId,
    NT_ARM: spec.arm,
    NT_RECONCILER_INVESTIGATOR: "deterministic",
    NT_RECALL_ENABLED: "false",
    ...(spec.mutation ? { NT_MUTATION: spec.mutation } : {}),
  });
  const r = await runNode([entry, "--run", runId, ...extra], env, { cwd: REPO, timeoutMs: 4 * MIN, label: `reconcile ${spec.label}` });
  notes.push(exitLabel(`reconcile ${extra.join(" ")}`, r) + (r.code === 0 ? "" : ` | ${tail(r.stderr, 300)}`));
  return r;
}

/** M3 stand-in for a mutated reconciler apply(): lease, look for evidence, on "not found" re-send WITHOUT a licence. */
async function m3Harness(ctx: Ctx, runId: string, notes: string[]): Promise<void> {
  const { createGatewayFromEnv } = await import("../packages/gateway/src/index.ts");
  const { closeAll } = await import("../packages/db/src/index.ts");
  const env = { ...ctx.world.procEnv("reconciler", { NT_RUN_ID: runId, NT_ARM: "nt" }) } as never;
  process.env.NT_MUTATION = "M3"; // read by the gateway's mutation switch at call time; restored below
  try {
    const gw = await createGatewayFromEnv("reconciler", env, { runId, workerId: "reconciler-m3-harness" });
    const deadline = Date.now() + 60_000;
    const done = new Set<string>();
    for (;;) {
      const unknown = (await ctx.db.intents.find({ run_id: runId, state: "OUTCOME_UNKNOWN" }).toArray()).filter((i) => !done.has(i._id));
      if (unknown.length === 0) break;
      if (Date.now() > deadline) {
        notes.push(`harness: gave up on ${unknown.map((u) => u.effect_key).join(", ")} after 60 s`);
        break;
      }
      for (const it of unknown) {
        const leased = await gw.acquireLease(it._id, it.lease_epoch);
        if (!leased) {
          await sleep(300); // lease not yet takeable (next_attempt_at or a live lease)
          continue;
        }
        const ev = await gw.findEvidence(leased);
        const found = ev.records.length > 0;
        notes.push(`harness: ${it.effect_key} evidence records ${ev.records.length} (complete ${ev.complete})`);
        if (found) {
          done.add(it._id);
          notes.push(`harness: ${it.effect_key} had evidence; not re-sent (the harness only re-sends on "not found")`);
          continue;
        }
        const res = await gw.resend(leased, { unlicensed: true });
        const after = await gw.applyResendResult(leased, res);
        done.add(it._id);
        notes.push(`harness: ${it.effect_key} re-sent WITHOUT a licence -> ${res.kind} -> ${after?.state ?? "no change"}`);
      }
    }
    await closeAll().catch(() => {});
  } finally {
    delete process.env.NT_MUTATION;
  }
}

async function finishArm(ctx: Ctx, spec: ArmSpec, runId: string, notes: string[], runnerExit: string[]): Promise<ArmResult> {
  const { world, db } = ctx;
  const rep = await runnerStep(ctx, spec, runId, notes, { report: true });
  runnerExit.push(exitLabel("report-only", rep));
  const audit: Audit = await auditRun(runId, world.evaluatorEnv());
  const failed = Object.entries(audit.certificate.checks).filter(([, v]) => v.status === "FAIL").map(([k, v]) => `${k}x${v.count}`);
  const scan = await scanRun(world, runId);
  const intents = (await db.intents.find({ run_id: runId }).toArray()).sort((a, b) => a._id.localeCompare(b._id));
  const objects = await listObjects(world, ctx.simAccounts.get(runId)!);
  const perMarker = new Map<string, number>();
  for (const o of objects) perMarker.set(o.metadata["nt_marker"] ?? "(none)", (perMarker.get(o.metadata["nt_marker"] ?? "(none)") ?? 0) + 1);
  const c = audit.certificate.completion;
  return {
    label: spec.label,
    arm: spec.arm,
    mutation: spec.mutation,
    run_id: runId,
    runner_exit: runnerExit,
    auditor_safety: audit.certificate.safety,
    auditor_exit: audit.exitCode,
    failed_checks: failed,
    findings: audit.certificate.findings.slice(0, 6).map((f) => `${f.check} ${f.effect_key ?? ""} ${f.message}`.slice(0, 260)),
    scan_ok: scan.ok,
    scan_findings: scan.findings,
    intents: intents.map((i) => ({ effect_key: i.effect_key, state: i.state, quarantine_reason: i.quarantine?.reason ?? null, attempts: i.attempts.length })),
    provider_objects: objects.length,
    provider_objects_per_marker_max: Math.max(0, ...perMarker.values()),
    completion: `owed paid ${c.owed_paid[0]}/${c.owed_paid[1]}, refusals ${c.refusals_correct[0]}/${c.refusals_correct[1]}, holds ${c.holds_correct[0]}/${c.holds_correct[1]}, goodwill ${c.goodwill_paid_minor}/${c.goodwill_eligible_minor}`,
    red: audit.certificate.safety !== "PASS" || audit.exitCode !== 0 || !scan.ok,
    notes,
  };
}

// ------------------------------------------------------------------------------------------------ scenarios

type Scenario = {
  id: string;
  mutation: string | null;
  scenario: "S0" | "S1";
  faults: string;
  description: string;
  must_turn_red: string;
  arms: ArmSpec[];
  /** The ordered work for one arm. */
  drive(ctx: Ctx, spec: ArmSpec, runId: string, notes: string[], runnerExit: string[]): Promise<void>;
  /** After every arm has run its drive(): shared steps (e.g. releasing the late commit). */
  after?(ctx: Ctx, runs: Map<string, string>, specs: ArmSpec[], notes: Map<string, string[]>): Promise<void>;
};

const nt = (label = "nt (unmutated)"): ArmSpec => ({ label, arm: "nt", mutation: null, mutated: false, reconciler: "real" });
const mutant = (id: string, label = `nt_mutant ${id}`, reconciler: "real" | "harness-m3" = "real"): ArmSpec => ({ label, arm: "nt_mutant", mutation: id, mutated: true, reconciler });

/** runner, then the real reconciler until drained. */
async function plainDrive(ctx: Ctx, spec: ArmSpec, runId: string, notes: string[], runnerExit: string[]): Promise<void> {
  runnerExit.push(exitLabel("runner", await runnerStep(ctx, spec, runId, notes)));
  await reconcileStep(ctx, spec, runId, notes);
}

const SCENARIOS: Scenario[] = [
  {
    id: "CTRL",
    mutation: null,
    scenario: "S0",
    faults: "F-NONE",
    description: "Clean control: S0, no faults, no mutation, one `nt` arm: runner, reconciler to drained, report, auditor, scan.",
    must_turn_red: "nothing (must stay green)",
    arms: [nt("nt (no mutation)")],
    drive: plainDrive,
  },
  {
    id: "M1",
    mutation: "M1",
    scenario: "S1",
    faults: "F-NONE",
    description: "S1 with all five goodwill proposals (80000 against the 50000 grant), no faults. The unmutated run leaves G06 and G07 awaiting budget.",
    must_turn_red: "auditor C6 (goodwill payments above the grant)",
    arms: [nt(), mutant("M1")],
    drive: plainDrive,
  },
  {
    id: "M2",
    mutation: "M2",
    scenario: "S0",
    faults: "F-DEMO",
    description: "S0 under F-DEMO (P13 request dropped, P11 late commit held), no kill: P13 and P11 reach OUTCOME_UNKNOWN with no provider object. M2 marks them CONFIRMED with the literal MUTANT_NO_EVIDENCE.",
    must_turn_red: "auditor C5 (phantom: paid with no matching provider object) on K13 and K11",
    arms: [nt(), mutant("M2")],
    drive: plainDrive,
  },
  {
    id: "M3",
    mutation: "M3",
    scenario: "S0",
    faults: "F-DEMO",
    description: "S0 under F-DEMO: P11 (keyless rail) is held as a late commit, P13 (instant rail) dropped. Mutant arm A runs the REAL reconciler with NT_MUTATION=M3 (the product's apply() never passes `unlicensed`); mutant arm B replaces the reconciler with a harness that re-sends without a licence on `not found`. The held late commit is released after every arm has recovered.",
    must_turn_red: "auditor C1 (duplicate P11) or C4 after the late commit lands",
    arms: [nt(), mutant("M3", "nt_mutant M3 (real reconciler)", "real"), mutant("M3", "nt_mutant M3 (re-send harness in place of the reconciler)", "harness-m3")],
    async drive(ctx, spec, runId, notes, runnerExit) {
      runnerExit.push(exitLabel("runner", await runnerStep(ctx, spec, runId, notes)));
      if (spec.reconciler === "harness-m3") await m3Harness(ctx, runId, notes);
      else await reconcileStep(ctx, spec, runId, notes);
    },
    async after(ctx, runs, specs, notes) {
      for (const spec of specs) {
        const runId = runs.get(spec.label)!;
        const rel = await ctx.sim.releaseHeld(ctx.simAccounts.get(runId)!, { payee_ref: "payee_P11" });
        notes.get(spec.label)!.push(`late commit released: ${JSON.stringify(rel)}`);
      }
      // The unmutated arm and the real-reconciler arm watch for the late commit as the demo does (one pass with --watch).
      for (const spec of specs.filter((s) => s.reconciler === "real")) {
        await reconcileStep(ctx, spec, runs.get(spec.label)!, notes.get(spec.label)!, ["--once", "--watch"]);
      }
    },
  },
  {
    id: "M4",
    mutation: "M4",
    scenario: "S0",
    faults: "F-DEMO",
    description: "S0 under F-DEMO: P13's first request is dropped, so the reconciler licenses one re-send under the same key. Under M4 the re-send carries an amount of +100 (a request rebuilt instead of the frozen bytes), and the hash check is skipped.",
    must_turn_red: "auditor C2 (wrong amount) on K13",
    arms: [nt(), mutant("M4")],
    drive: plainDrive,
  },
  {
    id: "M5",
    mutation: "M5",
    scenario: "S0",
    faults: "F-NONE",
    description: "S0, no faults: the runner is killed at BR_RESERVE_AFTER_COMMIT for P11 (the intent is reserved, nothing sent) and restarted, which proposes again. Under M5 the new intent gets a random _id instead of the marker.",
    must_turn_red: "invariant scan P1 (two intents for one effect key); auditor C1 on K11 (keyless rail: both intents send)",
    arms: [nt(), mutant("M5")],
    async drive(ctx, spec, runId, notes, runnerExit) {
      const r1 = await runnerStep(ctx, spec, runId, notes, { crashAt: `BR_RESERVE_AFTER_COMMIT@${K.P11}` });
      runnerExit.push(exitLabel("runner (armed)", r1));
      if (!died(r1)) notes.push("WARNING: the armed barrier did not kill the runner");
      runnerExit.push(exitLabel("runner restart", await runnerStep(ctx, spec, runId, notes)));
      await reconcileStep(ctx, spec, runId, notes);
    },
  },
];

// ------------------------------------------------------------------------------------------------ one scenario

function verdictOf(s: Scenario, arms: ArmResult[]): { verdict: ScenarioResult["verdict"]; detail: string } {
  if (s.id === "CTRL") {
    const a = arms[0]!;
    return a.red ? { verdict: "CONTROL_RED", detail: `control is red: auditor ${a.auditor_safety} ${a.failed_checks.join(" ")} scan ${a.scan_ok ? "ok" : a.scan_findings.join("; ")}` } : { verdict: "CONTROL_GREEN", detail: "auditor SAFETY: PASS and the invariant scan found nothing" };
  }
  const base = arms.find((a) => a.mutation === null)!;
  if (base.red) return { verdict: "UNMUTATED_RED", detail: `the unmutated arm is red (${base.failed_checks.join(" ")} ${base.scan_findings.join("; ")}): the comparison is not valid` };
  const mut = arms.filter((a) => a.mutation !== null);
  const red = mut.filter((a) => a.red);
  const summary = mut.map((a) => `${a.label}: ${a.red ? `RED (auditor ${a.auditor_safety}${a.failed_checks.length ? " " + a.failed_checks.join(" ") : ""}${a.scan_ok ? "" : "; scan " + a.scan_findings.map((f) => f.split(" ")[0]).join(",")})` : "green"}`).join(" | ");
  if (red.length === 0) return { verdict: "NOT_DETECTED", detail: summary };
  // Several mutant arms, only some red: the mutation is exercised only by the arms that turned red (M3: the product reconciler never passes `unlicensed`).
  return red.length < mut.length ? { verdict: "DETECTED_HARNESS_ONLY", detail: summary } : { verdict: "DETECTED", detail: summary };
}

async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const t0 = Date.now();
  const res: ScenarioResult = { id: s.id, mutation: s.mutation, scenario: s.scenario, faults: s.faults, description: s.description, must_turn_red: s.must_turn_red, arms: [], verdict: "NOT_RUN", verdict_detail: "", duration_ms: 0, error: null };
  let world: World | undefined;
  let tmp: string | undefined;
  try {
    world = await startWorldSerialized();
    tmp = mkdtempSync(join(tmpdir(), "nt-mutsweep-"));
    const db = await world.openDb();
    try {
      const seedEnv = world.procEnv("seed");
      const adminKey = seedEnv.NT_SIM_ADMIN_KEY!;
      const sim = new SimAdmin(world.simUrl, adminKey);
      const seeded = await seedGroup({ scenario: s.scenario, arms: s.arms.map((a) => a.arm), faults: s.faults }, { db, sim, ntDir: tmp, commitManifest: evaluatorManifest(), ticketPayment: null });
      const ctx: Ctx = { world, db, sim, adminKey, simAccounts: new Map(seeded.runs.map((r) => [r.run_id, r.sim_account])) };
      const runs = new Map<string, string>(); // label -> run_id
      const notes = new Map<string, string[]>();
      const exits = new Map<string, string[]>();
      s.arms.forEach((spec, i) => {
        runs.set(spec.label, seeded.runs[i]!.run_id);
        notes.set(spec.label, []);
        exits.set(spec.label, []);
      });
      for (const spec of s.arms) await s.drive(ctx, spec, runs.get(spec.label)!, notes.get(spec.label)!, exits.get(spec.label)!);
      if (s.after) await s.after(ctx, runs, s.arms, notes);
      for (const spec of s.arms) res.arms.push(await finishArm(ctx, spec, runs.get(spec.label)!, notes.get(spec.label)!, exits.get(spec.label)!));
      const v = verdictOf(s, res.arms);
      res.verdict = v.verdict;
      res.verdict_detail = v.detail;
    } finally {
      await db.close().catch(() => {});
    }
  } catch (e) {
    res.error = String((e as Error).message ?? e).slice(0, 1500);
    res.verdict = "NOT_RUN";
  } finally {
    await world?.stop().catch(() => {});
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    res.duration_ms = Date.now() - t0;
  }
  return res;
}

// ------------------------------------------------------------------------------------------------ report

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const cellRed = (a: ArmResult) => (a.red ? `RED: auditor ${a.auditor_safety}${a.failed_checks.length ? ` (${a.failed_checks.join(" ")})` : ""}${a.scan_ok ? "" : `; scan ${[...new Set(a.scan_findings.map((f) => f.split(" ")[0]))].join(", ")}`}` : "green: auditor PASS, scan clean");

function markdown(results: ScenarioResult[], meta: Record<string, unknown>): string {
  const L: string[] = [];
  L.push("# System mutation sweep M1 to M5 (task H3, Tier 2)", "");
  L.push(`Generated by \`pnpm sweep:mutations\` at ${String(meta.finished_at)}; commit \`${String(meta.commit)}\`${meta.dirty ? " (working tree had uncommitted changes)" : ""}.`, "");
  L.push("Each scenario is one fresh world (in-memory replica set, simulator on an ephemeral port, Stripe off) with an unmutated `nt` arm and the mutant arm(s) seeded from the same group (same inputs, same fault schedule), run with the real runner and reconciler (deterministic investigator), then the independent auditor and the gateway's invariant scan. **Detected** means the mutant is red (auditor `SAFETY: FAIL` or an invariant scan finding) and the unmutated arm of the same scenario is green. Each scenario is one deterministic execution, not a sample.", "");
  L.push("| ID | Mutation | Scenario run | Expected to turn red | Unmutated `nt` arm | Mutant arm: measured | Verdict |", "|---|---|---|---|---|---|---|");
  const names: Record<string, string> = {
    CTRL: "none (clean control)",
    M1: "goodwill guard removed from the reserve transaction",
    M2: "unknown outcomes marked confirmed without provider evidence",
    M3: "re-send on \"not found\" without a licence",
    M4: "request rebuilt on re-send (amount + 100, hash check skipped)",
    M5: "random intent `_id` instead of the marker",
  };
  for (const r of results) {
    const base = r.arms.find((a) => a.mutation === null);
    const muts = r.arms.filter((a) => a.mutation !== null);
    const scen = `${r.scenario} / ${r.faults}: ${r.description}`;
    const mutCell = r.id === "CTRL" ? "(not applicable)" : muts.map((a) => `${muts.length > 1 ? `**${a.label}**: ` : ""}${cellRed(a)}`).join("<br>") || "(no run)";
    const verdict = r.verdict === "DETECTED" ? "**DETECTED**" : r.verdict === "DETECTED_HARNESS_ONLY" ? "**DETECTED only by the stand-in harness; NOT exercised by the real reconciler (green)**" : r.verdict === "NOT_DETECTED" ? "**NOT DETECTED**" : r.verdict === "CONTROL_GREEN" ? "**GREEN (as required)**" : r.verdict;
    L.push(`| ${r.id} | ${names[r.id] ?? r.id} | ${scen} | ${r.must_turn_red} | ${base ? cellRed(base) : r.error ? "NOT RUN" : "-"} | ${mutCell} | ${verdict}${r.error ? ` (error: ${r.error.slice(0, 120)})` : ""} |`);
  }
  L.push("");
  const det = results.filter((r) => r.verdict === "DETECTED" || r.verdict === "DETECTED_HARNESS_ONLY").length;
  const nm = results.filter((r) => r.id !== "CTRL").length;
  const hOnly = results.filter((r) => r.verdict === "DETECTED_HARNESS_ONLY").map((r) => r.id);
  L.push(`**${det} of ${nm} mutations detected**${hOnly.length ? ` (${hOnly.join(", ")} only by a stand-in harness: the product's reconciler does not exercise it)` : ""} (${results.filter((r) => r.verdict === "NOT_DETECTED").map((r) => r.id).join(", ") || "none"} not detected; ${results.filter((r) => r.verdict === "NOT_RUN" || r.verdict === "UNMUTATED_RED").map((r) => r.id).join(", ") || "none"} not run or invalid); clean control: ${results.find((r) => r.id === "CTRL")?.verdict ?? "not run"}.`, "");
  L.push("## Per-arm detail", "");
  for (const r of results) {
    L.push(`### ${r.id}: ${names[r.id] ?? ""}`, "");
    if (r.error) L.push(`Error: ${r.error}`, "");
    for (const a of r.arms) {
      L.push(`- **${a.label}** (run ${a.run_id}): auditor ${a.auditor_safety} (exit ${a.auditor_exit})${a.failed_checks.length ? `, failed checks ${a.failed_checks.join(" ")}` : ""}; scan ${a.scan_ok ? "clean" : a.scan_findings.join(" | ")}; ${a.completion}; provider objects ${a.provider_objects} (at most ${a.provider_objects_per_marker_max} per marker).`);
      for (const f of a.findings.slice(0, 3)) L.push(`  - finding: ${f}`);
      const st = a.intents.reduce<Record<string, number>>((m, i) => ({ ...m, [i.state + (i.quarantine_reason ? `:${i.quarantine_reason}` : "")]: (m[i.state + (i.quarantine_reason ? `:${i.quarantine_reason}` : "")] ?? 0) + 1 }), {});
      L.push(`  - intents: ${a.intents.length} (${Object.entries(st).map(([k, v]) => `${k} ${v}`).join(", ")})`);
      for (const n of a.notes.filter((x) => x.startsWith("harness") || x.startsWith("late commit") || x.startsWith("WARNING"))) L.push(`  - ${n}`);
    }
    L.push("");
  }
  L.push(`Environment: ${String(meta.environment)}. Wall time ${(Number(meta.wall_ms) / 60000).toFixed(1)} min.`, "");
  return L.join("\n");
}

// ------------------------------------------------------------------------------------------------ main

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2), ["only", "out-name"]);
  const only = a.values.get("only");
  const outName = a.values.get("out-name") ?? "mutation-sweep";
  // The sweep is about the gateway and the simulator, not Stripe: the ticket refund goes through the simulator.
  process.env.NT_STRIPE_ENABLED = "false";
  delete process.env.NT_MUTATION;
  const t0 = Date.now();
  const list = SCENARIOS.filter((s) => !only || only.split(",").includes(s.id));
  if (list.length === 0) throw new Error(`--only ${only} matches no scenario`);
  const results: ScenarioResult[] = [];
  for (const s of list) {
    console.error(`scenario ${s.id}: ${s.description.slice(0, 90)}`);
    const r = await runScenario(s);
    results.push(r);
    console.error(`  -> ${r.verdict}${r.error ? ` ERROR ${r.error.slice(0, 300)}` : ""}: ${r.verdict_detail} (${(r.duration_ms / 1000).toFixed(0)} s)`);
  }
  const meta = {
    finished_at: new Date().toISOString(),
    commit: git(["rev-parse", "--short", "HEAD"]),
    dirty: git(["status", "--porcelain", "--", "packages", "apps", "scripts/mutation-sweep.ts"]) !== "",
    environment: `node ${process.version}, ${process.platform}/${process.arch}, mongodb-memory-server replica set and simulator per scenario, Stripe off`,
    wall_ms: Date.now() - t0,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${outName}.json`), `${JSON.stringify({ meta, results }, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, `${outName}.md`), markdown(results, meta));
  const det = results.filter((r) => r.verdict === "DETECTED" || r.verdict === "DETECTED_HARNESS_ONLY").map((r) => (r.verdict === "DETECTED_HARNESS_ONLY" ? `${r.id} (harness only)` : r.id));
  const missed = results.filter((r) => r.verdict === "NOT_DETECTED").map((r) => r.id);
  const other = results.filter((r) => !["DETECTED", "DETECTED_HARNESS_ONLY", "NOT_DETECTED", "CONTROL_GREEN"].includes(r.verdict)).map((r) => `${r.id}:${r.verdict}`);
  console.log(`mutation sweep: ${det.length} of ${results.filter((r) => r.id !== "CTRL").length} mutations detected (${det.join(", ") || "none"}); not detected: ${missed.join(", ") || "none"}; other: ${other.join(", ") || "none"}; control: ${results.find((r) => r.id === "CTRL")?.verdict ?? "not run"}`);
  console.log(`wrote out/sweeps/${outName}.md and .json`);
  return 0;
}

await runMain(main);
