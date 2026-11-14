// createGateway (AGENT_TASKS.md B field 9): one Gateway per process. Provider write credentials reach the gateway only
// through the provider objects in deps. Hooks default to the real barrier and mutation switch.
import type { Intent, ProposedPayment, ProposeResult, ProviderCapabilities, ProviderId, ProviderObject, QuarantineReason } from "@nt/contracts";
import { quarantineReserved, type T11Reason } from "./adopt.ts";
import { barrier } from "./barrier.ts";
import { dispatch } from "./dispatch.ts";
import { acquireLease, takeOverExpired } from "./lease.ts";
import { mutation } from "./mutation.ts";
import { quarantine } from "./outcomes.ts";
import { propose } from "./reserve.ts";
import { confirmQuarantined, settle, type Evidence } from "./settle.ts";
import { capabilitiesOf, type GatewayDeps } from "./types.ts";

export type GatewayPart1 = {
  propose(p: ProposedPayment): Promise<ProposeResult>;
  quarantineReserved(intentId: string, reason: T11Reason, detail: string): Promise<Intent | null>;
  dispatch(intentId: string, worker?: string): Promise<Intent>;
  takeOverExpired(intentId: string, expectedEpoch: number): Promise<Intent | null>;
  acquireLease(intentId: string, expectedEpoch: number): Promise<Intent | null>;
  settle(it: Intent, evidence: Evidence): Promise<Intent | null>;
  quarantine(it: Intent, reason: QuarantineReason, detail?: string): Promise<Intent | null>;
  confirmQuarantined(it: Intent, object: ProviderObject): Promise<Intent | null>;
  capabilitiesOf(provider: ProviderId): ProviderCapabilities;
};

export function withDefaultHooks(deps: GatewayDeps): GatewayDeps {
  return deps.hooks ? deps : { ...deps, hooks: { barrier, mutation } };
}

export function createGatewayPart1(input: GatewayDeps): GatewayPart1 {
  const deps = withDefaultHooks(input);
  return {
    propose: (p) => propose(deps, p),
    quarantineReserved: (id, r, d) => quarantineReserved(deps, id, r, d),
    dispatch: (id, worker) => dispatch(deps, id, worker),
    takeOverExpired: (id, e) => takeOverExpired(deps, id, e),
    acquireLease: (id, e) => acquireLease(deps, id, e),
    settle: (it, e) => settle(deps, it, e),
    quarantine: (it, r, d) => quarantine(deps, it, r, d),
    confirmQuarantined: (it, o) => confirmQuarantined(deps, it, o),
    capabilitiesOf: (p) => capabilitiesOf(deps, p),
  };
}
