// The orchestrator (HANDOVER.md §6.1 component 3): deterministic code, not a model. Phases, in order:
// ingest, adjudicate, ingest barrier, optional pause, payout, final report. Every phase is idempotent on restart.
// It never resolves an unknown outcome inline: after dispatch returns OUTCOME_UNKNOWN or QUARANTINED it moves on (the reconciler's job).
import { marker, type Arm, type Intent, type ModelClient, type Obligation, type PolicyBundle, type ProposedPayment, type ProposeResult } from "@nt/contracts";
import type { NtDb } from "@nt/db";
import { join } from "node:path";
import { ORCHESTRATOR, RUNNER_WORKER } from "./audit.ts";
import { buildFinalReport, rewriteReport, writeReportFile } from "./final-report.ts";
import { crashSpecFor, goFilePath, waitForGoFile, STATUTORY_TYPES } from "./go-file.ts";
import { adjudicate, assertIngestBarrier, ingest } from "./ingest.ts";

/** The slice of the Gateway interface (ARCHITECTURE.md §4.5) the runner calls. Nothing else. */
export interface RunnerGateway {
  propose(p: ProposedPayment): Promise<ProposeResult>;
  dispatch(intentId: string, worker: string): Promise<Intent>;
}

export type RunnerDb = Pick<NtDb, "bookings" | "claims" | "obligations" | "intents" | "audit" | "runs" | "client" | "db">;

export type RunnerDeps = {
  db: RunnerDb;
  gateway: RunnerGateway;
  model: ModelClient;
  policy: PolicyBundle;
  /** Repository root: `.nt/go-<group_id>.json` and `out/reports/` live under it. */
  repoRoot: string;
  goPollMs?: number;
  goTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** NT_LETTERS_ENABLED (default false; letters only when explicitly "true"): after the payout phase, send one decision letter per decided claim (CP-LETTER-1). */
  lettersEnabled?: boolean;
};

export type RunOptions = { runId: string; arm?: Arm | undefined; pauseBeforePayout: boolean; reportOnly?: boolean };

export type PayoutOutcome = { effect_key: string; result: "REFUSED" | "SKIPPED" | "DISPATCHED"; detail: string };

/** nt and nt_mutant (the mutant is the same code with NT_MUTATION set, which the gateway reads). rules_only (arm R) runs the same code with the regular-expression extractor in place of the model (chosen in cli.ts). */
export const ORCHESTRATED_ARMS: readonly Arm[] = ["nt", "nt_mutant", "rules_only"];

/** Owed obligations in payout order: due_by, then earliest claim received_at, then a passenger's statutory obligation before that passenger's
 *  goodwill (HANDOVER.md §7.3), then effect_key. Passengers sharing both keys are ordered by their effect-key prefix, so goodwill follows its own statutory payment. */
export function payoutOrder(owed: readonly Obligation[], receivedAt: ReadonlyMap<string, Date>): Obligation[] {
  const rank = (o: Obligation) => {
    const t = (o.due_by ?? new Date(8.64e15)).getTime();
    const r = Math.min(...o.claim_ids.map((c) => receivedAt.get(c)?.getTime() ?? Infinity));
    return { t, r, who: `${o.booking_ref}.${o.passenger_id}.${o.disruption_id}`, gw: o.entitlement_type === "GOODWILL" ? 1 : 0 };
  };
  return [...owed].sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    return x.t - y.t || x.r - y.r || (x.who < y.who ? -1 : x.who > y.who ? 1 : 0) || x.gw - y.gw || (a.effect_key < b.effect_key ? -1 : a.effect_key > b.effect_key ? 1 : 0);
  });
}

/** Phase "payout": for each OWED obligation propose, then dispatch only an intent still RESERVED. Throws on anything the gateway throws. */
export async function payout(deps: RunnerDeps, runId: string): Promise<PayoutOutcome[]> {
  const { db, gateway } = deps;
  const log = deps.log ?? (() => {});
  await assertIngestBarrier(db, runId);
  const owed = await db.obligations.find({ run_id: runId, status: "OWED", entitlement_type: { $ne: "DECISION_LETTER" } }).toArray();
  const claimIds = [...new Set(owed.flatMap((o) => o.claim_ids))];
  const claims = await db.claims.find({ run_id: runId, claim_id: { $in: claimIds } }).toArray();
  const receivedAt = new Map(claims.map((c) => [c.claim_id, c.received_at] as const));
  const outcomes: PayoutOutcome[] = [];

  for (const ob of payoutOrder(owed, receivedAt)) {
    const proposal: ProposedPayment = {
      run_id: runId,
      effect_key: ob.effect_key,
      amount_minor: ob.amount_minor,
      currency: "CAD",
      payee_ref: ob.payee_ref,
      claim_ids: ob.claim_ids,
      proposed_by: ORCHESTRATOR,
    };
    const res = await gateway.propose(proposal);
    if (res.kind === "REFUSED") {
      // AWAITING_BUDGET is expected (goodwill pool); the others indicate a bug or an adversarial proposal and are audited by the gateway.
      outcomes.push({ effect_key: ob.effect_key, result: "REFUSED", detail: res.reason });
      log(`propose ${ob.effect_key}: REFUSED ${res.reason}`);
      continue;
    }
    if (res.kind === "DIVERGED" || res.intent.state !== "RESERVED") {
      outcomes.push({ effect_key: ob.effect_key, result: "SKIPPED", detail: `${res.kind} ${res.intent.state}` });
      log(`propose ${ob.effect_key}: ${res.kind}, intent ${res.intent.state}; not dispatched`);
      continue;
    }
    const after = await gateway.dispatch(res.intent._id, RUNNER_WORKER);
    outcomes.push({ effect_key: ob.effect_key, result: "DISPATCHED", detail: after.state });
    log(`dispatch ${ob.effect_key}: ${after.state}`);
    // OUTCOME_UNKNOWN and QUARANTINED are recorded and left to the reconciler; the runner never resolves them inline.
  }
  return outcomes;
}

// ------------------------------------------------------------------------------------------------ decision letters (CP-LETTER-1)

/** The letter's effect key for a claim: LETTER.<claim id>. */
export function letterEffectKey(claimId: string): string {
  return `LETTER.${claimId.toUpperCase().replace(/[^A-Z0-9_-]/g, "_")}`;
}

/**
 * One DECISION_LETTER obligation per claim whose statutory obligations are all decided (OWED or NOT_OWED; none HELD), addressed to the
 * payee of its first statutory obligation. amount_minor 0: a letter is not a payment. Idempotent ($setOnInsert on the marker _id).
 */
export async function decideLetters(db: RunnerDb, runId: string): Promise<Obligation[]> {
  const claims = await db.claims.find({ run_id: runId, status: "RESOLVED" }).toArray();
  const statutory = (await db.obligations.find({ run_id: runId, entitlement_type: { $in: [...STATUTORY_TYPES] } }).toArray()).sort((a, b) =>
    a.effect_key < b.effect_key ? -1 : a.effect_key > b.effect_key ? 1 : 0,
  );
  const out: Obligation[] = [];
  for (const c of [...claims].sort((a, b) => (a.claim_id < b.claim_id ? -1 : 1))) {
    const mine = statutory.filter((o) => o.claim_ids.includes(c.claim_id));
    if (mine.length === 0 || mine.some((o) => o.status === "HELD")) continue; // no statutory decision yet: no letter
    const first = mine[0]!;
    const effect_key = letterEffectKey(c.claim_id);
    const ob: Obligation = {
      _id: marker(runId, effect_key),
      run_id: runId,
      effect_key,
      booking_ref: first.booking_ref,
      passenger_id: first.passenger_id,
      disruption_id: first.disruption_id,
      entitlement_type: "DECISION_LETTER",
      status: "OWED",
      amount_minor: 0,
      currency: "CAD",
      payee_ref: first.payee_ref,
      rail: first.rail,
      reason_code: null,
      rule_citation: `written decision on ${mine.map((o) => `${o.effect_key} ${o.status}`).join("; ")}`.slice(0, 500),
      policy_version: first.policy_version,
      due_by: null,
      claim_ids: [c.claim_id],
      decided_at: new Date(),
    };
    await db.obligations.updateOne({ _id: ob._id }, { $setOnInsert: ob }, { upsert: true, writeConcern: { w: "majority" } });
    out.push(((await db.obligations.findOne({ _id: ob._id })) as Obligation | null) ?? ob);
  }
  return out;
}

/** Phase "letters": decide the letters, then propose and dispatch each one still RESERVED. Keyless: never re-sent by the runner. */
export async function sendLetters(deps: RunnerDeps, runId: string): Promise<PayoutOutcome[]> {
  const log = deps.log ?? (() => {});
  const outcomes: PayoutOutcome[] = [];
  for (const ob of await decideLetters(deps.db, runId)) {
    if (ob.status !== "OWED") continue;
    const res = await deps.gateway.propose({
      run_id: runId,
      effect_key: ob.effect_key,
      amount_minor: 0,
      currency: "CAD",
      payee_ref: ob.payee_ref,
      claim_ids: ob.claim_ids,
      proposed_by: ORCHESTRATOR,
    });
    if (res.kind === "REFUSED" || res.kind === "DIVERGED" || res.intent.state !== "RESERVED") {
      outcomes.push({ effect_key: ob.effect_key, result: res.kind === "REFUSED" ? "REFUSED" : "SKIPPED", detail: res.kind === "REFUSED" ? res.reason : `${res.kind} ${res.intent.state}` });
      continue;
    }
    const after = await deps.gateway.dispatch(res.intent._id, RUNNER_WORKER);
    outcomes.push({ effect_key: ob.effect_key, result: "DISPATCHED", detail: after.state });
    log(`letter ${ob.effect_key}: ${after.state}`);
  }
  return outcomes;
}

async function setRun(db: RunnerDb, runId: string, set: Record<string, unknown>): Promise<void> {
  await db.runs.updateOne({ _id: runId }, { $set: set });
}

/** The whole pass for arms nt and nt_mutant. Returns the process exit code. A thrown gateway error leaves the run RUNNING (restartable). */
export async function runArm(opts: RunOptions, deps: RunnerDeps): Promise<number> {
  const { db, runId } = { db: deps.db, runId: opts.runId };
  const log = deps.log ?? (() => {});
  const outDir = join(deps.repoRoot, "out", "reports");

  const run = await db.runs.findOne({ _id: runId });
  if (!run) {
    log(`no execution_runs document for ${runId}`);
    return 1;
  }
  if (opts.arm !== undefined && opts.arm !== run.arm) {
    log(`--arm ${opts.arm} does not match execution_runs.arm ${run.arm}; refusing to start`);
    return 1;
  }
  if (!ORCHESTRATED_ARMS.includes(run.arm)) {
    log(`arm ${run.arm} is not run by the orchestrator`);
    return 1;
  }
  log(`run ${runId} arm ${run.arm} group ${run.group_id} NT_MUTATION=${process.env["NT_MUTATION"] ?? "-"} NT_CRASH_AT=${process.env["NT_CRASH_AT"] ?? "-"}`);

  await setRun(db, runId, { status: "RUNNING", started_at: run.started_at ?? new Date(), ended_at: null });

  await ingest({ db, runId, model: deps.model, log });
  await adjudicate({ db, runId, policy: deps.policy, log });
  await assertIngestBarrier(db, runId);

  if (opts.pauseBeforePayout) {
    await setRun(db, runId, { status: "PAUSED" });
    const path = goFilePath(deps.repoRoot, run.group_id);
    log(`PAUSED: waiting for ${path}`);
    const go = await waitForGoFile(path, { pollMs: deps.goPollMs ?? 250, timeoutMs: deps.goTimeoutMs, sleep: deps.sleep });
    if (go.kill_at_passenger) {
      const obligations = await db.obligations.find({ run_id: runId }).toArray();
      const spec = crashSpecFor(run.arm, go.kill_at_passenger, obligations);
      if (spec) {
        process.env["NT_CRASH_AT"] = spec; // read by the gateway's barrier at call time
        log(`kill_at_passenger ${go.kill_at_passenger}: NT_CRASH_AT=${spec}`);
      } else {
        log(`kill_at_passenger ${go.kill_at_passenger}: no OWED statutory obligation (${STATUTORY_TYPES.join(", ")}); continuing without a kill`);
      }
    }
    await setRun(db, runId, { status: "RUNNING" });
  }

  try {
    await payout(deps, runId);
    if (deps.lettersEnabled ?? process.env["NT_LETTERS_ENABLED"] === "true") await sendLetters(deps, runId); // CP-LETTER-1: off by default
  } catch (e) {
    log(`payout stopped: ${(e as Error).message}`);
    return 1; // the run stays RUNNING; restart resumes
  }

  const report = await buildFinalReport(db, runId);
  writeReportFile(outDir, report);
  await setRun(db, runId, { status: "ENDED", ended_at: new Date(), final_report: report });
  log(`final report written: complete=${report.complete} paid=${report.paid.length} refused=${report.refused.length} parked=${report.parked.length} unresolved=${report.unresolved.length}`);
  return 0;
}

/** `--report-only`: rewrites the report from current MongoDB state. Proposes and sends nothing; changes only execution_runs.final_report. */
export async function runReportOnly(db: RunnerDb, runId: string, repoRoot: string, log: (m: string) => void = () => {}): Promise<number> {
  const report = await rewriteReport(db, runId, join(repoRoot, "out", "reports"));
  log(`final report rewritten: complete=${report.complete} paid=${report.paid.length} refused=${report.refused.length} parked=${report.parked.length} unresolved=${report.unresolved.length}`);
  return 0;
}
