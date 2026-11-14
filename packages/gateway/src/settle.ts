// Settlement on evidence: T3 (DISPATCHING → CONFIRMED), T6 (OUTCOME_UNKNOWN → CONFIRMED), T12 (QUARANTINED → CONFIRMED,
// absence-class reasons only). The gateway re-runs matchEvidence itself and never trusts a caller's claim of a match.
// Goodwill: held → settled in the same transaction. Barriers BR_SETTLE_IN_TXN and BR_SETTLE_AFTER_COMMIT.
import { ABSENCE_CLASS, type Intent, type ProviderObject } from "@nt/contracts";
import { matchEvidence } from "@nt/recovery/pure";
import { ProgrammerError } from "./errors.ts";
import { applyTransition, lastResult } from "./transition.ts";
import { actorOf, hooksOf, type GatewayDeps } from "./types.ts";

export type Evidence = { source: "RESPONSE" | "REDISPATCH" | "PROBE"; object: ProviderObject; replayed?: boolean };

function evidenceSet(e: Evidence) {
  const o = e.object;
  return {
    source: { $literal: e.source },
    provider_object_id: { $literal: o.id },
    status: { $literal: o.status },
    amount_minor: { $literal: o.amount_minor },
    currency: { $literal: o.currency },
    payee_ref: { $literal: o.payee_ref },
    marker: { $literal: o.metadata["nt_marker"] ?? null },
    retrieved_at: "$$NOW",
  };
}

const acceptedResult = (e: Evidence) => ({ kind: "ACCEPTED", cause: null, code: null, replayed: e.replayed ?? null, provider_object_id: e.object.id });

function requireMatch(it: Intent, object: ProviderObject): void {
  const m = matchEvidence(it, [object]);
  if (m.kind !== "MATCH") throw new ProgrammerError(`settle refused for ${it._id}: matcher returned ${m.kind}${"why" in m ? ` ${m.why}` : ""}`);
}

/** T3 from DISPATCHING or T6 from OUTCOME_UNKNOWN, at the epoch the caller holds. null: fenced or already moved. */
export async function settle(deps: GatewayDeps, it: Intent, e: Evidence): Promise<Intent | null> {
  if (it.state !== "DISPATCHING" && it.state !== "OUTCOME_UNKNOWN") throw new ProgrammerError(`settle from ${it.state}`);
  requireMatch(it, e.object);
  const hooks = hooksOf(deps);
  const set: Record<string, unknown> = { evidence: { $mergeObjects: [evidenceSet(e)] }, lease: null };
  if (it.state === "OUTCOME_UNKNOWN") set.next_attempt_at = null;
  if (e.source !== "PROBE") set.attempts = lastResult(acceptedResult(e)); // the response to the newest send
  const r = await applyTransition(deps.db, {
    intentId: it._id,
    from: it.state,
    to: "CONFIRMED",
    epoch: it.lease_epoch,
    set,
    grant: it.draws_on ? { id: it.draws_on, held: -it.amount_minor, settled: it.amount_minor } : undefined,
    event: { actor: actorOf(deps), detail: { evidence_source: e.source, provider_object_id: e.object.id } },
    beforeCommit: () => hooks.barrier("BR_SETTLE_IN_TXN", it.effect_key),
  });
  if (r) hooks.barrier("BR_SETTLE_AFTER_COMMIT", it.effect_key);
  return r;
}

/** T12 (Tier 2 watcher): QUARANTINED with an absence-class reason → CONFIRMED on a matching object. quarantine is kept. */
export async function confirmQuarantined(deps: GatewayDeps, it: Intent, object: ProviderObject): Promise<Intent | null> {
  if (it.state !== "QUARANTINED") throw new ProgrammerError(`confirmQuarantined from ${it.state}`);
  requireMatch(it, object);
  return applyTransition(deps.db, {
    intentId: it._id,
    from: "QUARANTINED",
    to: "CONFIRMED",
    epoch: it.lease_epoch,
    extraFilter: { "quarantine.reason": { $in: [...ABSENCE_CLASS] } },
    set: { evidence: { $mergeObjects: [evidenceSet({ source: "PROBE", object })] } },
    grant: it.draws_on ? { id: it.draws_on, held: -it.amount_minor, settled: it.amount_minor } : undefined,
    event: { actor: actorOf(deps), detail: { provider_object_id: object.id, prior_reason: it.quarantine?.reason ?? null } },
  });
}
