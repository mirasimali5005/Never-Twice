// The two actions that stand in for a person. No automatic path calls either.
import { ObjectId } from "mongodb";
import type { Intent } from "@nt/contracts";
import { majorityReader, withTxn } from "@nt/db";
import { auditEvent } from "./audit.ts";
import { goodwillGrantId } from "./authority.ts";
import { NO_LIVE_LEASE, applyTransition } from "./transition.ts";
import type { GatewayDeps } from "./types.ts";

/** T10 RESERVED → RELEASED (human only). Returns a goodwill reservation. Impossible after dispatch, by filter. */
export async function releaseReserved(deps: GatewayDeps, intentId: string, actor: string): Promise<Intent | null> {
  const it = await majorityReader(deps.db.db, "intents").findOne({ _id: intentId });
  if (!it || it.state !== "RESERVED") return null;
  return applyTransition(deps.db, {
    intentId,
    from: "RESERVED",
    to: "RELEASED",
    epoch: it.lease_epoch,
    extraFilter: { $expr: NO_LIVE_LEASE },
    set: { lease: null },
    grant: it.draws_on ? { id: it.draws_on, held: -it.amount_minor } : undefined,
    event: { actor: { kind: "human", id: actor }, detail: { actor } },
  });
}

/** Sets the run's goodwill grant `frozen` with a GRANT_FROZEN event, in one transaction. Stands in for a person revoking authority. */
export async function freezeGrant(deps: GatewayDeps, runId: string, actor: string): Promise<void> {
  const id = goodwillGrantId(runId);
  const ev = auditEvent("GRANT_FROZEN", null, { _id: new ObjectId(), run_id: runId, actor: { kind: "human", id: actor }, detail: { grant_id: id } });
  await withTxn(deps.db, async (session) => {
    await deps.db.grants.updateOne({ _id: id }, { $set: { frozen: true } }, { session });
    await deps.db.audit.insertOne(ev, { session });
  });
}
