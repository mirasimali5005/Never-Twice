// Orchestrator audit events (insert only; HANDOVER.md §8). The runner holds the agent role: it may insert audit_events and nothing else there.
import { ObjectId } from "mongodb";
import type { Actor, AuditEvent, AuditEventType } from "@nt/contracts";

export const RUNNER_WORKER = "runner-1";
export const ORCHESTRATOR: Actor = { kind: "orchestrator", id: RUNNER_WORKER };

export type RunAuditExtra = {
  effect_key?: string | null;
  claim_id?: string | null;
  rule_citation?: string | null;
  policy_version?: string | null;
  detail?: Record<string, unknown>;
};

/** An audit event about a run, a claim or an obligation (never an intent: those are the gateway's). Build it before the transaction. */
export function runAudit(type: AuditEventType, runId: string, extra: RunAuditExtra = {}): AuditEvent {
  return {
    _id: new ObjectId(),
    run_id: runId,
    at: new Date(),
    actor: ORCHESTRATOR,
    type,
    intent_id: null,
    effect_key: extra.effect_key ?? null,
    claim_id: extra.claim_id ?? null,
    from_state: null,
    to_state: null,
    rule_citation: extra.rule_citation ?? null,
    policy_version: extra.policy_version ?? null,
    detail: extra.detail ?? {},
  };
}
