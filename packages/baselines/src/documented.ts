// Arm B, `documented`: documented practice, not sabotaged (HANDOVER.md §15; AGENT_TASKS.md E5 Tier 2).
//
// Frozen behaviour: the same intake and rules as Never Twice (decideClaim: extractClaim, resolve, computeObligations). A STABLE idempotency
// key per entitlement, derived exactly as Never Twice derives it (marker(runId, effect_key), the intent id), sent on every attempt on a
// rail that deduplicates on a key (the keyless rail takes none). A timeout or a 5xx is retried with the same key up to three times.
// Checkpoints after each step (claim decided; each payment recorded) and RE-EXECUTES the step that was interrupted on resume. A 2xx means
// paid. NO write-ahead intent, NO evidence-based settlement, NO reconciler: when retries are exhausted the payment is marked failed and
// the run continues. Goodwill: a non-atomic read, check, pay, decrement. The report says complete at the end.
//
// It stamps nt_effect_key, nt_run_id, nt_marker and nt_type in provider metadata only so the auditor can attribute its payments. Its own
// bookkeeping is the `baseline` sub-document on its run's `claims` documents, the same shape as arm A's.
import { marker, type DispatchResult } from "@nt/contracts";
import {
  buildBaselineReport,
  controlBarrier,
  decideClaim,
  describe,
  frozenFor,
  providerIdFor,
  writeReportFile,
  type BaselineDeps,
  type BaselineDoc,
  type BaselineGoodwillStep,
  type BaselinePayment,
  type DecidedClaim,
} from "./control.ts";
import { join } from "node:path";

type ClaimWithBaseline = { baseline?: BaselineDoc };

/** Same crash barrier name as arm A, so one kill instruction hits every arm at the same moment: after the provider answered, before the
 *  answer is checkpointed. */
export type DocumentedDeps = Omit<BaselineDeps, "newKey" | "maxRetries">;

/** the documented retry budget: three retries, with the same key */
export const DOCUMENTED_MAX_RETRIES = 3;

/** The key arm B sends: the same value Never Twice uses (the intent id, i.e. the marker), stable across attempts, restarts and claims. */
export const stableKey = (runId: string, effectKey: string): string => marker(runId, effectKey);

export async function runDocumented(deps: DocumentedDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.dispatchTimeoutMs ?? 3000;
  const barrier = deps.barrier ?? ((name, effectKey) => controlBarrier(name, effectKey));
  const { runId, db } = deps;

  await db.runs.updateOne({ _id: runId }, [{ $set: { status: "RUNNING", started_at: { $ifNull: ["$started_at", now()] } } }]);

  const claims = await db.claims.find({ run_id: runId }).sort({ received_at: 1, claim_id: 1 }).toArray();
  const bookings = await db.bookings.find({ run_id: runId }).toArray();
  const baselineOf = (c: unknown): BaselineDoc | undefined => (c as ClaimWithBaseline).baseline;

  // ---- step 1 per claim: decide. Checkpointed: a claim already decided is not extracted again on resume.
  const decided: DecidedClaim[] = [];
  for (const claim of claims) {
    const prior = baselineOf(claim);
    if (prior) {
      if (!prior.done) decided.push({ claim_id: claim.claim_id, held: claim.hold_reason ?? null, decisions: prior.decisions });
      continue;
    }
    const d = await decideClaim(deps, claim, bookings);
    const baseline: BaselineDoc = { done: false, done_at: null, checkpoint: "DECIDED", decisions: d.decisions, payments: [], goodwill: [] };
    await db.claims.updateOne(
      { _id: claim._id },
      {
        $set: {
          status: d.held === null ? "RESOLVED" : "HELD",
          hold_reason: d.held as never,
          extraction: d.extraction,
          resolution: d.resolution,
          flags: d.flags,
          effect_keys: d.decisions.map((x) => x.effect_key),
          updated_at: now(),
          baseline,
        },
      },
    );
    decided.push({ claim_id: claim.claim_id, held: d.held, decisions: d.decisions });
  }

  if (deps.beforePayout) await deps.beforePayout(decided);

  // ---- step 2 per payment: pay (stable key, up to three retries), then checkpoint the result
  for (const claim of claims) {
    const stored = baselineOf(await db.claims.findOne({ _id: claim._id }));
    if (!stored || stored.done) continue;
    const payments: BaselinePayment[] = stored.payments ?? [];
    const goodwill: BaselineGoodwillStep[] = stored.goodwill ?? [];
    const checkpoint = async (cp: BaselineDoc["checkpoint"]): Promise<void> => {
      await db.claims.updateOne({ _id: claim._id }, { $set: { "baseline.payments": payments, "baseline.goodwill": goodwill, "baseline.checkpoint": cp, updated_at: now() } });
    };

    for (const d of stored.decisions) {
      if (d.status !== "OWED") continue;
      if (payments.some((p) => p.effect_key === d.effect_key)) continue; // checkpointed: this step finished before the restart
      const provider = providerIdFor(d, deps.stripeEnabled);

      // Goodwill: a non-atomic check (read the pool, compare, pay, then decrement as a separate write).
      let remaining = 0;
      if (d.entitlement_type === "GOODWILL") {
        const g = await db.grants.findOne({ _id: `${runId}:GOODWILL` });
        remaining = g ? g.grant_minor - g.held_minor - g.settled_minor : 0;
        if (d.amount_minor > remaining) {
          goodwill.push({ effect_key: d.effect_key, read_remaining_minor: remaining, decision: "SKIP", decremented_minor: 0 });
          log(`${d.effect_key}: goodwill ${d.amount_minor} exceeds pool remainder ${remaining}; skipped`);
          await checkpoint("PAYING");
          continue;
        }
      }

      const entry: BaselinePayment = {
        effect_key: d.effect_key,
        passenger_id: d.passenger_id,
        entitlement_type: d.entitlement_type,
        amount_minor: d.amount_minor,
        currency: "CAD",
        payee_ref: d.payee_ref,
        provider,
        result: "FAILED",
        provider_object_id: null,
        code: null,
        attempts: [],
      };
      if (provider === "stripe_refund" && d.ticket_payment_ref === null) {
        entry.code = "NO_TICKET_PAYMENT_REF";
        payments.push(entry);
        await checkpoint("PAYING");
        continue;
      }
      const client = await deps.providerFor(provider);
      const req = frozenFor(d, provider, runId);
      const key = client.capabilities.dedupesOnIdempotencyKey ? stableKey(runId, d.effect_key) : null; // the SAME key every attempt
      let accepted = false;
      for (let tries = 0; tries <= DOCUMENTED_MAX_RETRIES; tries++) {
        const r: DispatchResult = await client.createPaymentOrRefund(req, { idempotencyKey: key, timeoutMs });
        const desc = describe(r);
        entry.attempts.push({ n: entry.attempts.length + 1, idempotency_key: key, at: now().toISOString(), outcome: desc.outcome, result: desc.text, provider_object_id: desc.objectId });
        log(`${d.effect_key}: attempt ${entry.attempts.length} ${desc.outcome}`);
        if (r.kind === "ACCEPTED") {
          entry.result = "PAID";
          entry.provider_object_id = r.object.id;
          entry.code = null;
          accepted = true;
          break;
        }
        if (r.kind === "INDETERMINATE") {
          entry.result = "FAILED"; // retries exhausted: marked failed, the run continues
          entry.code = "RETRIES_EXHAUSTED";
          continue;
        }
        entry.result = "FAILED";
        entry.code = r.kind === "REJECTED_DEFINITIVE" || r.kind === "CONTRADICTION" ? r.code : "UNEXPECTED";
        break;
      }
      // The barrier: the provider has answered, nothing is recorded yet. A kill here is re-executed on resume (same key).
      await barrier("CTRL_AFTER_PROVIDER_RESPONSE", d.effect_key);
      payments.push(entry);
      await checkpoint("PAYING");

      if (accepted && d.entitlement_type === "GOODWILL") {
        await db.grants.updateOne({ _id: `${runId}:GOODWILL` }, { $inc: { settled_minor: d.amount_minor } });
        goodwill.push({ effect_key: d.effect_key, read_remaining_minor: remaining, decision: "PAY", decremented_minor: d.amount_minor });
        await checkpoint("PAYING");
      }
    }
    await db.claims.updateOne({ _id: claim._id }, { $set: { "baseline.done": true, "baseline.done_at": now().toISOString(), "baseline.checkpoint": "DONE", updated_at: now() } });
  }

  const report = await buildBaselineReport(runId, deps);
  writeReportFile(report, deps.reportDir ?? join(process.cwd(), "out", "reports"));
  await db.runs.updateOne({ _id: runId }, { $set: { status: "ENDED", ended_at: now(), final_report: report } });
  log(`run ${runId} ENDED, report complete=${report.complete}`);
}
