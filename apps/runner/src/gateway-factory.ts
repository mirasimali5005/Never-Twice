// Builds the gateway for the runner process. The write credential reaches ONLY the provider objects handed to createGateway
// (HANDOVER.md §6.2); orchestration code gets back a gateway with propose and dispatch and nothing else.
// @nt/gateway's createGateway (task B3) and @nt/providers' createProvider (task C2) are loaded lazily and by name, so this file type-checks
// and the rest of the runner runs (tests use a fake) before those tasks are merged.
import { connect, type NtDb, type RoleEnv as DbRoleEnv } from "@nt/db";
import type { PaymentProvider, ProviderId, RoleEnv } from "@nt/contracts";
import type { RunnerGateway } from "./orchestrator.ts";

type RunnerEnv = RoleEnv<"runner">;

type GatewayModule = {
  createGateway?: (deps: {
    db: NtDb;
    runId: string;
    workerId: string;
    providers: Partial<Record<ProviderId, PaymentProvider>>;
    config: { leaseMs: number; dispatchTimeoutMs: number; keyMarginMs: number; stripeEnabled: boolean };
  }) => RunnerGateway;
};
type ProvidersModule = {
  createProvider?: (id: ProviderId, env: Record<string, string | undefined>) => Promise<PaymentProvider>;
};

// A variable specifier keeps the type checker from resolving modules that may not export these names yet.
async function load<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

export async function buildGateway(env: RunnerEnv, runId: string, workerId: string): Promise<{ gateway: RunnerGateway; db: NtDb }> {
  const gatewayDb = await connect("gateway", env as DbRoleEnv);
  const gw = await load<GatewayModule>("@nt/gateway");
  const pv = await load<ProvidersModule>("@nt/providers");
  if (typeof gw.createGateway !== "function") throw new Error("@nt/gateway does not export createGateway yet (task B3 is not merged)");
  if (typeof pv.createProvider !== "function") throw new Error("@nt/providers does not export createProvider yet (task C2 is not merged)");

  const penv = { NT_SIM_URL: env.NT_SIM_URL, NT_SIM_WRITE_KEY: env.NT_SIM_WRITE_KEY, NT_RUN_ID: runId, STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY };
  const providers: Partial<Record<ProviderId, PaymentProvider>> = {
    sim_payout: await pv.createProvider("sim_payout", penv),
    sim_keyless: await pv.createProvider("sim_keyless", penv),
  };
  if (env.NT_STRIPE_ENABLED) providers.stripe_refund = await pv.createProvider("stripe_refund", penv);

  const gateway = gw.createGateway({
    db: gatewayDb,
    runId,
    workerId,
    providers,
    config: { leaseMs: env.NT_LEASE_MS, dispatchTimeoutMs: env.NT_DISPATCH_TIMEOUT_MS, keyMarginMs: env.NT_KEY_MARGIN_MS, stripeEnabled: env.NT_STRIPE_ENABLED },
  });
  return { gateway, db: gatewayDb };
}
