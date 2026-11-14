// Audit events (HANDOVER.md §8.2). State-changing events carry a non-null to_state (INTENT_RESERVED, TRANSITION,
// LICENCE_GRANTED); the others (INTENT_ADOPTED, DECISION_DIVERGENCE, BUDGET_REFUSED, ANOMALY, ...) carry to_state null,
// which is how property P9 counts one event per state change.
import { ObjectId } from "mongodb";
import type { Actor, AuditEvent, AuditEventType, Intent, IntentState } from "@nt/contracts";

export type AuditExtra = {
  _id?: ObjectId;
  actor: Actor;
  from_state?: IntentState | null;
  to_state?: IntentState | null;
  claim_id?: string | null;
  detail?: Record<string, unknown>;
  at?: Date;
};

/** Builds an audit event about an intent (or, with `intent` null, about a run). `at` is informational (writer's clock). */
export function auditEvent(
  type: AuditEventType,
  intent: Pick<Intent, "_id" | "run_id" | "effect_key" | "rule_citation" | "policy_version"> | null,
  extra: AuditExtra & { run_id?: string; effect_key?: string | null },
): AuditEvent {
  const runId = intent?.run_id ?? extra.run_id;
  if (!runId) throw new Error("auditEvent: run_id is required");
  return {
    _id: extra._id ?? new ObjectId(),
    run_id: runId,
    at: extra.at ?? new Date(),
    actor: extra.actor,
    type,
    intent_id: intent?._id ?? null,
    effect_key: intent?.effect_key ?? extra.effect_key ?? null,
    claim_id: extra.claim_id ?? null,
    from_state: extra.from_state ?? null,
    to_state: extra.to_state ?? null,
    rule_citation: intent?.rule_citation ?? null,
    policy_version: intent?.policy_version ?? null,
    detail: extra.detail ?? {},
  };
}
