// The reconciler's MongoDB access (ReconcilerStore). Reads only, except investigation_records (investigator client) and the
// EVIDENCE_RECORDED audit insert. It never writes payment_intents or authority_grants: those change only through the gateway.
// Every lease or deadline comparison is evaluated by the database ($$NOW); the worker's clock is never consulted.
import type { AuditEvent, Intent, RecoveryGuards } from "@nt/contracts";
import { ABSENCE_CLASS } from "@nt/contracts";
import { dbNow, type NtDb } from "@nt/db";
import { faultSignature } from "@nt/recovery/recall";
import { ObjectId, type Document } from "mongodb";
import type { ClosedRecord, OpenedRecord, ReconcilerStore } from "./ports.ts";

const NO_LIVE_LEASE = { $or: [{ $eq: ["$lease", null] }, { $lte: ["$lease.expires_at", "$$NOW"] }] };
const UNRESOLVED = ["RESERVED", "DISPATCHING", "OUTCOME_UNKNOWN"] as const;

const lit = (o: Record<string, unknown>): Document => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { $literal: v }]));

/**
 * `gw`: the nt_gateway client (scans, guards, clock, audit). `inv`: the nt_investigator client (investigation_records).
 * Both may be the same NtDb in tests.
 */
export function createMongoStore(o: { gw: NtDb; inv: NtDb; runId: string }): ReconcilerStore {
  const { gw, inv } = o;
  const intents = gw.intents;
  const sorted = { sort: { _id: 1 as const } };
  return {
    now: () => dbNow(gw),

    orphans: (runId, leaseMs) =>
      intents
        .find(
          { run_id: runId, state: "RESERVED", $expr: { $and: [NO_LIVE_LEASE, { $lte: ["$created_at", { $subtract: ["$$NOW", leaseMs] }] }] } },
          sorted,
        )
        .toArray(),

    expiredDispatching: (runId) =>
      intents.find({ run_id: runId, state: "DISPATCHING", $expr: { $lte: ["$lease.expires_at", "$$NOW"] } }, sorted).toArray(),

    dueUnknown: (runId) =>
      intents
        .find(
          { run_id: runId, state: "OUTCOME_UNKNOWN", $expr: { $and: [NO_LIVE_LEASE, { $lte: ["$next_attempt_at", "$$NOW"] }] } },
          sorted,
        )
        .toArray(),

    watchable: (runId) =>
      intents.find({ run_id: runId, state: "QUARANTINED", "quarantine.reason": { $in: [...ABSENCE_CLASS] } }, sorted).toArray(),

    unresolvedCount: (runId) => intents.countDocuments({ run_id: runId, state: { $in: [...UNRESOLVED] } }),

    async guards(it: Intent): Promise<RecoveryGuards> {
      const ob = await gw.obligations.findOne({ _id: it.obligation_id } as Document);
      let grantFrozen = false;
      if (it.draws_on !== null) {
        const g = await gw.grants.findOne({ _id: it.draws_on } as Document);
        grantFrozen = g ? g.frozen !== false : true; // a missing grant is treated as frozen (conservative)
      }
      if (!ob) return { obligationStatus: "NOT_OWED", obligationReason: null, grantFrozen }; // missing → row 4, AUTHORITY_REVOKED
      return { obligationStatus: ob.status, obligationReason: ob.reason_code ?? null, grantFrozen };
    },

    async openInvestigation(it: Intent, worker: string): Promise<OpenedRecord> {
      const id = new ObjectId();
      await inv.investigations.updateOne(
        { _id: id } as Document,
        [
          {
            $set: {
              ...lit({
                run_id: it.run_id,
                intent_id: it._id,
                epoch: it.lease_epoch,
                worker,
                provider: it.provider,
                rail: it.frozen_request.rail ?? null,
                investigator: null,
                hypothesis: null,
                steps: [],
                records: [],
                match: null,
                decision: null,
                licence: null,
                closed_at: null,
              }),
              opened_at: "$$NOW",
            },
          },
        ],
        { upsert: true },
      );
      return { id };
    },

    async closeInvestigation(rec: OpenedRecord, it: Intent, c: ClosedRecord, worker: string): Promise<void> {
      await inv.investigations.updateOne({ _id: rec.id } as Document, [
        {
          $set: {
            ...lit({
              investigator: c.investigator,
              fallback_reason: c.fallback_reason,
              hypothesis: c.hypothesis === null ? null : c.hypothesis.slice(0, 280),
              steps: c.steps,
              records: c.records,
              complete: c.complete,
              match: c.match,
              match_detail: c.match_detail,
              decision: c.decision,
              licence: c.licence,
              guards: c.guards,
              db_now: c.db_now,
              fault_signature: faultSignature(it, c.match),
              evidence_queries: c.steps.filter((s) => s.record_count > 0).map((s) => s.tool),
              ...(c.recalled !== undefined ? { recalled: c.recalled.filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x)) } : {}),
            }),
            closed_at: "$$NOW",
          },
        },
      ]);
      const ev: AuditEvent = {
        _id: new ObjectId(),
        run_id: it.run_id,
        at: new Date(), // writer clock: informational only; no decision reads it
        actor: { kind: "reconciler", id: worker },
        type: "EVIDENCE_RECORDED",
        intent_id: it._id,
        effect_key: it.effect_key,
        claim_id: null,
        from_state: it.state,
        to_state: null,
        rule_citation: it.rule_citation,
        policy_version: it.policy_version,
        detail: {
          investigation_id: rec.id.toHexString(),
          epoch: it.lease_epoch,
          investigator: c.investigator,
          fallback_reason: c.fallback_reason,
          record_count: c.records.length,
          match: c.match,
          decision: c.decision.kind,
          row: c.decision.row,
          reason: c.decision.kind === "QUARANTINE" ? c.decision.reason : null,
          licence: c.licence,
        },
      };
      await gw.audit.insertOne(ev);
    },
  };
}
