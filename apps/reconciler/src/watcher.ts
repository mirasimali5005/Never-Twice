// Tier 2 watcher (HANDOVER.md §11.1 step 4, transition T12). For each QUARANTINED intent with an absence-class reason: collect evidence
// with the deterministic investigator, run the fixed matcher, and on MATCH ask the gateway to confirm it. Anything but MATCH changes
// nothing. The watcher takes no lease and sends nothing; T12 is the gateway's compare-and-set on (state, lease_epoch).
import type { Intent } from "@nt/contracts";
import { detectReversal, isAbsenceClass, matchEvidence } from "@nt/recovery/pure";
import { dedupeById, type InvestigateDeps } from "./investigate.ts";
import type { Collect } from "./ports.ts";

export type WatchDeps = InvestigateDeps & { watchCollect?: Collect };

/** Returns true when the gateway confirmed the intent. */
export async function watchOne(d: WatchDeps, it: Intent): Promise<boolean> {
  if (it.state !== "QUARANTINED" || !it.quarantine || !isAbsenceClass(it.quarantine.reason)) return false;
  if (!d.watchCollect || !d.gateway.confirmQuarantined) return false;
  const collected = await d.watchCollect(it);
  const match = matchEvidence(it, dedupeById(collected.records));
  if (match.kind !== "MATCH") return false;
  const after = await d.gateway.confirmQuarantined(it, match.object);
  if (after?.state === "CONFIRMED") d.log?.(`[${d.workerId}] ${it._id}: T12 confirmed from later evidence (was ${it.quarantine.reason})`);
  return after?.state === "CONFIRMED";
}

/**
 * Tier 3 (CP-REV-1, HANDOVER.md §11.3 PROVIDER_REVERSAL; §21 "a provider's acknowledgement is not payment finality"). For a CONFIRMED
 * intent: re-read its confirmed provider object through the read-only view; if the fixed detector says the provider now reports it
 * undone, ask the gateway to record a PROVIDER_REVERSAL audit event (the report then parks it for a person). The intent stays
 * CONFIRMED, nothing is re-sent, and a missing object or a read error changes nothing. Returns true when an event was recorded.
 */
export async function watchReversal(d: WatchDeps, it: Intent): Promise<boolean> {
  if (it.state !== "CONFIRMED" || it.evidence === null || !d.gateway.recordProviderReversal) return false;
  const obj = await d.gateway.readOnlyProviderView(it.provider).getOperation(it.evidence.provider_object_id);
  const check = detectReversal(it, obj);
  if (check.kind !== "REVERSED") return false;
  const r = await d.gateway.recordProviderReversal(it, obj!);
  if (r.kind === "RECORDED") d.log?.(`[${d.workerId}] ${it._id}: PROVIDER_REVERSAL (${it.evidence.provider_object_id} is now ${check.status}); parked for a person, not re-paid`);
  return r.kind === "RECORDED";
}
