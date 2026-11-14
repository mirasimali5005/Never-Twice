// Provider-side reversal (Tier 3, CP-REV-1; HANDOVER.md §11.3 PROVIDER_REVERSAL, §21).
//
// Design: CONFIRMED stays terminal and immutable. Nothing here writes payment_intents or authority_grants. A reversal is recorded
// as ONE append-only audit event (type PROVIDER_REVERSAL, from_state/to_state null so property P9 ignores it) whose _id is derived
// from (intent, provider object): two reconcilers that both see the reversal insert the same _id and the second gets 11000, so it
// is recorded exactly once without a read-then-write. The final report derives "parked: PROVIDER_REVERSAL" from that event.
//
// Never re-pays: no provider write method is reachable from here. The goodwill `settled_minor` is deliberately left as it is
// (conservative: the reversed amount stays counted against the cap until a person decides what to do).
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import type { Intent, ProviderObject } from "@nt/contracts";
import { detectReversal } from "@nt/recovery/pure";
import { auditEvent } from "./audit.ts";
import { ProgrammerError } from "./errors.ts";
import { actorOf, type GatewayDeps } from "./types.ts";

export type ReversalRecord = { kind: "RECORDED" | "ALREADY_RECORDED"; event_id: string } | { kind: "NOT_REVERSED"; why: string };

/** Deterministic audit _id for (intent, provider object): the idempotency guard. */
export function reversalEventId(intentId: string, providerObjectId: string): ObjectId {
  return new ObjectId(createHash("sha256").update(`PROVIDER_REVERSAL\0${intentId}\0${providerObjectId}`).digest("hex").slice(0, 24));
}

/**
 * Records that the provider now reports the confirmed object as undone. The gateway re-runs the fixed detector itself and never
 * trusts a caller's claim. Returns NOT_REVERSED (and writes nothing) unless the object is positive evidence of a reversal.
 */
export async function recordProviderReversal(deps: GatewayDeps, it: Intent, object: ProviderObject): Promise<ReversalRecord> {
  if (it.state !== "CONFIRMED") throw new ProgrammerError(`recordProviderReversal on ${it.state}; only CONFIRMED intents can be reversed at the provider`);
  const check = detectReversal(it, object);
  if (check.kind === "STILL_PAID") return { kind: "NOT_REVERSED", why: "STILL_PAID" };
  if (check.kind === "NOT_EVIDENCE") return { kind: "NOT_REVERSED", why: check.why };
  const id = reversalEventId(it._id, object.id);
  const ev = auditEvent("PROVIDER_REVERSAL", it, {
    _id: id,
    actor: actorOf(deps),
    detail: {
      reason: "PROVIDER_REVERSAL",
      provider: it.provider,
      provider_object_id: object.id,
      status_at_confirmation: it.evidence?.status ?? null,
      status_now: check.status,
      amount_minor: it.amount_minor,
      draws_on: it.draws_on,
      action: "PARKED_FOR_PERSON", // never re-paid automatically
    },
  });
  try {
    await deps.db.audit.insertOne(ev, { writeConcern: { w: "majority" } });
    return { kind: "RECORDED", event_id: id.toHexString() };
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return { kind: "ALREADY_RECORDED", event_id: id.toHexString() };
    throw e;
  }
}

/** Intent ids of the run with a recorded PROVIDER_REVERSAL. */
export async function reversedIntentIds(deps: Pick<GatewayDeps, "db">, runId: string): Promise<Set<string>> {
  const evs = await deps.db.audit.find({ run_id: runId, type: "PROVIDER_REVERSAL" }, { projection: { intent_id: 1 } }).toArray();
  return new Set(evs.flatMap((e) => (e.intent_id ? [e.intent_id] : [])));
}
