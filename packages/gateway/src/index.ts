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
export { goodwillGrantId, goodwillGuard, holdGoodwill } from "./authority.ts";
export { adoptExisting, quarantineReserved, type T11Reason } from "./adopt.ts";
export { buildIntent, propose } from "./reserve.ts";
