// Leases (ARCHITECTURE.md §3.3). T2 markDispatching (write-ahead mark + lease), T5 takeOverExpired (reconciler form),
// acquireLease on OUTCOME_UNKNOWN (not a transition: one guarded update, majority, no audit event). Every time comparison
// is $$NOW inside the write; a worker's clock is never used for a lease or key-window decision.
import type { Intent } from "@nt/contracts";
import { majorityReader } from "@nt/db";
import { keyExpiresAt } from "@nt/recovery/pure";
import type { T11Reason } from "./adopt.ts";
import { ProgrammerError } from "./errors.ts";
import { NO_LIVE_LEASE, applyTransition, lastResult } from "./transition.ts";
import { actorOf, capabilitiesOf, type GatewayDeps } from "./types.ts";

/** Lease durations from config (HANDOVER.md §5.2): dispatch = NT_LEASE_MS; reconciler = investigator + dispatch + lease (56 s). */
export const DEFAULT_INVESTIGATOR_TIMEOUT_MS = 45_000;
export function reconLeaseMs(deps: GatewayDeps): number {
  const c = deps.config;
  return (c.investigatorTimeoutMs ?? DEFAULT_INVESTIGATOR_TIMEOUT_MS) + c.dispatchTimeoutMs + c.leaseMs;
}

const newLease = (owner: string, ms: number) => ({ owner: { $literal: owner }, expires_at: { $add: ["$$NOW", ms] } });

/** Thrown inside the T2 transaction when the obligation or grant check fails; carries the T11 reason. */
class BusinessGuardFailed extends Error {
  readonly reason: T11Reason;
  readonly detail: string;
  constructor(reason: T11Reason, detail: string) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

export type MarkResult =
  | { kind: "MARKED"; intent: Intent }
  | { kind: "CAS_MISS"; current: Intent | null }
  | { kind: "GUARD_FAILED"; reason: T11Reason; detail: string; current: Intent | null };

/**
 * T2 RESERVED → DISPATCHING. Inside one transaction: snapshot reads of the obligation (OWED, same payee) and, when the
 * intent draws on the pool, the grant (not frozen) — checks, not fences (HANDOVER.md §10.2) — then the compare-and-set on
 * state, the expected epoch and no live lease, plus the TRANSITION event. Nothing is sent before this has committed.
 */
export async function markDispatching(deps: GatewayDeps, it: Intent, worker = deps.workerId): Promise<MarkResult> {
  if (it.state !== "RESERVED") throw new ProgrammerError(`markDispatching from ${it.state}`);
  const caps = capabilitiesOf(deps, it.provider);
  // key_expires_at = first_dispatch_at + retention - margin (keyExpiresAt, @nt/recovery/pure), with first_dispatch_at = $$NOW.
  const keyOffset = it.idempotency_key === null ? null : keyExpiresAt(new Date(0), caps, deps.config.keyMarginMs);
  try {
    const r = await applyTransition(deps.db, {
      intentId: it._id,
      from: "RESERVED",
      to: "DISPATCHING",
      epoch: it.lease_epoch,
      extraFilter: { $expr: NO_LIVE_LEASE },
      precheck: async (session) => {
        const ob = await deps.db.obligations.findOne({ _id: it.obligation_id }, { session });
        if (!ob) throw new BusinessGuardFailed("AUTHORITY_REVOKED", "obligation missing");
        if (ob.status === "HELD" && ob.reason_code === "PAYEE_CHANGE_REQUESTED") throw new BusinessGuardFailed("PAYEE_CHANGED", "obligation HELD: PAYEE_CHANGE_REQUESTED");
        if (ob.status !== "OWED") throw new BusinessGuardFailed("AUTHORITY_REVOKED", `obligation ${ob.status}`);
        if (ob.payee_ref !== it.payee_ref) throw new BusinessGuardFailed("AUTHORITY_REVOKED", "payee differs from the obligation");
        if (it.draws_on) {
          const g = await deps.db.grants.findOne({ _id: it.draws_on }, { session });
          if (!g || g.frozen) throw new BusinessGuardFailed("AUTHORITY_REVOKED", g ? "grant frozen" : "grant missing");
        }
      },
      set: {
        lease_epoch: { $add: ["$lease_epoch", 1] },
        lease: newLease(worker, deps.config.leaseMs),
        first_dispatch_at: { $ifNull: ["$first_dispatch_at", "$$NOW"] },
        last_send_at: "$$NOW",
        key_expires_at: keyOffset === null ? null : { $add: ["$$NOW", keyOffset.getTime()] },
        attempts: {
          $concatArrays: [
            "$attempts",
            [{
              n: { $add: [{ $size: "$attempts" }, 1] }, at: "$$NOW", licence: "FIRST_SEND", request_sha256: "$frozen_request_sha256",
              epoch: { $add: ["$lease_epoch", 1] }, result: null,
            }],
          ],
        },
      },
      event: { actor: actorOf(deps), detail: { worker, lease_epoch_after: it.lease_epoch + 1 } },
    });
    if (r) return { kind: "MARKED", intent: r };
    return { kind: "CAS_MISS", current: await majorityReader(deps.db.db, "intents").findOne({ _id: it._id }) };
  } catch (e) {
    if (e instanceof BusinessGuardFailed) {
      return { kind: "GUARD_FAILED", reason: e.reason, detail: e.detail, current: await majorityReader(deps.db.db, "intents").findOne({ _id: it._id }) };
    }
    throw e;
  }
}

/** T5, reconciler form: an expired DISPATCHING lease is taken over. lease_epoch + 1, lease cleared, next_attempt_at = $$NOW. */
export async function takeOverExpired(deps: GatewayDeps, intentId: string, expectedEpoch: number): Promise<Intent | null> {
  return applyTransition(deps.db, {
    intentId,
    from: "DISPATCHING",
    to: "OUTCOME_UNKNOWN",
    epoch: expectedEpoch,
    extraFilter: { $expr: { $lte: ["$lease.expires_at", "$$NOW"] } },
    set: {
      lease_epoch: { $add: ["$lease_epoch", 1] },
      lease: null,
      next_attempt_at: "$$NOW",
      attempts: lastResult({ kind: "LEASE_EXPIRED", cause: null, code: null, replayed: null, provider_object_id: null }),
    },
    event: { actor: actorOf(deps), detail: { cause: "LEASE_EXPIRED", lease_epoch_after: expectedEpoch + 1 } },
  });
}

/**
 * Lease on an OUTCOME_UNKNOWN intent (reconciler step 3). Not a transition: one guarded single-document update with
 * write concern majority and no audit event. Duration NT_INVESTIGATOR_TIMEOUT_MS + NT_DISPATCH_TIMEOUT_MS + NT_LEASE_MS.
 * null: another worker holds it, it is not yet due, or the epoch moved.
 */
export async function acquireLease(deps: GatewayDeps, intentId: string, expectedEpoch: number, worker = deps.workerId): Promise<Intent | null> {
  return deps.db.intents.findOneAndUpdate(
    {
      _id: intentId,
      state: "OUTCOME_UNKNOWN",
      lease_epoch: expectedEpoch,
      $expr: { $and: [NO_LIVE_LEASE, { $lte: [{ $ifNull: ["$next_attempt_at", "$$NOW"] }, "$$NOW"] }] },
    },
    [{ $set: { lease: newLease(worker, reconLeaseMs(deps)), lease_epoch: { $add: ["$lease_epoch", 1] }, updated_at: "$$NOW" } }],
    { returnDocument: "after", writeConcern: { w: "majority" } },
  );
}
