// applyTransition: the one template every transition except T1 uses (ARCHITECTURE.md §3.2; AGENT_TASKS.md B field 12).
// One transaction: compare-and-set on (state, lease_epoch); optional grant counter delta; one audit event.
import { ObjectId, type ClientSession, type Document, type Filter } from "mongodb";
import { allowedTransition, type Actor, type AuditEventType, type Intent, type IntentState, type TransitionId } from "@nt/contracts";
import { CasMiss, majorityReader, tryTxn, type NtDb } from "@nt/db";
import { auditEvent } from "./audit.ts";
import { InvariantViolation, ProgrammerError } from "./errors.ts";

/** "No live lease" evaluated with the database clock. */
export const NO_LIVE_LEASE = { $or: [{ $eq: ["$lease", null] }, { $lte: ["$lease.expires_at", "$$NOW"] }] };

export type TransitionSpec = {
  intentId: string;
  from: IntentState;
  to: IntentState;
  /** The lease_epoch the caller holds or read. Always in the filter. */
  epoch: number;
  /** Body of ONE pipeline $set stage. Caller-supplied values must be wrapped in { $literal: v }. state and updated_at are added. */
  set: Document;
  extraFilter?: Filter<Intent>;
  /** Signed deltas; only when the intent draws on a grant. */
  grant?: { id: string; held?: number; settled?: number };
  event: { type?: AuditEventType; actor: Actor; detail: Record<string, unknown> };
  /** Reads inside the transaction before the compare-and-set (T2's obligation and grant checks). Throwing aborts. */
  precheck?: (session: ClientSession) => Promise<void>;
  /** Last statement inside the callback (BR_SETTLE_IN_TXN). Only a barrier may go here. */
  beforeCommit?: () => void;
};

/** Pipeline expression that sets `result` on the newest attempt (attempt numbers are 1-based; ARCHITECTURE.md §3.4). */
export function lastResult(result: Record<string, unknown>): Document {
  return {
    $map: {
      input: "$attempts",
      as: "a",
      in: { $cond: [{ $eq: ["$$a.n", { $size: "$attempts" }] }, { $mergeObjects: ["$$a", { result: { $literal: result } }] }, "$$a"] },
    },
  };
}

/**
 * Returns the intent after the transition, or null when the compare-and-set matched nothing (the caller re-reads and
 * never forces). Throws ProgrammerError before touching the database for a forbidden (from, to) pair.
 */
export async function applyTransition(db: NtDb, spec: TransitionSpec): Promise<Intent | null> {
  const tid: TransitionId | null = allowedTransition(spec.from, spec.to);
  if (tid === null || tid === "T1") throw new ProgrammerError(`forbidden transition ${spec.from} -> ${spec.to}`);
  const eventId = new ObjectId(); // minted once, outside the callback: re-runs reuse it, and it answers "did this commit?"
  let after: Intent | null = null;

  const out = await tryTxn(db, async (session) => {
    if (spec.precheck) await spec.precheck(session);
    after = await db.intents.findOneAndUpdate(
      { _id: spec.intentId, state: spec.from, lease_epoch: spec.epoch, ...(spec.extraFilter ?? {}) } as Filter<Intent>,
      [{ $set: { ...spec.set, state: { $literal: spec.to }, updated_at: "$$NOW" } }],
      { session, returnDocument: "after" },
    );
    if (!after) throw new CasMiss();
    if (spec.grant) {
      const held = spec.grant.held ?? 0;
      const settled = spec.grant.settled ?? 0;
      const g = await db.grants.updateOne(
        { _id: spec.grant.id, ...(held < 0 ? { held_minor: { $gte: -held } } : {}) },
        { $inc: { held_minor: held, settled_minor: settled } },
        { session },
      );
      if (g.modifiedCount !== 1) throw new InvariantViolation(`grant ${spec.grant.id} counters do not cover intent ${spec.intentId}`);
    }
    const a = after as Intent;
    await db.audit.insertOne(
      auditEvent(spec.event.type ?? "TRANSITION", a, {
        _id: eventId,
        actor: spec.event.actor,
        from_state: spec.from,
        to_state: spec.to,
        detail: { transition: tid, epoch: spec.epoch, ...spec.event.detail },
      }),
      { session },
    );
    spec.beforeCommit?.();
  });

  switch (out.kind) {
    case "COMMITTED":
      return after;
    case "CAS_MISS":
      return null;
    case "UNKNOWN_COMMIT_RESULT": {
      const committed = await majorityReader(db.db, "audit").findOne({ _id: eventId });
      return committed ? await majorityReader(db.db, "intents").findOne({ _id: spec.intentId }) : null;
    }
    case "DUPLICATE_KEY":
      throw out.error; // no transition inserts a document with a natural key; surface it
  }
}
