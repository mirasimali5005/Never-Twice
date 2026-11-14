// Arm A, `control`: the naive agent that pays twice (HANDOVER.md §15; AGENT_TASKS.md E5).
//
// Frozen behaviour, per claim in received_at order: extract (same ModelClient, so the same cassettes), resolve, compute with the same rules
// engine, call the provider with a FRESH RANDOM idempotency key per attempt, then mark the claim done in MongoDB. On a timeout or a 5xx
// (INDETERMINATE) retry up to twice, each time with a new key. A 2xx means paid. On restart, resume every claim not marked done.
// Goodwill: read the pool, check, pay, then decrement, as separate steps. The report says complete at the end.
//
// This arm deliberately has NO gateway, NO write-ahead intent, NO evidence-based settlement, NO reconciler, no lease. That is the point:
// it is what tutorial code does, and it is graded by the same auditor. It stamps nt_effect_key (and nt_run_id, nt_marker, nt_type) in the
// provider metadata only so the auditor can attribute its payments. Its bookkeeping is the `baseline` sub-document on its own run's
// `claims` documents: { done, done_at, checkpoint, decisions, payments }. The attempt log (with the key of every attempt) is written
// right after each provider response and before the barrier, so a kill leaves the first payment visible in the control's own record
// even though the claim was never marked done (the desk shows it; the control itself never consults it).
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FinalReport,
  marker,
  parseCrashSpec,
  simAccountOf,
  type Booking,
  type ClaimExtraction,
  type DispatchResult,
  type FrozenRequest,
  type HeldReason,
  type ModelClient,
  type NotOwedReason,
  type ObligationDecision,
  type PaymentProvider,
  type PolicyBundle,
  type ProviderId,
} from "@nt/contracts";
import { extractClaim, resolve } from "@nt/agents";
import { computeObligations } from "@nt/rules";
import type { NtCollections } from "@nt/db";

// ---------------------------------------------------------------------------------------------------------------- stored shapes

/** What the control decided for one entitlement of one claim (kept so the report and the desk can show it). */
export type BaselineDecision = {
  effect_key: string;
  passenger_id: string;
  entitlement_type: ObligationDecision["entitlement_type"];
  status: ObligationDecision["status"];
  amount_minor: number;
  currency: "CAD";
  payee_ref: string;
  rail: "instant" | "legacy";
  reason_code: string | null;
  rule_citation: string;
  ticket_payment_ref: string | null;
};

/** One call to the provider. `idempotency_key` is null on the keyless (legacy) rail, which takes no key. */
export type BaselineAttempt = {
  n: number;
  idempotency_key: string | null;
  at: string;
  outcome: "ACCEPTED" | "REJECTED" | "INDETERMINATE" | "CONTRADICTION";
  /** plain words, as the control itself would log it */
  result: string;
  provider_object_id: string | null;
};

export type BaselinePayment = {
  effect_key: string;
  passenger_id: string;
  entitlement_type: string;
  amount_minor: number;
  currency: "CAD";
  payee_ref: string;
  provider: ProviderId;
  /** PAID: a 2xx came back. FAILED: a definitive rejection. GAVE_UP: retries ran out. */
  result: "PAID" | "FAILED" | "GAVE_UP";
  /** the provider object of the last accepted attempt */
  provider_object_id: string | null;
  code: string | null;
  attempts: BaselineAttempt[];
};

export type BaselineGoodwillStep = { effect_key: string; read_remaining_minor: number; decision: "PAY" | "SKIP"; decremented_minor: number };

export type BaselineDoc = {
  done: boolean;
  done_at: string | null;
  checkpoint: "DECIDED" | "PAYING" | "DONE";
  decisions: BaselineDecision[];
  payments: BaselinePayment[];
  /** the three separate goodwill steps, recorded as they happened */
  goodwill: BaselineGoodwillStep[];
};

type ClaimWithBaseline = { baseline?: BaselineDoc };

// ---------------------------------------------------------------------------------------------------------------- deps

export type BaselineDeps = {
  runId: string;
  /** Collections of the control's own run. `grants` is written by this arm directly (no gateway). */
  db: Pick<NtCollections, "claims" | "bookings" | "runs" | "grants">;
  model: ModelClient;
  policy: PolicyBundle;
  /** Provider clients, built by the caller from @nt/providers `createProvider`. */
  providerFor: (id: ProviderId) => Promise<PaymentProvider>;
  /** NT_STRIPE_ENABLED: a TICKET_REFUND goes to stripe_refund when true, otherwise to the simulator's instant rail as a REFUND. */
  stripeEnabled: boolean;
  /** per-request timeout, ms (NT_DISPATCH_TIMEOUT_MS) */
  dispatchTimeoutMs?: number;
  /** retries after the first attempt on INDETERMINATE. Frozen at 2. */
  maxRetries?: number;
  /** a fresh key per attempt. Default crypto.randomUUID. */
  newKey?: () => string;
  now?: () => Date;
  /** Called after every claim is decided and before the first provider call (the pause point). May set process.env.NT_CRASH_AT. */
  beforePayout?: (decided: DecidedClaim[]) => Promise<void>;
  /** Called after each provider response, before the claim is marked done. Default: the CTRL_AFTER_PROVIDER_RESPONSE crash barrier. */
  barrier?: (name: "CTRL_AFTER_PROVIDER_RESPONSE", effectKey: string) => void | Promise<void>;
  /** where out/reports/<run_id>.final-report.json is written. Default `<cwd>/out/reports`. */
  reportDir?: string;
  log?: (line: string) => void;
};

export type DecidedClaim = { claim_id: string; held: string | null; decisions: BaselineDecision[] };

// ---------------------------------------------------------------------------------------------------------------- crash barrier

const arrivals = new Map<string, number>();

/** CTRL_AFTER_PROVIDER_RESPONSE: a no-op unless NT_CRASH_AT names it (`NAME:n` for the nth arrival, `NAME@effect_key`), in which case the
 *  process sends itself SIGKILL: a real kill, right after the provider's answer and before anything is recorded as done. */
export function controlBarrier(name: "CTRL_AFTER_PROVIDER_RESPONSE", effectKey: string, env: Record<string, string | undefined> = process.env): void {
  const raw = env["NT_CRASH_AT"];
  if (raw === undefined || raw === "") return;
  const spec = parseCrashSpec(raw);
  if (spec === null || spec.name !== name) return;
  if ("effectKey" in spec) {
    if (spec.effectKey !== effectKey) return;
  } else {
    const n = (arrivals.get(name) ?? 0) + 1;
    arrivals.set(name, n);
    if (n !== spec.nth) return;
  }
  process.kill(process.pid, "SIGKILL");
  // SIGKILL cannot be caught; if it somehow returns, never continue past a barrier that fired.
  for (;;) {
    /* wait to die */
  }
}

// ---------------------------------------------------------------------------------------------------------------- the arm

const STATUTORY = new Set(["APPR_DELAY", "APPR_DENIED_BOARDING", "APPR_REFUND_COMP"]);
/** the statutory entitlement types the judge's kill may target */
export const isStatutory = (t: string): boolean => STATUTORY.has(t);

export function providerIdFor(d: Pick<BaselineDecision, "entitlement_type" | "rail">, stripeEnabled: boolean): ProviderId {
  if (d.entitlement_type === "TICKET_REFUND" && stripeEnabled) return "stripe_refund";
  return d.rail === "instant" ? "sim_payout" : "sim_keyless";
}

export function frozenFor(d: BaselineDecision, provider: ProviderId, runId: string): FrozenRequest {
  const stripe = provider === "stripe_refund";
  return {
    provider,
    operation: d.entitlement_type === "TICKET_REFUND" ? "REFUND" : "PAYOUT",
    account: stripe ? "stripe" : simAccountOf(runId),
    rail: stripe ? null : d.rail,
    amount_minor: d.amount_minor,
    currency: "CAD",
    payee_ref: d.payee_ref,
    parent_ref: stripe ? d.ticket_payment_ref : null,
    metadata: { nt_marker: marker(runId, d.effect_key), nt_effect_key: d.effect_key, nt_run_id: runId, nt_type: d.entitlement_type },
  };
}

export function describe(r: DispatchResult): { outcome: BaselineAttempt["outcome"]; text: string; objectId: string | null } {
  switch (r.kind) {
    case "ACCEPTED":
      return { outcome: "ACCEPTED", text: `provider answered 2xx, payment applied (${r.object.id})`, objectId: r.object.id };
    case "REJECTED_DEFINITIVE":
      return { outcome: "REJECTED", text: `provider rejected the payment: ${r.code}`, objectId: null };
    case "INDETERMINATE":
      return { outcome: "INDETERMINATE", text: `no usable answer (${r.cause}): ${r.detail}`, objectId: null };
    case "CONTRADICTION":
      return { outcome: "CONTRADICTION", text: `provider answered something unexpected (${r.code}): ${r.detail}`, objectId: null };
  }
}

/** The kill targets the passenger's owed statutory payment (APPR_DELAY, APPR_DENIED_BOARDING or APPR_REFUND_COMP). */
export function killSpecFor(passenger: string | null, decided: DecidedClaim[]): string | null {
  if (!passenger) return null;
  for (const c of decided) {
    const d = c.decisions.find((x) => x.passenger_id === passenger && x.status === "OWED" && isStatutory(x.entitlement_type));
    if (d) return `CTRL_AFTER_PROVIDER_RESPONSE@${d.effect_key}`;
  }
  return null;
}

type DecideDeps = Pick<BaselineDeps, "model" | "policy">;
export type Decided = {
  held: string | null;
  extraction: ClaimExtraction | null;
  resolution: { booking_ref: string; passenger_ids: string[]; method: string; similarity: number } | null;
  flags: { payeeChangeRequested: boolean; goodwillProposed: "OVERNIGHT_STRANDED" | "MOBILITY_ASSIST" | null };
  decisions: BaselineDecision[];
};

/** Extract, resolve and compute one claim (the intake and rules shared by arms A and B, which are the same code as Never Twice's). */
export async function decideClaim(
  deps: DecideDeps,
  claim: { claim_id: string; channel: string; raw_text: string; received_at: Date },
  bookings: readonly Booking[],
): Promise<Decided> {
    const res = await extractClaim(deps.model, { claim_id: claim.claim_id, channel: claim.channel, text: claim.raw_text });
    let held: string | null = null;
    let extraction: ClaimExtraction | null = null;
    const decisions: BaselineDecision[] = [];
    let resolution: { booking_ref: string; passenger_ids: string[]; method: string; similarity: number } | null = null;
    let flags = { payeeChangeRequested: false, goodwillProposed: null as "OVERNIGHT_STRANDED" | "MOBILITY_ASSIST" | null };
    if (res.kind === "HELD") {
      held = res.reason_code;
    } else {
      extraction = res.extraction;
      const r = resolve(res.extraction, bookings);
      if (r.kind === "HELD") {
        held = r.reason_code;
      } else {
        flags = r.flags;
        resolution = { booking_ref: r.booking_ref, passenger_ids: r.passenger_ids, method: r.method, similarity: 1 };
        for (const pid of r.passenger_ids) {
          const b = bookings.find((x) => x.booking_ref === r.booking_ref && x.passenger_id === pid) as Booking | undefined;
          if (!b) continue;
          const obs = computeObligations({
            booking: b,
            passenger: b.passenger,
            disruption: b.disruption,
            claimReceivedAt: claim.received_at,
            flags: r.flags,
            policy: deps.policy,
          });
          for (const o of obs) {
            decisions.push({
              effect_key: o.effect_key,
              passenger_id: o.passenger_id,
              entitlement_type: o.entitlement_type,
              status: o.status,
              amount_minor: o.amount_minor,
              currency: "CAD",
              payee_ref: o.payee_ref,
              rail: o.rail,
              reason_code: o.reason_code,
              rule_citation: o.rule_citation,
              ticket_payment_ref: o.entitlement_type === "TICKET_REFUND" ? b.ticket_payment_ref : null,
            });
          }
        }
      }
    }
  return { held, extraction, resolution, flags, decisions };
}

/** Runs arm A over the claims of its run. Idempotent in the only sense this arm has: a restart resumes every claim not marked done. */
export async function runControl(deps: BaselineDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const newKey = deps.newKey ?? (() => randomUUID());
  const maxRetries = deps.maxRetries ?? 2;
  const timeoutMs = deps.dispatchTimeoutMs ?? 3000;
  const barrier = deps.barrier ?? ((name, effectKey) => controlBarrier(name, effectKey));
  const { runId, db } = deps;

  await db.runs.updateOne({ _id: runId }, [{ $set: { status: "RUNNING", started_at: { $ifNull: ["$started_at", now()] } } }]);

  const claims = await db.claims.find({ run_id: runId }).sort({ received_at: 1, claim_id: 1 }).toArray();
  const bookings = await db.bookings.find({ run_id: runId }).toArray();
  const baselineOf = (c: unknown): BaselineDoc | undefined => (c as ClaimWithBaseline).baseline;

  // ---- phase 1: extract, resolve, compute, for every claim not marked done (a restart re-runs them from the top, as naive code does)
  const decided: DecidedClaim[] = [];
  for (const claim of claims) {
    if (baselineOf(claim)?.done) continue;
    const { held, extraction, resolution, flags, decisions } = await decideClaim(deps, claim, bookings);
    const prior = baselineOf(claim);
    const baseline: BaselineDoc = {
      done: false,
      done_at: null,
      checkpoint: "DECIDED",
      decisions,
      payments: prior?.payments ?? [],
      goodwill: prior?.goodwill ?? [],
    };
    await db.claims.updateOne(
      { _id: claim._id },
      {
        $set: {
          status: held === null ? "RESOLVED" : "HELD",
          hold_reason: held as HeldReason | null,
          extraction,
          resolution,
          flags,
          effect_keys: decisions.map((d) => d.effect_key),
          updated_at: now(),
          baseline,
        },
      },
    );
    decided.push({ claim_id: claim.claim_id, held, decisions });
  }

  if (deps.beforePayout) await deps.beforePayout(decided);

  // ---- phase 2: per claim, pay, then mark the claim done
  for (const claim of claims) {
    const stored = baselineOf(await db.claims.findOne({ _id: claim._id }));
    if (!stored || stored.done) continue;
    const payments: BaselinePayment[] = stored.payments ?? [];
    const goodwill: BaselineGoodwillStep[] = stored.goodwill ?? [];
    const save = async (checkpoint: BaselineDoc["checkpoint"]): Promise<void> => {
      await db.claims.updateOne({ _id: claim._id }, { $set: { "baseline.payments": payments, "baseline.goodwill": goodwill, "baseline.checkpoint": checkpoint, updated_at: now() } });
    };
    await save("PAYING");

    for (const d of stored.decisions) {
      if (d.status !== "OWED") continue;
      const provider = providerIdFor(d, deps.stripeEnabled);

      // Goodwill, step 1 of 3: read the pool. Step 2: check. Step 3 (after the payment): decrement. Three separate steps, no transaction.
      let remaining = 0;
      if (d.entitlement_type === "GOODWILL") {
        const g = await db.grants.findOne({ _id: `${runId}:GOODWILL` });
        remaining = g ? g.grant_minor - g.held_minor - g.settled_minor : 0;
        if (d.amount_minor > remaining) {
          goodwill.push({ effect_key: d.effect_key, read_remaining_minor: remaining, decision: "SKIP", decremented_minor: 0 });
          log(`${d.effect_key}: goodwill ${d.amount_minor} exceeds pool remainder ${remaining}; skipped`);
          await save("PAYING");
          continue;
        }
      }

      let entry = payments.find((p) => p.effect_key === d.effect_key);
      if (!entry) {
        entry = {
          effect_key: d.effect_key,
          passenger_id: d.passenger_id,
          entitlement_type: d.entitlement_type,
          amount_minor: d.amount_minor,
          currency: "CAD",
          payee_ref: d.payee_ref,
          provider,
          result: "GAVE_UP",
          provider_object_id: null,
          code: null,
          attempts: [],
        };
        payments.push(entry);
      }

      if (provider === "stripe_refund" && d.ticket_payment_ref === null) {
        entry.result = "FAILED";
        entry.code = "NO_TICKET_PAYMENT_REF";
        await save("PAYING");
        continue;
      }
      const client = await deps.providerFor(provider);
      const req = frozenFor(d, provider, runId);
      let accepted = false;
      for (let tries = 0; tries <= maxRetries; tries++) {
        // a FRESH RANDOM key for every attempt: the control never reuses one. The keyless rail takes none.
        const key = client.capabilities.dedupesOnIdempotencyKey ? newKey() : null;
        const r = await client.createPaymentOrRefund(req, { idempotencyKey: key, timeoutMs });
        const desc = describe(r);
        entry.attempts.push({ n: entry.attempts.length + 1, idempotency_key: key, at: now().toISOString(), outcome: desc.outcome, result: desc.text, provider_object_id: desc.objectId });
        log(`${d.effect_key}: attempt ${entry.attempts.length} ${desc.outcome}`);
        if (r.kind === "ACCEPTED") {
          entry.result = "PAID";
          entry.provider_object_id = r.object.id;
          entry.code = null;
          accepted = true;
        } else if (r.kind === "REJECTED_DEFINITIVE") {
          entry.result = "FAILED";
          entry.code = r.code;
        } else if (r.kind === "CONTRADICTION") {
          entry.result = "FAILED";
          entry.code = r.code;
        } else {
          entry.result = "GAVE_UP";
          entry.code = "RETRIES_EXHAUSTED";
        }
        await save("PAYING");
        // The barrier: after the provider's answer, before the claim is marked done (and before the pool is decremented).
        await barrier("CTRL_AFTER_PROVIDER_RESPONSE", d.effect_key);
        if (r.kind !== "INDETERMINATE") break; // a timeout or a 5xx is retried blindly with a new key; everything else ends the attempts
      }

      if (accepted && d.entitlement_type === "GOODWILL") {
        // step 3: decrement, separately from the read and from the payment
        await db.grants.updateOne({ _id: `${runId}:GOODWILL` }, { $inc: { settled_minor: d.amount_minor } });
        goodwill.push({ effect_key: d.effect_key, read_remaining_minor: remaining, decision: "PAY", decremented_minor: d.amount_minor });
        await save("PAYING");
      }
    }

    await db.claims.updateOne({ _id: claim._id }, { $set: { "baseline.done": true, "baseline.done_at": now().toISOString(), "baseline.checkpoint": "DONE", updated_at: now() } });
  }

  // ---- the report: complete at the end, whatever happened
  const report = await buildBaselineReport(runId, deps);
  writeReportFile(report, deps.reportDir ?? join(process.cwd(), "out", "reports"));
  await db.runs.updateOne({ _id: runId }, { $set: { status: "ENDED", ended_at: now(), final_report: report } });
  log(`run ${runId} ENDED, report complete=${report.complete}`);
}

// ---------------------------------------------------------------------------------------------------------------- report

export function writeReportFile(report: FinalReport, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.run_id}.final-report.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

/** Derives the control's final report from its own MongoDB records alone: what it believes it paid. `complete` is true whenever the pass
 *  has finished, with `unresolved` empty: this arm never notices an unknown outcome. */
export async function buildBaselineReport(runId: string, deps: Pick<BaselineDeps, "db" | "now">): Promise<FinalReport> {
  const run = await deps.db.runs.findOne({ _id: runId });
  if (!run) throw new Error(`buildBaselineReport: no execution_runs document for ${runId}`);
  const claims = await deps.db.claims.find({ run_id: runId }).sort({ received_at: 1, claim_id: 1 }).toArray();
  const paid: FinalReport["paid"] = [];
  const refused: FinalReport["refused"] = [];
  const parked: FinalReport["parked"] = [];
  const awaiting: FinalReport["awaiting_budget"] = [];
  const failed: FinalReport["failed_no_effect"] = [];
  const paidKeys = new Set<string>();
  const seen = { refused: new Set<string>(), parked: new Set<string>(), awaiting: new Set<string>(), failed: new Set<string>() };

  const decided = claims.map((c) => ({ c, b: (c as ClaimWithBaseline).baseline })).filter((x): x is { c: (typeof claims)[number]; b: BaselineDoc } => !!x.b && x.b.done);
  for (const { b } of decided) {
    for (const p of b.payments) {
      if (p.result === "PAID" && p.provider_object_id) {
        paidKeys.add(p.effect_key);
        // one provider object reported once: two claims for one entitlement that the provider deduplicated name the same object
        if (paid.some((x) => x.effect_key === p.effect_key && x.provider_object_id === p.provider_object_id)) continue;
        paid.push({
          effect_key: p.effect_key,
          marker: marker(runId, p.effect_key),
          amount_minor: p.amount_minor,
          currency: "CAD",
          payee_ref: p.payee_ref,
          provider: p.provider,
          provider_object_id: p.provider_object_id,
        });
      }
    }
  }
  for (const { c, b } of decided) {
    if (c.status === "HELD" && c.hold_reason) {
      parked.push({ effect_key: null, claim_id: c.claim_id, reason_code: c.hold_reason, amount_minor: null });
      continue;
    }
    for (const d of b.decisions) {
      if (paidKeys.has(d.effect_key)) continue;
      if (d.status === "NOT_OWED") {
        if (!seen.refused.has(d.effect_key)) refused.push({ effect_key: d.effect_key, reason_code: d.reason_code as NotOwedReason, rule_citation: d.rule_citation });
        seen.refused.add(d.effect_key);
      } else if (d.status === "HELD") {
        if (!seen.parked.has(d.effect_key)) parked.push({ effect_key: d.effect_key, claim_id: null, reason_code: d.reason_code as HeldReason, amount_minor: null });
        seen.parked.add(d.effect_key);
      } else {
        const pay = b.payments.find((p) => p.effect_key === d.effect_key);
        if (pay && (pay.result === "FAILED" || pay.result === "GAVE_UP")) {
          if (!seen.failed.has(d.effect_key)) failed.push({ effect_key: d.effect_key, code: pay.code ?? pay.result });
          seen.failed.add(d.effect_key);
        } else if (!pay && d.entitlement_type === "GOODWILL") {
          if (!seen.awaiting.has(d.effect_key)) awaiting.push({ effect_key: d.effect_key, amount_minor: d.amount_minor });
          seen.awaiting.add(d.effect_key);
        }
      }
    }
  }
  const byKey = <T extends { effect_key: string | null; claim_id?: string | null }>(a: T, b: T): number =>
    (a.effect_key ?? a.claim_id ?? "").localeCompare(b.effect_key ?? b.claim_id ?? "");
  paid.sort(byKey);
  refused.sort(byKey);
  parked.sort(byKey);
  awaiting.sort(byKey);
  failed.sort(byKey);

  return FinalReport.parse({
    run_id: runId,
    group_id: run.group_id,
    arm: run.arm,
    scenario: run.scenario,
    generated_at: (deps.now ?? (() => new Date()))().toISOString(),
    complete: true, // the control always says so
    paid,
    refused,
    parked,
    awaiting_budget: awaiting,
    failed_no_effect: failed,
    unresolved: [],
  });
}
