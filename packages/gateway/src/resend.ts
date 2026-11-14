// The licensed re-send (HANDOVER.md §11.2 apply(), §11.3). The reconciler never calls a provider: it calls these three in
// order with its own barriers between them. recordLicence (T8a) commits with majority BEFORE any byte; resend sends the
// identical frozen bytes under the same key and writes nothing; applyResendResult records the outcome (T6, T7, T8b, T9).
// Mutation sites: M4 in resend (body rebuilt with a changed amount, hash check skipped); M3 gate in resend (`unlicensed`
// accepted only while NT_MUTATION=M3; the deciding site is the reconciler's apply).
import type { DispatchResult, Intent } from "@nt/contracts";
import { backoffMs, matchEvidence, resendCount } from "@nt/recovery/pure";
import { hashMatches, send } from "./dispatch.ts";
import { FrozenRequestHashMismatch, ProgrammerError } from "./errors.ts";
import { failNoEffect, quarantine } from "./outcomes.ts";
import { settle } from "./settle.ts";
import { applyTransition, lastResult } from "./transition.ts";
import { actorOf, hooksOf, type GatewayDeps } from "./types.ts";

export const MAX_ATTEMPTS = 5;

/**
 * T8a: append an L1 licence to attempts at the held epoch, with majority acknowledgement, before anything is sent.
 * Filter: attempts < 5 and $$NOW < key_expires_at (database clock) and a key exists. null → no send may happen.
 * A frozen-bytes mismatch quarantines (T9 CONTRADICTORY_EVIDENCE) instead.
 */
export async function recordLicence(deps: GatewayDeps, it: Intent, licence: "L1_SAME_KEY"): Promise<Intent | null> {
  if (it.state !== "OUTCOME_UNKNOWN") throw new ProgrammerError(`recordLicence from ${it.state}`);
  if (!hashMatches(it)) {
    await quarantine(deps, it, "CONTRADICTORY_EVIDENCE", "FROZEN_REQUEST_HASH_MISMATCH");
    return null;
  }
  return applyTransition(deps.db, {
    intentId: it._id,
    from: "OUTCOME_UNKNOWN",
    to: "OUTCOME_UNKNOWN",
    epoch: it.lease_epoch,
    extraFilter: {
      idempotency_key: { $ne: null },
      $expr: { $and: [{ $lt: [{ $size: "$attempts" }, MAX_ATTEMPTS] }, { $lt: ["$$NOW", "$key_expires_at"] }] },
    },
    set: {
      attempts: {
        $concatArrays: [
          "$attempts",
          [{ n: { $add: [{ $size: "$attempts" }, 1] }, at: "$$NOW", licence: { $literal: licence }, request_sha256: "$frozen_request_sha256", epoch: { $literal: it.lease_epoch }, result: null }],
        ],
      },
      last_send_at: "$$NOW",
    },
    event: { type: "LICENCE_GRANTED", actor: actorOf(deps), detail: { licence, attempt: it.attempts.length + 1 } },
  });
}

/**
 * Re-sends the identical frozen request under the same key. Writes nothing; returns the DispatchResult. Refuses (programmer
 * error) unless the newest attempt is an unused licence at the current epoch on a keyed rail — except `{ unlicensed: true }`,
 * accepted only while NT_MUTATION=M3.
 */
export async function resend(deps: GatewayDeps, it: Intent, opts: { unlicensed?: boolean } = {}): Promise<DispatchResult> {
  const hooks = hooksOf(deps);
  const unlicensed = opts.unlicensed === true;
  if (unlicensed && !hooks.mutation("M3")) throw new ProgrammerError("resend { unlicensed } is accepted only under mutation M3");
  if (!unlicensed) {
    const last = it.attempts[it.attempts.length - 1];
    if (it.state !== "OUTCOME_UNKNOWN" || !last || last.licence === "FIRST_SEND" || last.result !== null || last.epoch !== it.lease_epoch) {
      throw new ProgrammerError(`resend of ${it._id} without an unused licence at epoch ${it.lease_epoch}`);
    }
    if (it.idempotency_key === null) throw new ProgrammerError(`resend of ${it._id} on a keyless rail`);
  }
  if (hooks.mutation("M4")) {
    // M4: "rebuilt from fresh model output": a changed amount, sent under the same key, hash check skipped.
    const rebuilt: Intent = { ...it, frozen_request: { ...it.frozen_request, amount_minor: it.frozen_request.amount_minor + 100 } };
    return send(deps, rebuilt, false);
  }
  if (!hashMatches(it)) throw new FrozenRequestHashMismatch(it._id);
  return send(deps, it, false);
}

/** After a licensed re-send: ACCEPTED+MATCH → T6 (REDISPATCH); ACCEPTED otherwise or CONTRADICTION → T9; REJECTED → T7;
 *  INDETERMINATE → T8b: stay OUTCOME_UNKNOWN, record the result, clear the lease, next_attempt_at = $$NOW + backoff. */
export async function applyResendResult(deps: GatewayDeps, it: Intent, res: DispatchResult): Promise<Intent | null> {
  if (it.state !== "OUTCOME_UNKNOWN") throw new ProgrammerError(`applyResendResult from ${it.state}`);
  switch (res.kind) {
    case "ACCEPTED": {
      const m = matchEvidence(it, [res.object]);
      if (m.kind === "MATCH") return settle(deps, it, { source: "REDISPATCH", object: res.object, replayed: res.replayed });
      return quarantine(deps, it, "CONTRADICTORY_EVIDENCE", `re-send returned an object the matcher rejects: ${m.kind}${"why" in m ? ` ${m.why}` : ""}`, {
        kind: "ACCEPTED", cause: null, code: null, replayed: res.replayed, provider_object_id: res.object.id,
      });
    }
    case "REJECTED_DEFINITIVE":
      return failNoEffect(deps, it, { code: res.code, message: res.message, replayed: res.replayed });
    case "CONTRADICTION":
      return quarantine(deps, it, "CONTRADICTORY_EVIDENCE", `${res.code}: ${res.detail}`, {
        kind: "CONTRADICTION", cause: null, code: res.code, replayed: null, provider_object_id: null,
      });
    case "INDETERMINATE": {
      const wait = backoffMs(resendCount(it)); // n counts re-sends including the one just made
      return applyTransition(deps.db, {
        intentId: it._id,
        from: "OUTCOME_UNKNOWN",
        to: "OUTCOME_UNKNOWN",
        epoch: it.lease_epoch,
        set: {
          attempts: lastResult({ kind: "INDETERMINATE", cause: res.cause, code: null, replayed: null, provider_object_id: null }),
          lease: null,
          next_attempt_at: { $add: ["$$NOW", wait] },
        },
        event: { actor: actorOf(deps), detail: { cause: res.cause, next_attempt_in_ms: wait } },
      });
    }
  }
}
