// createGateway (AGENT_TASKS.md B field 9): one Gateway per process. Provider write credentials reach the gateway only
// through the provider objects in deps. Hooks default to the real barrier and mutation switch.
// createGatewayFromEnv(role, env) is the convenience entry for the runner and the reconciler: it opens the `gateway`
// database role client and builds the provider clients with the write key.
import type { DispatchResult, Intent, ProposedPayment, ProposeResult, ProviderCapabilities, ProviderId, ProviderObject, QuarantineReason } from "@nt/contracts";
import { connect } from "@nt/db";
import { createProvider, type ProviderEnv } from "@nt/providers";
import { quarantineReserved, type T11Reason } from "./adopt.ts";
import { barrier } from "./barrier.ts";
import { dispatch } from "./dispatch.ts";
import { freezeGrant, releaseReserved } from "./human.ts";
import { scanInvariants, type InvariantReport } from "./invariants.ts";
import { acquireLease, takeOverExpired } from "./lease.ts";
import { mutation } from "./mutation.ts";
import { quarantine } from "./outcomes.ts";
import { applyResendResult, recordLicence, resend } from "./resend.ts";
import { propose } from "./reserve.ts";
import { confirmQuarantined, settle, type Evidence } from "./settle.ts";
import { capabilitiesOf, type GatewayConfig, type GatewayDeps } from "./types.ts";

export const EVIDENCE_LIST_MARGIN_MS = 60_000;

export interface Gateway {
  readonly deps: GatewayDeps;
  // B2
  propose(p: ProposedPayment): Promise<ProposeResult>;
  quarantineReserved(intentId: string, reason: T11Reason, detail: string): Promise<Intent | null>;
  // B3
  dispatch(intentId: string, worker?: string): Promise<Intent>;
  takeOverExpired(intentId: string, expectedEpoch: number): Promise<Intent | null>;
  acquireLease(intentId: string, expectedEpoch: number): Promise<Intent | null>;
  findEvidence(it: Intent): Promise<{ records: ProviderObject[]; complete: boolean }>;
  settle(it: Intent, evidence: Evidence): Promise<Intent | null>;
  quarantine(it: Intent, reason: QuarantineReason, detail?: string): Promise<Intent | null>;
  recordLicence(it: Intent, licence: "L1_SAME_KEY"): Promise<Intent | null>;
  resend(it: Intent, opts?: { unlicensed?: boolean }): Promise<DispatchResult>;
  applyResendResult(it: Intent, res: DispatchResult): Promise<Intent | null>;
  confirmQuarantined(it: Intent, object: ProviderObject): Promise<Intent | null>;
  releaseReserved(intentId: string, actor: string): Promise<Intent | null>;
  freezeGrant(runId: string, actor: string): Promise<void>;
  capabilitiesOf(provider: ProviderId): ProviderCapabilities;
  scanInvariants(runId: string): Promise<InvariantReport>;
}

export function withDefaultHooks(deps: GatewayDeps): GatewayDeps {
  return deps.hooks ? deps : { ...deps, hooks: { barrier, mutation } };
}

export function createGateway(input: GatewayDeps): Gateway {
  const deps = withDefaultHooks(input);
  if (deps.config.dispatchTimeoutMs >= deps.config.leaseMs) {
    throw new Error(`gateway: NT_DISPATCH_TIMEOUT_MS (${deps.config.dispatchTimeoutMs}) must be below NT_LEASE_MS (${deps.config.leaseMs})`);
  }
  return {
    deps,
    propose: (p) => propose(deps, p),
    quarantineReserved: (id, r, d) => quarantineReserved(deps, id, r, d),
    dispatch: (id, worker) => dispatch(deps, id, worker),
    takeOverExpired: (id, e) => takeOverExpired(deps, id, e),
    acquireLease: (id, e) => acquireLease(deps, id, e),
    findEvidence: async (it) => {
      const p = deps.providers[it.provider];
      if (!p) throw new Error(`gateway: no provider configured for ${it.provider}`);
      const base = it.first_dispatch_at ?? it.created_at;
      return p.findOperationEvidence({
        account: it.frozen_request.account,
        payeeRef: it.payee_ref,
        parentRef: it.frozen_request.parent_ref,
        since: new Date(base.getTime() - EVIDENCE_LIST_MARGIN_MS),
      });
    },
    settle: (it, e) => settle(deps, it, e),
    quarantine: (it, r, d) => quarantine(deps, it, r, d),
    recordLicence: (it, l) => recordLicence(deps, it, l),
    resend: (it, o) => resend(deps, it, o),
    applyResendResult: (it, res) => applyResendResult(deps, it, res),
    confirmQuarantined: (it, o) => confirmQuarantined(deps, it, o),
    releaseReserved: (id, actor) => releaseReserved(deps, id, actor),
    freezeGrant: (runId, actor) => freezeGrant(deps, runId, actor),
    capabilitiesOf: (p) => capabilitiesOf(deps, p),
    scanInvariants: (runId) => scanInvariants(deps, runId),
  };
}

export type GatewayEnv = ProviderEnv & {
  NT_MONGODB_URI?: string | undefined;
  NT_MONGODB_URI_GATEWAY?: string | undefined;
  NT_DB_NAME?: string | undefined;
  NT_RUN_ID?: string | undefined;
  NT_LEASE_MS?: string | undefined;
  NT_DISPATCH_TIMEOUT_MS?: string | undefined;
  NT_KEY_MARGIN_MS?: string | undefined;
  NT_INVESTIGATOR_TIMEOUT_MS?: string | undefined;
  NT_STRIPE_ENABLED?: string | undefined;
};

const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

export function configFromEnv(env: GatewayEnv): GatewayConfig {
  return {
    leaseMs: num(env.NT_LEASE_MS, 8000),
    dispatchTimeoutMs: num(env.NT_DISPATCH_TIMEOUT_MS, 3000),
    keyMarginMs: num(env.NT_KEY_MARGIN_MS, 60000),
    investigatorTimeoutMs: num(env.NT_INVESTIGATOR_TIMEOUT_MS, 45000),
    stripeEnabled: env.NT_STRIPE_ENABLED !== "false",
  };
}

/**
 * The runner and the reconciler call this. Opens the `gateway` database role (NT_MONGODB_URI_GATEWAY, else NT_MONGODB_URI),
 * builds sim_payout and sim_keyless with NT_SIM_WRITE_KEY for the run's account (acct_<NT_RUN_ID>), and stripe_refund when
 * NT_STRIPE_ENABLED is not "false". workerId defaults to `<role>-<pid>`; a reconciler's audit events name actor "reconciler".
 */
export async function createGatewayFromEnv(
  role: "runner" | "reconciler",
  env: GatewayEnv,
  opts: { runId?: string; workerId?: string } = {},
): Promise<Gateway> {
  const runId = opts.runId ?? env.NT_RUN_ID;
  if (!runId) throw new Error("createGatewayFromEnv: NT_RUN_ID (or opts.runId) is required");
  const config = configFromEnv(env);
  const penv: ProviderEnv = { ...env, NT_RUN_ID: runId };
  const providers: GatewayDeps["providers"] = {
    sim_payout: await createProvider("sim_payout", penv),
    sim_keyless: await createProvider("sim_keyless", penv),
  };
  if (config.stripeEnabled) providers.stripe_refund = await createProvider("stripe_refund", penv);
  const db = await connect("gateway", env);
  return createGateway({
    db,
    runId,
    workerId: opts.workerId ?? `${role}-${process.pid}`,
    actorKind: role === "reconciler" ? "reconciler" : "gateway",
    providers,
    config,
  });
}
