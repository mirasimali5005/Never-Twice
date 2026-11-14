// investigate() and apply(), HANDOVER.md §11.2 line for line. Fixed code decides: the matcher and the recovery table from
// @nt/recovery/pure. Every state change goes through the gateway; the reconciler never calls a provider and never writes an intent.
import type { DispatchResult, Intent, ProviderObject, RecoveryDecision } from "@nt/contracts";
import { decideRecovery, matchEvidence } from "@nt/recovery/pure";
import type { ObjectId } from "mongodb";
import type { Barrier, Collect, Logger, ReconcilerGateway, ReconcilerStore } from "./ports.ts";

export type InvestigateDeps = {
  workerId: string;
  gateway: ReconcilerGateway;
  store: ReconcilerStore;
  collect: Collect;
  barrier: Barrier;
  log?: Logger;
};

export type ApplyOutcome = {
  decision: RecoveryDecision["kind"];
  /** The intent the last gateway call returned; null when the gateway reported that another worker acted (or nothing was licensed). */
  intent: Intent | null;
  resend?: DispatchResult["kind"];
  licensed?: boolean;
};

/** Records de-duplicated by provider object id (first occurrence wins), before the matcher sees them. */
export function dedupeById(records: readonly ProviderObject[]): ProviderObject[] {
  const seen = new Map<string, ProviderObject>();
  for (const r of records) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

/** `it` is the intent as returned by acquireLease (the caller holds the lease at it.lease_epoch). */
export async function investigate(d: InvestigateDeps, it: Intent): Promise<ApplyOutcome> {
  const rec = await d.store.openInvestigation(it, d.workerId);
  const collected = await d.collect(it);
  const records = dedupeById(collected.records);
  const match = matchEvidence(it, records);
  const guards = await d.store.guards(it);
  const now = await d.store.now();
  const decision = decideRecovery(it, match, d.gateway.capabilitiesOf(it.provider), now, guards);
  await d.store.closeInvestigation(
    rec,
    it,
    {
      investigator: collected.investigator,
      fallback_reason: collected.fallback_reason,
      hypothesis: collected.hypothesis,
      steps: collected.steps,
      records,
      complete: collected.complete,
      match: match.kind,
      match_detail: match.kind === "CONTRADICTION" ? match.why : null,
      decision,
      licence: decision.kind === "REDISPATCH_SAME_KEY" ? decision.licence : null,
      guards,
      db_now: now,
    },
    d.workerId,
  );
  d.barrier("BR_RECON_AFTER_EVIDENCE", it.effect_key);
  d.log?.(`[${d.workerId}] ${it._id}: ${collected.investigator} → ${match.kind} → ${decision.kind}${decision.kind === "QUARANTINE" ? ` ${decision.reason}` : ""}`);
  return apply(d, decision, it, rec.id);
}

export async function apply(d: InvestigateDeps, decision: RecoveryDecision, it: Intent, investigationId: ObjectId): Promise<ApplyOutcome> {
  switch (decision.kind) {
    case "SETTLE": {
      const after = await d.gateway.settle(it, { object: decision.object, source: "PROBE" }, { investigationId }); // T6
      return { decision: decision.kind, intent: after };
    }
    case "QUARANTINE": {
      const after = await d.gateway.quarantine(it, decision.reason, decision.detail); // T9
      return { decision: decision.kind, intent: after };
    }
    case "REDISPATCH_SAME_KEY": {
      const it2 = await d.gateway.recordLicence(it, decision.licence, { investigationId }); // T8a: majority, BEFORE any byte
      if (!it2) {
        d.log?.(`[${d.workerId}] ${it._id}: licence not recorded (window closed, budget spent or fenced); nothing sent`);
        return { decision: decision.kind, intent: null, licensed: false };
      }
      d.barrier("BR_RECON_AFTER_LICENCE", it.effect_key);
      const res = await d.gateway.resend(it2); // assertHash; same frozen bytes; same key
      d.barrier("BR_RECON_AFTER_RESEND", it.effect_key);
      const after = await d.gateway.applyResendResult(it2, res); // T6 | T7 | T8b | T9
      return { decision: decision.kind, intent: after, resend: res.kind, licensed: true };
    }
  }
}
