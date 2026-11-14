// Gateway dependency and hook types (AGENT_TASKS.md B field 9).
import type { BarrierName, MutationId, PaymentProvider, ProviderCapabilities, ProviderId } from "@nt/contracts";
import type { NtDb } from "@nt/db";

/** Crash barriers and the mutation switch are owned by task B3; B2 receives them as hooks (defaults: no-op, false). */
export type GatewayHooks = {
  barrier(name: BarrierName, effectKey?: string): void;
  mutation(id: MutationId): boolean;
};

export const NO_HOOKS: GatewayHooks = { barrier: () => {}, mutation: () => false };

export type GatewayConfig = {
  leaseMs: number;
  dispatchTimeoutMs: number;
  keyMarginMs: number;
  stripeEnabled: boolean;
  /** NT_INVESTIGATOR_TIMEOUT_MS; default 45000. Part of the reconciler's lease on OUTCOME_UNKNOWN. */
  investigatorTimeoutMs?: number;
};

export type GatewayDeps = {
  db: NtDb;
  runId: string;
  workerId: string;
  providers: Partial<Record<ProviderId, PaymentProvider>>;
  config: GatewayConfig;
  hooks?: GatewayHooks;
  /** Who the audit events name as actor. Default: "reconciler" when workerId starts with "reconciler", else "gateway". */
  actorKind?: "gateway" | "reconciler";
};

export function actorOf(deps: GatewayDeps): { kind: "gateway" | "reconciler"; id: string } {
  return { kind: deps.actorKind ?? (deps.workerId.startsWith("reconciler") ? "reconciler" : "gateway"), id: deps.workerId };
}

export function hooksOf(deps: GatewayDeps): GatewayHooks {
  return deps.hooks ?? NO_HOOKS;
}

export function capabilitiesOf(deps: GatewayDeps, provider: ProviderId): ProviderCapabilities {
  const p = deps.providers[provider];
  if (!p) throw new Error(`gateway: no provider configured for ${provider}`);
  return p.capabilities;
}
