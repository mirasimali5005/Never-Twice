// Outcomes other than settlement: T4/T7 failNoEffect (returns a goodwill reservation), T5 markUnknown (gateway form: same
// epoch, lease cleared, next_attempt_at = $$NOW; mutation site M2), T9/T13 quarantine (the reservation stays held).
import type { Intent, QuarantineReason } from "@nt/contracts";
import { ProgrammerError } from "./errors.ts";
import { applyTransition, lastResult } from "./transition.ts";
import { actorOf, hooksOf, type GatewayDeps } from "./types.ts";

type Rejection = { code: string; message: string; replayed: boolean };

/** T4 (from DISPATCHING) or T7 (from OUTCOME_UNKNOWN): the provider definitively rejected this exact request. */
export async function failNoEffect(deps: GatewayDeps, it: Intent, rej: Rejection): Promise<Intent | null> {
  if (it.state !== "DISPATCHING" && it.state !== "OUTCOME_UNKNOWN") throw new ProgrammerError(`failNoEffect from ${it.state}`);
  return applyTransition(deps.db, {
    intentId: it._id,
    from: it.state,
    to: "FAILED_NO_EFFECT",
    epoch: it.lease_epoch,
    set: {
      rejection: { $mergeObjects: [{ code: { $literal: rej.code }, message: { $literal: rej.message }, replayed: { $literal: rej.replayed }, at: "$$NOW" }] },
      lease: null,
      next_attempt_at: null,
      attempts: lastResult({ kind: "REJECTED_DEFINITIVE", cause: null, code: rej.code, replayed: rej.replayed, provider_object_id: null }),
    },
    grant: it.draws_on ? { id: it.draws_on, held: -it.amount_minor } : undefined,
    event: { actor: actorOf(deps), detail: { code: rej.code, replayed: rej.replayed } },
  });
}

/** T5, gateway form: DISPATCHING → OUTCOME_UNKNOWN at the same epoch. The reservation stays held. */
export async function markUnknown(deps: GatewayDeps, it: Intent, ind: { cause: string; detail?: string }): Promise<Intent | null> {
  if (it.state !== "DISPATCHING") throw new ProgrammerError(`markUnknown from ${it.state}`);
  if (hooksOf(deps).mutation("M2")) {
    // M2 (on-stage mutant): mark the unknown outcome confirmed without provider evidence. Must turn auditor check C5 red.
    return applyTransition(deps.db, {
      intentId: it._id,
      from: "DISPATCHING",
      to: "CONFIRMED",
      epoch: it.lease_epoch,
      set: {
        evidence: {
          $mergeObjects: [{
            source: { $literal: "RESPONSE" }, provider_object_id: { $literal: "MUTANT_NO_EVIDENCE" }, status: { $literal: "paid" },
            amount_minor: "$amount_minor", currency: "$currency", payee_ref: "$payee_ref", marker: "$_id", retrieved_at: "$$NOW",
          }],
        },
        lease: null,
        attempts: lastResult({ kind: "INDETERMINATE", cause: ind.cause, code: null, replayed: null, provider_object_id: null }),
      },
      grant: it.draws_on ? { id: it.draws_on, held: -it.amount_minor, settled: it.amount_minor } : undefined,
      event: { actor: actorOf(deps), detail: { mutation: "M2", cause: ind.cause } },
    });
  }
  return applyTransition(deps.db, {
    intentId: it._id,
    from: "DISPATCHING",
    to: "OUTCOME_UNKNOWN",
    epoch: it.lease_epoch,
    set: {
      lease: null,
      next_attempt_at: "$$NOW",
      attempts: lastResult({ kind: "INDETERMINATE", cause: ind.cause, code: null, replayed: null, provider_object_id: null }),
    },
    event: { actor: actorOf(deps), detail: { cause: ind.cause, ...(ind.detail ? { why: ind.detail } : {}) } },
  });
}

/**
 * T13 (from DISPATCHING) or T9 (from OUTCOME_UNKNOWN). The lease is cleared, the reservation stays held. `result`, when
 * given, is recorded on the newest attempt (the response that caused a T13).
 */
export async function quarantine(
  deps: GatewayDeps,
  it: Intent,
  reason: QuarantineReason,
  detail = "",
  result?: Record<string, unknown>,
): Promise<Intent | null> {
  if (it.state !== "DISPATCHING" && it.state !== "OUTCOME_UNKNOWN") throw new ProgrammerError(`quarantine from ${it.state}; T11 is quarantineReserved`);
  const set: Record<string, unknown> = {
    quarantine: { $mergeObjects: [{ reason: { $literal: reason }, detail: { $literal: detail }, at: "$$NOW" }] },
    lease: null,
    next_attempt_at: null,
  };
  if (result) set.attempts = lastResult(result);
  return applyTransition(deps.db, {
    intentId: it._id,
    from: it.state,
    to: "QUARANTINED",
    epoch: it.lease_epoch,
    set,
    event: { actor: actorOf(deps), detail: { reason, why: detail } },
  });
}
