// @nt/gateway — B2 part (T1, T11, adoption). Temporary entry until B3's createGateway; owned by B3 after B2 merges.
import type { Intent, ProposedPayment, ProposeResult } from "@nt/contracts";
import { quarantineReserved, type T11Reason } from "./adopt.ts";
import { propose } from "./reserve.ts";
import type { GatewayDeps } from "./types.ts";

export type Reserver = {
  propose(p: ProposedPayment): Promise<ProposeResult>;
  quarantineReserved(intentId: string, reason: T11Reason, detail: string): Promise<Intent | null>;
};

/** For IC1 scripts until B3 lands createGateway. */
export function createReserver(deps: GatewayDeps): Reserver {
  return {
    propose: (p) => propose(deps, p),
    quarantineReserved: (id, reason, detail) => quarantineReserved(deps, id, reason, detail),
  };
}

export * from "./types.ts";
export * from "./errors.ts";
export { auditEvent } from "./audit.ts";
export { applyTransition, NO_LIVE_LEASE, type TransitionSpec } from "./transition.ts";
export { buildFrozenRequest, idempotencyKeyFor, providerFor } from "./frozen.ts";
export { authorityLeafId, chainFrozen, goodwillGrantId, goodwillGuard, grantChain, holdGoodwill, relativeGrantId } from "./authority.ts";
export { seedGrantTree, type GrantNode } from "./grant-tree.ts";
export { adoptExisting, quarantineReserved, type T11Reason } from "./adopt.ts";
export { buildIntent, propose } from "./reserve.ts";
export { barrier, barrierAfterMs } from "./barrier.ts";
export { mutation } from "./mutation.ts";
export { acquireLease, markDispatching, reconLeaseMs, takeOverExpired, type MarkResult } from "./lease.ts";
export { failNoEffect, markUnknown, quarantine } from "./outcomes.ts";
export { confirmQuarantined, settle, type Evidence } from "./settle.ts";
export { dispatch, hashMatches, send } from "./dispatch.ts";
export { lastResult } from "./transition.ts";
export { createGateway, createGatewayFromEnv, configFromEnv, withDefaultHooks, EVIDENCE_LIST_MARGIN_MS, type Gateway, type GatewayEnv } from "./gateway.ts";
export { applyResendResult, recordLicence, resend, MAX_ATTEMPTS } from "./resend.ts";
export { freezeGrant, releaseReserved } from "./human.ts";
export { scanInvariants, type InvariantReport, type InvariantViolation as InvariantFinding } from "./invariants.ts";
export { readOnlyProviderView, type ProviderReadView } from "./read-view.ts";
export { recordProviderReversal, reversalEventId, reversedIntentIds, type ReversalRecord } from "./reversal.ts";
