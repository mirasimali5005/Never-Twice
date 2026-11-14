// @nt/providers: payment provider clients (tasks C2, C3). Imported only by packages/gateway, packages/baselines and scripts.
// Only the gateway may call createPaymentOrRefund (HANDOVER §12.1).
import type { PaymentProvider } from "@nt/contracts";
import { ProviderConfigError } from "./http.ts";
import { SimKeylessProvider } from "./sim-keyless.ts";
import { SimPayoutProvider } from "./sim-payout.ts";

export { ProviderConfigError, ProviderReadError } from "./http.ts";
export { SimClient, MAX_EVIDENCE_PAGES } from "./sim-client.ts";
export type { SimClientOptions, SimAccountInfo, SimRail } from "./sim-client.ts";
export { SimPayoutProvider } from "./sim-payout.ts";
export { SimKeylessProvider } from "./sim-keyless.ts";
export { FaultInjectingProvider } from "./fault-injecting.ts";
export type { ClientFault, ClientFaultName } from "./fault-injecting.ts";

/** The slice of the process environment `createProvider` reads (a superset of what the runner and reconciler roles receive).
 *  `account` overrides the simulator account; otherwise it is `acct_${NT_RUN_ID}` (HANDOVER §9.2). */
export type ProviderEnv = {
  NT_SIM_URL?: string | undefined;
  NT_SIM_WRITE_KEY?: string | undefined;
  /** Reads use the read key; a write key also reads, so it is the fallback (the runner role holds no read key). */
  NT_SIM_READ_KEY?: string | undefined;
  NT_RUN_ID?: string | undefined;
  account?: string | undefined;
  STRIPE_SECRET_KEY?: string | undefined;
  /** Timeout for the Stripe SDK's default requests and the simulator's read requests, ms (default 5000 simulator, 15000 Stripe). */
  readTimeoutMs?: number | undefined;
};

function need(v: string | undefined, name: string): string {
  if (v === undefined || v === "") throw new ProviderConfigError(`createProvider: ${name} is required`);
  return v;
}

/** Builds one provider. Simulator providers read their capabilities from GET /v1/accounts/:account here (async). */
export async function createProvider(id: PaymentProvider["id"], env: ProviderEnv): Promise<PaymentProvider> {
  switch (id) {
    case "sim_payout":
    case "sim_keyless": {
      const writeKey = need(env.NT_SIM_WRITE_KEY, "NT_SIM_WRITE_KEY");
      const account = env.account ?? `acct_${need(env.NT_RUN_ID, "NT_RUN_ID")}`;
      const o = {
        baseUrl: env.NT_SIM_URL ?? "http://127.0.0.1:4010",
        account,
        writeKey,
        readKey: env.NT_SIM_READ_KEY && env.NT_SIM_READ_KEY !== "" ? env.NT_SIM_READ_KEY : writeKey,
        ...(env.readTimeoutMs !== undefined ? { readTimeoutMs: env.readTimeoutMs } : {}),
      };
      return id === "sim_payout" ? SimPayoutProvider.create(o) : SimKeylessProvider.create(o);
    }
    case "stripe_refund": {
      // Lazy import: simulator-only consumers never load the Stripe SDK. The constructor refuses any key that is not a test key.
      const { StripeRefundProvider } = await import("./stripe-refund.ts");
      const secretKey = need(env.STRIPE_SECRET_KEY, "STRIPE_SECRET_KEY");
      return new StripeRefundProvider({
        secretKey,
        timeoutMs: env.readTimeoutMs ?? 15_000,
        ...(env.NT_RUN_ID ? { runId: env.NT_RUN_ID } : {}),
      });
    }
  }
}
