// Adoption and divergence (HANDOVER.md §9.4) and T11 RESERVED → QUARANTINED.
import type { Actor, Intent, ProposeResult } from "@nt/contracts";
import { majorityReader } from "@nt/db";
import { auditEvent } from "./audit.ts";
import { NO_LIVE_LEASE, applyTransition } from "./transition.ts";
import type { GatewayDeps } from "./types.ts";

export type T11Reason = "PAYEE_CHANGED" | "DECISION_DIVERGENCE" | "AUTHORITY_REVOKED";

const gatewayActor = (deps: GatewayDeps): Actor => ({ kind: "gateway", id: deps.workerId });

/**
 * T11: RESERVED → QUARANTINED. Leaves a goodwill reservation held (no grant delta). Compare-and-set on the state, the
 * epoch read here and "no live lease". Returns null if the intent is not RESERVED (or changed concurrently).
 */
export async function quarantineReserved(deps: GatewayDeps, intentId: string, reason: T11Reason, detail: string): Promise<Intent | null> {
  const current = await majorityReader(deps.db.db, "intents").findOne({ _id: intentId });
  if (!current || current.state !== "RESERVED") return null;
  return applyTransition(deps.db, {
    intentId,
    from: "RESERVED",
    to: "QUARANTINED",
    epoch: current.lease_epoch,
    extraFilter: { $expr: NO_LIVE_LEASE },
    set: { quarantine: { $mergeObjects: [{ reason: { $literal: reason }, detail: { $literal: detail }, at: "$$NOW" }] } },
    event: { actor: gatewayActor(deps), detail: { reason, detail } },
  });
}

/**
 * Called after the reserve transaction ended with 11000 (or an unknown commit result for which the existing intent is
 * not ours): majority read by _id; equal hash → INTENT_ADOPTED / ADOPTED; different → DECISION_DIVERGENCE, T11 if still
 * RESERVED, DIVERGED. Never pays a difference. Returns null when no intent exists under that _id.
 */
export async function adoptExisting(deps: GatewayDeps, intentId: string, frozenSha256: string, claimId: string | null): Promise<ProposeResult | null> {
  const existing = await majorityReader(deps.db.db, "intents").findOne({ _id: intentId });
  if (!existing) return null;
  const actor = gatewayActor(deps);
  if (existing.frozen_request_sha256 === frozenSha256) {
    await deps.db.audit.insertOne(auditEvent("INTENT_ADOPTED", existing, { actor, claim_id: claimId, detail: { state: existing.state } }));
    return { kind: "ADOPTED", intent: existing };
  }
  await deps.db.audit.insertOne(
    auditEvent("DECISION_DIVERGENCE", existing, {
      actor,
      claim_id: claimId,
      detail: { existing_sha256: existing.frozen_request_sha256, proposed_sha256: frozenSha256, state: existing.state },
    }),
  );
  let intent = existing;
  if (existing.state === "RESERVED") {
    const q = await quarantineReserved(deps, intentId, "DECISION_DIVERGENCE", "a later proposal for this key produced a different frozen request");
    intent = q ?? (await majorityReader(deps.db.db, "intents").findOne({ _id: intentId })) ?? existing;
  }
  return { kind: "DIVERGED", intent };
}
