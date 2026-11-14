// pnpm sweep:kill: the kill sweep, TEST_PLAN.md section 4.1 and HANDOVER.md section 16 (task H2, Tier 2 part).
//
//   63 cells = 7 barrier scenarios (KS1..KS7) x 3 provider faults x 3 positions in S0's payout order (P11, P13, P02).
//   Each cell is a fresh world: its own in-memory replica set, its own simulator process and a fresh simulator account, the manifest committed
//   before the run, ONE runner worker, intake in replay (recorded model outputs), the deterministic investigator, Stripe OFF (the sweep does not
//   exercise Stripe; with Stripe off P03's ticket refund is a simulator REFUND).
//
//   Cell procedure (sequential, one kill per cell):
//     seed S0 (arm nt, F-NONE) -> install the cell's fault for the target marker (times 1) -> runner with NT_CRASH_AT=<barrier>@<target key>
//     -> if it died by SIGKILL, restart it without NT_CRASH_AT -> `reconcile --until-drained` (KS7: armed, so the reconciler itself is killed;
//     KS6: armed when the runner was not killed, because the settle may happen in either process; then restart it unarmed) -> runner --report-only
//     -> the independent auditor (evaluator check) -> scanInvariants (in a child process of this script) -> the request log and the provider list.
//
//   The reconciler is NOT run beside the runner (the procedure of TEST_PLAN 4.1 describes a continuously running reconciler); here the runner
//   runs first and the reconciler after it. That is a documented simplification of the sweep, not of the system.
//
// A cell PASSES when: the armed barrier fired (one SIGKILL); the run became quiet (reconciler drained within 60 s); all five payments of S0 have an
// intent and every intent is CONFIRMED, FAILED_NO_EFFECT or QUARANTINED; the auditor says SAFETY: PASS; the invariant scan finds nothing; no
// marker has more than one provider object; the request log agrees with the attempts (same key and body hash on every POST for a key, never more
// POSTs than attempts, the keyless rail at most one POST per keyless payment). Whether the target ended in the state TEST_PLAN predicts is
// recorded separately (`prediction_match`) and does NOT change the verdict.
//
// Outputs: out/sweeps/kill-sweep.json and out/sweeps/kill-sweep.md. Usage:
//   pnpm sweep:kill [-- --parallel 3] [--only KS5/DROP_REQUEST/P13] [--deadline-min 25]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { allowedTransition, type Intent, type IntentState } from "../packages/contracts/src/index.ts";
import { auditRun, type Audit } from "../tests/helpers/evaluator.ts";
import { runNode, sleep, tail } from "../tests/helpers/proc.ts";
import { PATHS, REPO, reconcilerEntry, startWorld, stripeMode, type World } from "../tests/helpers/world.ts";
import { parseArgs, runMain } from "./lib/args.ts";
import { evaluatorManifest, seedGroup, stripeTicketPayment } from "./lib/seed-core.ts";
import { SimAdmin } from "./lib/sim-admin.ts";

// ------------------------------------------------------------------------------------------------ the 63 cells

const SELF = join(REPO, "scripts", "kill-sweep.ts");
const OUT_DIR = join(REPO, "out", "sweeps");
const MIN = 60_000;
/** Time allowed for `reconcile --until-drained` per start (TEST_PLAN: 60 s). A restart after a kill INSIDE a transaction waits for the server to abort the orphaned transaction (see the notes), so the sweep can be run with more. */
let RECON_TIMEOUT_MS = MIN;

/** S0's payout order: the first three payments. P11 is on the legacy keyless rail; P13 and P02 are on the instant rail. */
const POSITIONS = [
  { position: 1, id: "P11", effect_key: "PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING", payee_ref: "payee_P11" },
  { position: 2, id: "P13", effect_key: "KS2R9B.P13.NT880-20261110.APPR_DELAY", payee_ref: "payee_P13" },
  { position: 3, id: "P02", effect_key: "ZT4H9X.P02.NT101-20261110.APPR_DELAY", payee_ref: "payee_P02" },
] as const;
type Pos = (typeof POSITIONS)[number];

const BARRIERS = [
  { id: "KS1", barrier: "BR_RESERVE_BEFORE_COMMIT", k: "K0", process: "runner" },
  { id: "KS2", barrier: "BR_RESERVE_AFTER_COMMIT", k: "K1", process: "runner" },
  { id: "KS3", barrier: "BR_DISPATCH_AFTER_MARK", k: "K2", process: "runner" },
  { id: "KS4", barrier: "BR_DISPATCH_REQUEST_SENT", k: "K3", process: "runner" },
  { id: "KS5", barrier: "BR_DISPATCH_RESPONSE_RECEIVED", k: "K4/K5", process: "runner" },
  { id: "KS6", barrier: "BR_SETTLE_IN_TXN", k: "K6", process: "whichever settles the target first" },
  { id: "KS7", barrier: "BR_RECON_AFTER_EVIDENCE", k: "K7", process: "reconciler" },
] as const;
type Ks = (typeof BARRIERS)[number];

const FAULTS = ["DROP_RESPONSE_AFTER_APPLY", "DROP_REQUEST", "REJECT(payee_closed)"] as const;
type FaultLabel = (typeof FAULTS)[number];

type Outcome = "PASS" | "FAIL" | "NOT_REACHED" | "TIMEOUT" | "NOT_RUN";
type Expectation = { state: string; quarantine_reason: string | null; provider_objects: number };

/** TEST_PLAN 4.1 "Expected final state of the target payment" (predictions until measured). */
export function predictedFinal(ks: string, fault: FaultLabel, pos: number): Expectation {
  const q = (provider_objects: number): Expectation => ({ state: "QUARANTINED", quarantine_reason: "NO_DEDUPE_NO_EVIDENCE", provider_objects });
  const confirmed: Expectation = { state: "CONFIRMED", quarantine_reason: null, provider_objects: 1 };
  const failed: Expectation = { state: "FAILED_NO_EFFECT", quarantine_reason: null, provider_objects: 0 };
  if (fault === "DROP_RESPONSE_AFTER_APPLY") return pos === 1 && ks === "KS3" ? q(0) : confirmed;
  if (fault === "DROP_REQUEST") return pos === 1 ? q(0) : confirmed;
  if (pos !== 1) return failed;
  return ["KS3", "KS4", "KS5"].includes(ks) ? q(0) : failed;
}

/** TEST_PLAN 4.1: seven cells are predicted NOT_REACHED. */
export function predictedNotReached(ks: string, fault: FaultLabel, pos: number): boolean {
  if ((ks === "KS6" || ks === "KS7") && fault === "REJECT(payee_closed)") return true;
  return ks === "KS6" && fault === "DROP_REQUEST" && pos === 1;
}

type Cell = { id: string; ks: Ks; fault: FaultLabel; pos: Pos };

export function enumerateCells(): Cell[] {
  const cells: Cell[] = [];
  for (const ks of BARRIERS) for (const fault of FAULTS) for (const pos of POSITIONS) cells.push({ id: `${ks.id}/${fault.split("(")[0]}/${pos.id}`, ks, fault, pos });
  return cells;
}

function faultEntry(fault: FaultLabel, marker: string): Record<string, unknown> {
  const match = { marker };
  if (fault === "REJECT(payee_closed)") return { match, fault: "REJECT", code: "payee_closed", times: 1 };
  return { match, fault, times: 1 };
}

// ------------------------------------------------------------------------------------------------ one cell

type FinalIntent = { effect_key: string; state: string; quarantine_reason: string | null; attempts: number; licences: string[]; provider: string; objects: number };
export type CellRecord = {
  id: string;
  barrier: string;
  k_scenario: string;
  fault: string;
  position: number;
  payment: string;
  effect_key: string;
  run_id: string | null;
  kill_spec: string | null;
  kill_fired: boolean;
  killed_process: "runner" | "reconciler" | null;
  final_state: string | null;
  quarantine_reason: string | null;
  provider_object_count: number | null;
  post_count: number | null;
  auditor_exit_code: number | null;
  scan_findings: string[];
  outcome: Outcome;
  predicted_outcome: "PASS" | "NOT_REACHED";
  predicted_state: string;
  prediction_match: boolean | null;
  failing_checks: string[];
  duration_ms: number;
  intents: FinalIntent[];
  detail: Record<string, unknown>;
};

const died = (r: { signal: NodeJS.Signals | null; code: number | null }) => r.signal === "SIGKILL" || r.code === 137;
const stateLabel = (state: string, reason: string | null) => (reason ? `${state}:${reason}` : state);

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

type LogEntry = { method: string; path: string; idempotency_key: string | null; body_sha256: string | null; outcome: string; fault: string | null };
async function requestLog(world: World, adminKey: string, account: string): Promise<LogEntry[]> {
  const res = await fetch(`${world.simUrl}/admin/request-log?account=${encodeURIComponent(account)}`, { headers: { Authorization: `Bearer ${adminKey}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`request log answered ${res.status}`);
  return ((await res.json()) as { data: LogEntry[] }).data;
}

/** Condition 5 of the pass condition. Returns the problems found (empty = agrees). The licence-before-send ordering is not checkable from the log (it carries no timestamps). */
function checkRequestLog(intents: Intent[], log: LogEntry[]): string[] {
  const problems: string[] = [];
  const posts = log.filter((e) => e.method === "POST" && e.path.startsWith("/v1/payouts"));
  for (const it of intents) {
    if (it.idempotency_key === null) continue;
    const mine = posts.filter((e) => e.idempotency_key === it.idempotency_key);
    if (new Set(mine.map((e) => e.body_sha256)).size > 1) problems.push(`REQLOG: ${it.effect_key} POSTs under one key carry different body hashes`);
    if (mine.length > it.attempts.length) problems.push(`REQLOG: ${it.effect_key} saw ${mine.length} POSTs but only ${it.attempts.length} recorded attempt(s)`);
    if (mine.length > 1 && it.attempts.slice(1).some((a) => a.licence === "FIRST_SEND")) problems.push(`REQLOG: ${it.effect_key} re-sent without a recorded licence`);
  }
  const keyless = intents.filter((i) => i.idempotency_key === null);
  const keylessPosts = posts.filter((e) => e.idempotency_key === null);
  if (keylessPosts.length > keyless.length) problems.push(`REQLOG: the keyless rail saw ${keylessPosts.length} POSTs for ${keyless.length} keyless payment(s)`);
  for (const it of keyless) if (it.attempts.length > 1) problems.push(`REQLOG: ${it.effect_key} (keyless) has ${it.attempts.length} attempts`);
  return problems;
}

const EXPECTED_PAYMENTS = [/\.P11\./, /\.P13\./, /\.P02\./, /\.P03\./, /\.P03\./];
const ALLOWED = new Set(["CONFIRMED", "FAILED_NO_EFFECT", "QUARANTINED"]);

// mongodb-memory-server picks its port at random and two parallel starts can collide ("Port already in use"): worlds start one at a time, with retries.
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

async function runCell(cell: Cell): Promise<CellRecord> {
  const t0 = Date.now();
  const { ks, fault, pos } = cell;
  const rec: CellRecord = {
    id: cell.id, barrier: ks.barrier, k_scenario: ks.k, fault, position: pos.position, payment: pos.id, effect_key: pos.effect_key, run_id: null, kill_spec: null,
    kill_fired: false, killed_process: null, final_state: null, quarantine_reason: null, provider_object_count: null, post_count: null, auditor_exit_code: null,
    scan_findings: [], outcome: "NOT_RUN", predicted_outcome: predictedNotReached(ks.id, fault, pos.position) ? "NOT_REACHED" : "PASS",
    predicted_state: stateLabel(predictedFinal(ks.id, fault, pos.position).state, predictedFinal(ks.id, fault, pos.position).quarantine_reason),
    prediction_match: null, failing_checks: [], duration_ms: 0, intents: [], detail: {},
  };
  const failing = rec.failing_checks;
  const phases: Record<string, unknown> = {};
  rec.detail = phases;
  let world: World | undefined;
  let tmp: string | undefined;
  try {
    world = await startWorldSerialized(); // fresh in-memory replica set and a fresh simulator process
    tmp = mkdtempSync(join(tmpdir(), "nt-sweep-"));
    const db = await world.openDb();
    const seedEnv = world.procEnv("seed");
    const sim = new SimAdmin(world.simUrl, seedEnv.NT_SIM_ADMIN_KEY!);
    try {
      const seeded = await seedGroup({ scenario: "S0", arms: ["nt"], faults: "F-NONE" }, { db, sim, ntDir: tmp, commitManifest: evaluatorManifest(), ticketPayment: world.stripe.on ? stripeTicketPayment() : null });
      const run = seeded.runs[0]!;
      const runId = run.run_id;
      rec.run_id = runId;
      const marker = `${runId}:${pos.effect_key}`;
      await sim.installFaults(run.sim_account, [faultEntry(fault, marker)]);

      const spec = `${ks.barrier}@${pos.effect_key}`;
      rec.kill_spec = spec;
      const base = { NT_RUN_ID: runId, NT_ARM: "nt" };
      const runnerEnv = (armed: boolean) => world!.procEnv("runner", { ...base, ...(armed ? { NT_CRASH_AT: spec } : {}) });
      const reconEnv = (armed: boolean) => world!.procEnv("reconciler", { ...base, NT_RECONCILER_INVESTIGATOR: "deterministic", NT_RECALL_ENABLED: "false", ...(armed ? { NT_CRASH_AT: spec } : {}) });
      const entry = reconcilerEntry();
      if (!entry) throw new Error("no reconciler entry point");
      const step = async (name: string, args: string[], env: Record<string, string>, timeoutMs: number) => {
        try {
          const r = await runNode(args, env, { cwd: REPO, timeoutMs, label: name });
          phases[name] = { code: r.code, signal: r.signal, ms: r.ms, ...(r.code === 0 ? {} : { stderr_tail: tail(r.stderr, 1200), stdout_tail: tail(r.stdout, 600) }) };
          return r;
        } catch (e) {
          phases[name] = { timeout: true, message: String((e as Error).message).slice(0, 1500) };
          throw Object.assign(new Error(`${name} timed out`), { timeout: true });
        }
      };

      // 1. The runner, armed for KS1..KS6 (KS7 arms the reconciler instead).
      const armRunner = ks.id !== "KS7";
      const r1 = await step("runner_1", [PATHS.runner, "--run", runId, "--arm", "nt"], runnerEnv(armRunner), 2 * MIN);
      if (armRunner && died(r1)) {
        rec.kill_fired = true;
        rec.killed_process = "runner";
      } else if (r1.code !== 0) failing.push(`runner exited ${r1.code} (signal ${r1.signal}) without the armed kill`);
      if (died(r1) && !armRunner) failing.push("runner died by SIGKILL although it was not armed");
      if (rec.kill_fired) {
        const r2 = await step("runner_restart", [PATHS.runner, "--run", runId, "--arm", "nt"], runnerEnv(false), 2 * MIN);
        if (r2.code !== 0) failing.push(`runner restart exited ${r2.code} (signal ${r2.signal})`);
      }

      // 2. The reconciler until the run is quiet. Armed for KS7, and for KS6 when the runner was not the one killed.
      const armRecon = ks.id === "KS7" || (ks.id === "KS6" && !rec.kill_fired);
      const c1 = await step("reconcile_1", [entry, "--run", runId, "--until-drained"], reconEnv(armRecon), RECON_TIMEOUT_MS);
      let drainedCode = c1.code;
      if (armRecon && died(c1)) {
        rec.kill_fired = true;
        rec.killed_process = "reconciler";
        const c2 = await step("reconcile_restart", [entry, "--run", runId, "--until-drained"], reconEnv(false), RECON_TIMEOUT_MS);
        drainedCode = c2.code;
      }
      if (drainedCode !== 0) failing.push(`reconciler did not drain: exit ${drainedCode}`);

      // 3. The final report, the auditor, the scan, the provider's own records.
      const rep = await step("report_only", [PATHS.runner, "--run", runId, "--arm", "nt", "--report-only"], runnerEnv(false), MIN);
      if (rep.code !== 0) failing.push(`runner --report-only exited ${rep.code}`);

      const audit: Audit = await auditRun(runId, world.evaluatorEnv());
      rec.auditor_exit_code = audit.exitCode;
      const failedChecks = Object.entries(audit.certificate.checks).filter(([, v]) => v.status === "FAIL").map(([k, v]) => `${k}x${v.count}`);
      if (audit.exitCode !== 0 || audit.certificate.safety !== "PASS") failing.push(`auditor ${audit.certificate.safety} (exit ${audit.exitCode}): ${failedChecks.join(" ") || "no failing check listed"}`);
      phases.audit = { safety: audit.certificate.safety, ledger: audit.certificate.ledger, failed_checks: failedChecks, findings: audit.certificate.findings.slice(0, 8), completion: audit.certificate.completion };

      const intents = await db.intents.find({ run_id: runId }).toArray();
      const scan = await runNode([SELF, "--scan", runId], reconEnv(false), { cwd: REPO, timeoutMs: MIN, label: "invariant scan" }).catch((e: Error) => ({ code: -1, stdout: "", stderr: e.message }));
      type Scan = { ok: boolean; intents: number; violations: { code: string; intent_id: string | null; detail: string }[] };
      const parseScan = (text: string): Scan | null => {
        try {
          return JSON.parse(/\{.*\}\s*$/s.exec(text)?.[0] ?? "") as Scan;
        } catch {
          return null;
        }
      };
      const scanned = parseScan(scan.stdout);
      if (!scanned) {
        rec.scan_findings.push(`SCAN_DID_NOT_RUN: ${tail(scan.stderr, 300)}`);
        failing.push("invariant scan did not run");
      } else {
        for (const v of scanned.violations) rec.scan_findings.push(`${v.code} ${v.intent_id ?? "-"} ${v.detail}`.slice(0, 300));
        if (!scanned.ok) {
          failing.push(`invariant scan found ${scanned.violations.length} violation(s)`);
          // Evidence for triage: the audit events of the offending intents, in _id order (the scan's replay order) with their own timestamps.
          const ids = [...new Set(scanned.violations.map((v) => v.intent_id).filter((x): x is string => x !== null))];
          const ev = await db.audit.find({ run_id: runId, intent_id: { $in: ids }, to_state: { $ne: null } }).sort({ _id: 1 }).toArray();
          // Triage only (the verdict stays FAIL): is the chain valid when replayed in event-time order instead of _id order? ObjectIds made by two
          // different processes inside one second do not sort in creation order, which is what a kill and restart produce.
          const byTime = [...ev].sort((x, y) => x.at.getTime() - y.at.getTime() || x._id.toHexString().localeCompare(y._id.toHexString()));
          const chainOk = (list: typeof ev, id: string) => {
            let st: IntentState | null = null;
            for (const e of list.filter((x) => x.intent_id === id)) {
              if (e.from_state !== st || e.to_state === null || allowedTransition(e.from_state, e.to_state) === null) return false;
              st = e.to_state;
            }
            return st === intents.find((i) => i._id === id)?.state;
          };
          const onlyP9 = scanned.violations.every((v) => v.code.startsWith("P9_"));
          phases.p9_replay_clean_in_event_time_order = onlyP9 && ids.every((id) => chainOk(byTime, id));
          phases.audit_events_in_scan_order = ev.map((e) => ({ id: e._id.toHexString(), at: e.at.toISOString(), type: e.type, from: e.from_state, to: e.to_state, actor: `${e.actor.kind}:${e.actor.id}` }));
        }
      }

      const objects = await listObjects(world, run.sim_account);
      const log = await requestLog(world, seedEnv.NT_SIM_ADMIN_KEY!, run.sim_account);
      const posts = log.filter((e) => e.method === "POST" && e.path.startsWith("/v1/payouts"));
      const perMarker = new Map<string, number>();
      for (const o of objects) {
        const m = o.metadata["nt_marker"] ?? "(none)";
        perMarker.set(m, (perMarker.get(m) ?? 0) + 1);
      }
      for (const [m, n] of perMarker) if (n > 1) failing.push(`DUPLICATE at the provider: ${n} objects for marker ${m.replace(runId + ":", "")}`);
      rec.intents = intents
        .map((i) => ({ effect_key: i.effect_key, state: i.state, quarantine_reason: i.quarantine?.reason ?? null, attempts: i.attempts.length, licences: i.attempts.map((a) => a.licence), provider: i.provider, objects: perMarker.get(i._id) ?? 0 }))
        .sort((a, b) => a.effect_key.localeCompare(b.effect_key));
      for (const p of checkRequestLog(intents, log)) failing.push(p);

      // Every payment has an intent and ends in an allowed state; the refusal (P04) is in the report and has no intent.
      const keys = intents.map((i) => i.effect_key);
      const unmatched = [...keys];
      for (const re of EXPECTED_PAYMENTS) {
        const at = unmatched.findIndex((k) => re.test(k));
        if (at < 0) failing.push(`no intent for a payment matching ${re.source}`);
        else unmatched.splice(at, 1);
      }
      if (unmatched.length > 0) failing.push(`unexpected intent(s): ${unmatched.join(", ")}`);
      for (const i of intents) if (!ALLOWED.has(i.state)) failing.push(`${i.effect_key} ended ${i.state}`);
      const target = intents.find((i) => i.effect_key === pos.effect_key);
      rec.final_state = target?.state ?? null;
      // POSTs the provider saw for the target: by key on the instant rail; on the keyless rail the log carries no marker, so every keyless POST of the account.
      rec.post_count = posts.filter((e) => (target?.idempotency_key ? e.idempotency_key === target.idempotency_key : e.idempotency_key === null)).length;
      rec.quarantine_reason = target?.quarantine?.reason ?? null;
      rec.provider_object_count = perMarker.get(marker) ?? 0;
      const report = (await db.runs.findOne({ _id: runId }))?.final_report ?? null;
      phases.final_report = report ? { complete: report.complete, refused: report.refused.map((x) => x.reason_code), parked: report.parked.length } : null;
      if (report && report.refused.length !== 1) failing.push(`final report lists ${report.refused.length} refusals (expected 1)`);
      if (!report) failing.push("no final report");

      // Verdict.
      const want = predictedFinal(ks.id, fault, pos.position);
      rec.prediction_match = rec.final_state === want.state && rec.quarantine_reason === want.quarantine_reason && rec.provider_object_count === want.provider_objects;
      rec.outcome = failing.length > 0 ? "FAIL" : rec.kill_fired ? "PASS" : "NOT_REACHED";
    } finally {
      await db.close().catch(() => {});
    }
  } catch (e) {
    if ((e as { timeout?: boolean }).timeout) rec.outcome = "TIMEOUT";
    else {
      rec.outcome = "NOT_RUN";
      failing.push(`infrastructure error: ${String((e as Error).message).slice(0, 400)}`);
    }
  } finally {
    await world?.stop().catch(() => {});
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    rec.duration_ms = Date.now() - t0;
  }
  return rec;
}

// ------------------------------------------------------------------------------------------------ reports

const cell = (r: CellRecord) => `${r.outcome}<br>${r.final_state ? stateLabel(r.final_state, r.quarantine_reason).replace("QUARANTINED:NO_DEDUPE_NO_EVIDENCE", "QUARANTINED (NDNE)").replace("QUARANTINED:", "QUARANTINED ") : "-"}${r.kill_fired ? "" : "<br>no kill"}`;

function summarize(records: CellRecord[]) {
  const count = (o: Outcome) => records.filter((r) => r.outcome === o).length;
  return {
    cells: records.length,
    PASS: count("PASS"),
    FAIL: count("FAIL"),
    NOT_REACHED: count("NOT_REACHED"),
    TIMEOUT: count("TIMEOUT"),
    NOT_RUN: count("NOT_RUN"),
    kills_fired: records.filter((r) => r.kill_fired).length,
    prediction_mismatch: records.filter((r) => r.prediction_match === false).length,
    fail_scan_p9_order_artefact: records.filter((r) => r.outcome === "FAIL" && r.detail["p9_replay_clean_in_event_time_order"] === true && r.failing_checks.length === 1).length,
    unpredicted_not_reached: records.filter((r) => r.outcome === "NOT_REACHED" && r.predicted_outcome !== "NOT_REACHED").length,
    predicted_not_reached_but_fired: records.filter((r) => r.predicted_outcome === "NOT_REACHED" && r.kill_fired).length,
  };
}

function markdown(records: CellRecord[], meta: Record<string, unknown>, sum: ReturnType<typeof summarize>): string {
  const byId = new Map(records.map((r) => [r.id, r]));
  const L: string[] = [];
  L.push("# Kill sweep (task H2, Tier 2): 7 barrier scenarios x 3 provider faults x 3 positions", "");
  L.push(`Generated by \`pnpm sweep:kill\` at ${String(meta.finished_at)}; commit \`${String(meta.commit)}\`${meta.dirty ? " (working tree had uncommitted changes)" : ""}.`, "");
  L.push(
    `**Totals: PASS ${sum.PASS} | FAIL ${sum.FAIL} | NOT_REACHED ${sum.NOT_REACHED} | TIMEOUT ${sum.TIMEOUT} | NOT_RUN ${sum.NOT_RUN}** (of ${sum.cells} cells enumerated). **Kills fired in ${sum.kills_fired} of 63 cells.**`,
    "",
  );
  L.push("Each cell is one deterministic execution of scenario S0, arm `nt`: one runner worker, intake in replay (recorded model outputs), the deterministic investigator, a fresh in-memory replica set and a fresh simulator account. " + String(meta.stripe_note) + " The runner runs first and the reconciler after it (not side by side). One kill per run.", "");
  L.push("Faults, installed for the target payment's marker, times 1: `DROP_RESPONSE_AFTER_APPLY` (the provider applied it), `DROP_REQUEST` (it never received it), `REJECT(payee_closed)` (it rejected it). Positions: 1 = P11 (legacy keyless rail), 2 = P13 (instant), 3 = P02 (instant). NDNE = `NO_DEDUPE_NO_EVIDENCE`. `no kill` = the armed barrier never fired in that cell.", "");
  L.push("| Barrier | " + FAULTS.flatMap((f) => POSITIONS.map((p) => `${f.split("(")[0]!.replace("DROP_RESPONSE_AFTER_APPLY", "DROP_RESPONSE")} ${p.id}`)).join(" | ") + " |");
  L.push("|---|" + "---|".repeat(9));
  for (const ks of BARRIERS) {
    const cols = FAULTS.flatMap((f) => POSITIONS.map((p) => byId.get(`${ks.id}/${f.split("(")[0]}/${p.id}`)));
    L.push(`| ${ks.id} \`${ks.barrier.replace("BR_", "")}\` (${ks.k}) | ${cols.map((r) => (r ? cell(r) : "NOT_RUN")).join(" | ")} |`);
  }
  L.push("");
  const mism = records.filter((r) => r.prediction_match === false);
  L.push(`Target final state versus the TEST_PLAN 4.1 prediction: ${records.filter((r) => r.prediction_match === true).length} match, ${mism.length} differ (a differing but audited-safe state is not a failure by the sweep's pass condition; it is listed so the plan's prediction table can be corrected).`, "");
  if (mism.length > 0) {
    L.push("| Cell | Predicted | Measured | Provider objects (target) | Outcome |", "|---|---|---|---|---|");
    for (const r of mism) L.push(`| ${r.id} | ${r.predicted_state} | ${stateLabel(r.final_state ?? "-", r.quarantine_reason)} | ${r.provider_object_count ?? "-"} | ${r.outcome} |`);
    L.push("");
  }
  const nr = records.filter((r) => r.outcome === "NOT_REACHED");
  L.push(`NOT_REACHED: ${nr.length} cell(s): ${nr.map((r) => r.id).join(", ") || "none"}. TEST_PLAN predicted seven (KS6 and KS7 under REJECT at all three positions, KS6 under DROP_REQUEST at position 1); ${sum.unpredicted_not_reached} of the measured ones were not predicted, and ${sum.predicted_not_reached_but_fired} predicted ones did fire. A NOT_REACHED cell is not counted as a pass.`, "");
  const bad = records.filter((r) => r.outcome === "FAIL" || r.outcome === "TIMEOUT" || r.outcome === "NOT_RUN");
  if (bad.length > 0) {
    L.push("## Cells that did not pass", "");
    for (const r of bad) L.push(`- **${r.id}** ${r.outcome}${r.detail["p9_replay_clean_in_event_time_order"] === true ? " [the only failing check is the scan's P9 replay, which is clean when ordered by event time: ObjectId order across the killed and the restarted process]" : ""} (run ${r.run_id ?? "-"}, kill fired: ${r.kill_fired ? "yes" : "no"}): ${r.failing_checks.join("; ") || "see kill-sweep.json"}${r.scan_findings.length ? ` | scan: ${r.scan_findings.join("; ")}` : ""}`);
    L.push("");
  }
  L.push("## What this supports", "");
  L.push(sum.FAIL === 0 && sum.TIMEOUT === 0 && sum.NOT_RUN === 0
    ? "Every instrumented single crash point that was reached, under three provider faults, ended in a state the auditor accepted or on the would-not-guess list (QUARANTINED)."
    : "The claim \"every instrumented single crash point under three provider faults ends in a state the auditor accepts or on the would-not-guess list\" is NOT supported by this run: see the cells above.");
  L.push("", `It covers one kill per run, one worker, recorded model outputs, the simulator, a local replica set and these three faults, in ${sum.kills_fired} of 63 cells where a kill actually fired. It says nothing about two crashes in one run, concurrent runners, a real processor, Stripe, other faults, or code locations without a barrier. Each cell is one deterministic execution; the sweep enumerates 63 cases, it is not a sample, and no failure rate is derived from it.`, "");
  L.push(`Environment: ${String(meta.environment)}. Wall time ${(Number(meta.wall_ms) / MIN).toFixed(1)} min, parallelism ${String(meta.parallel)}, reconcile --until-drained limit ${String(meta.reconcile_timeout_s)} s per start.`, "");
  return L.join("\n");
}

// ------------------------------------------------------------------------------------------------ the scan child

async function scanChild(runId: string): Promise<void> {
  const { createGatewayFromEnv } = await import("../packages/gateway/src/index.ts");
  const { closeAll } = await import("../packages/db/src/index.ts");
  const gw = await createGatewayFromEnv("reconciler", { ...process.env, NT_RUN_ID: runId, NT_ARM: "nt" } as never, { runId, workerId: "kill-sweep-scan" });
  const rep = await gw.scanInvariants(runId);
  process.stdout.write(`${JSON.stringify(rep)}\n`);
  await closeAll().catch(() => {});
}

// ------------------------------------------------------------------------------------------------ main

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2), ["parallel", "only", "deadline-min", "scan", "recon-timeout-s", "out-name"]);
  if (a.values.has("scan")) {
    await scanChild(a.values.get("scan")!);
    return 0;
  }
  // Stripe. The brief is NT_STRIPE_ENABLED=false (Stripe is not part of the sweep), but the gateway cannot run with it: parseEnv turns the flag into the
  // boolean false and packages/gateway/src/gateway.ts:105 compares it with the string "false", so the gateway builds a Stripe provider and demands
  // STRIPE_SECRET_KEY regardless (every runner and reconciler start fails). The sweep therefore uses Stripe TEST mode for P03's ticket refund whenever
  // the test keys exist (world helper), and says so. Faults and kills never target a Stripe payment. --stripe-off insists on the flag and will fail.
  if (a.flags.has("stripe-off")) process.env.NT_STRIPE_ENABLED = "false";
  const mode = stripeMode();
  if (mode.on) process.env.STRIPE_SECRET_KEY = mode.secretKey; // for the seed's ticket-purchase script; never printed
  console.error(`stripe: ${mode.on ? "TEST mode on for P03's ticket refund (faults and kills never target it)" : `OFF (${mode.why}); the gateway is expected to refuse to start (NT_STRIPE_ENABLED=false is not honoured)`}`);
  RECON_TIMEOUT_MS = Number(a.values.get("recon-timeout-s") ?? 60) * 1000;
  const outName = a.values.get("out-name") ?? "kill-sweep";
  const parallel = Math.max(1, Number(a.values.get("parallel") ?? 3));
  const deadlineMs = Number(a.values.get("deadline-min") ?? 25) * MIN;
  const only = a.values.get("only");
  const all = enumerateCells();
  if (all.length !== 63) throw new Error(`expected 63 cells, enumerated ${all.length}`);
  const cells = only ? all.filter((c) => c.id === only || c.id.startsWith(only)) : all;
  if (cells.length === 0) throw new Error(`--only ${only} matches no cell`);

  const stripeNote = mode.on
    ? "Stripe: TEST mode is ON for P03's ticket refund, not off as the brief intended, because NT_STRIPE_ENABLED=false is not honoured by the gateway (packages/gateway/src/gateway.ts:105 compares the parsed boolean with the string \"false\"); faults and kills never target the Stripe payment, so the sweep's subject is the simulator payments"
    : "Stripe: OFF";
  const started = Date.now();
  const results = new Map<string, CellRecord>();
  const notRun = (c: Cell, why: string): CellRecord => ({
    id: c.id, barrier: c.ks.barrier, k_scenario: c.ks.k, fault: c.fault, position: c.pos.position, payment: c.pos.id, effect_key: c.pos.effect_key, run_id: null, kill_spec: null,
    kill_fired: false, killed_process: null, final_state: null, quarantine_reason: null, provider_object_count: null, post_count: null, auditor_exit_code: null,
    scan_findings: [], outcome: "NOT_RUN", predicted_outcome: predictedNotReached(c.ks.id, c.fault, c.pos.position) ? "NOT_REACHED" : "PASS",
    predicted_state: stateLabel(predictedFinal(c.ks.id, c.fault, c.pos.position).state, predictedFinal(c.ks.id, c.fault, c.pos.position).quarantine_reason),
    prediction_match: null, failing_checks: [why], duration_ms: 0, intents: [], detail: {},
  });
  const meta = () => ({
    task: "H2 kill sweep (TEST_PLAN 4.1)",
    commit: git(["rev-parse", "--short=12", "HEAD"]),
    dirty: git(["status", "--porcelain", "--", "scripts", "apps", "packages", "tests", "evaluator", "fixtures"]) !== "",
    stripe_note: stripeNote,
    environment: `node ${process.version} ${process.platform}/${process.arch}; mongodb-memory-server replica set per cell; simulator per cell; ${stripeNote.split('.')[0]}; NT_MODEL_MODE=replay (cassettes); NT_RECONCILER_INVESTIGATOR=deterministic; NT_RECALL_ENABLED=false; NT_DISPATCH_TIMEOUT_MS=3000 NT_LEASE_MS=8000 NT_RECONCILE_INTERVAL_MS=500`,
    parallel,
    reconcile_timeout_s: RECON_TIMEOUT_MS / 1000,
    deadline_min: deadlineMs / MIN,
    finished_at: new Date().toISOString(),
    wall_ms: Date.now() - started,
  });
  const write = () => {
    const records = cells.map((c) => results.get(c.id) ?? notRun(c, "not started"));
    const sum = summarize(records);
    mkdirSync(OUT_DIR, { recursive: true });
    const m = meta();
    writeFileSync(join(OUT_DIR, `${outName}.json`), `${JSON.stringify({ summary: sum, meta: m, cells: records }, null, 2)}\n`);
    writeFileSync(join(OUT_DIR, `${outName}.md`), markdown(records, m, sum));
    return sum;
  };

  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const c = cells[i];
      if (!c) return;
      if (Date.now() - started > deadlineMs) {
        results.set(c.id, notRun(c, `not started: the ${deadlineMs / MIN} minute deadline had passed`));
        continue;
      }
      const r = await runCell(c);
      results.set(c.id, r);
      done++;
      console.error(`[${done}/${cells.length}] ${r.id} ${r.outcome} kill=${r.kill_fired ? "yes" : "no"} state=${stateLabel(r.final_state ?? "-", r.quarantine_reason)} ${(r.duration_ms / 1000).toFixed(0)}s${r.failing_checks.length ? ` :: ${r.failing_checks[0]!.slice(0, 160)}` : ""}`);
      write();
      await sleep(0);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, cells.length) }, worker));
  const sum = write();
  console.log(`kill sweep: PASS ${sum.PASS} | FAIL ${sum.FAIL} | NOT_REACHED ${sum.NOT_REACHED} | TIMEOUT ${sum.TIMEOUT} | NOT_RUN ${sum.NOT_RUN} | kills fired in ${sum.kills_fired} of 63 cells | ${((Date.now() - started) / MIN).toFixed(1)} min`);
  console.log(`wrote ${join(OUT_DIR, `${outName}.json`)} and kill-sweep.md`);
  return sum.FAIL + sum.TIMEOUT + sum.NOT_RUN > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain(main);
  process.exit(process.exitCode ?? 0);
}
