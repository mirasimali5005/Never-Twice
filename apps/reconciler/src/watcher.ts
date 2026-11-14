// Tier 2 watcher (HANDOVER.md §11.1 step 4, transition T12). For each QUARANTINED intent with an absence-class reason: collect evidence
// with the deterministic investigator, run the fixed matcher, and on MATCH ask the gateway to confirm it. Anything but MATCH changes
// nothing. The watcher takes no lease and sends nothing; T12 is the gateway's compare-and-set on (state, lease_epoch).
import type { Intent } from "@nt/contracts";
import { isAbsenceClass, matchEvidence } from "@nt/recovery/pure";
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
