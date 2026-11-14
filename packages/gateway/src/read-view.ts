// readOnlyProviderView(providerId, env): the read-only slice of a provider for the investigator (@nt/recovery/investigator),
// so the reconciler never imports @nt/providers. Built with the READ key; the returned object has no createPaymentOrRefund.
import type { PaymentProvider, ProviderId, ProviderObject } from "@nt/contracts";
import { ProviderConfigError, SimKeylessProvider, SimPayoutProvider, createProvider, type ProviderEnv } from "@nt/providers";

export type ProviderReadView = {
  readonly capabilities: PaymentProvider["capabilities"];
  getOperation: PaymentProvider["getOperation"];
  findOperationEvidence: PaymentProvider["findOperationEvidence"];
  listOperations: PaymentProvider["listOperations"];
  searchOperations?(q: { account: string; marker: string }): Promise<ProviderObject[]>;
  listEvents?(q: { account: string; since?: Date }): Promise<{ type: string; object_id: string; at: string }[]>;
};

/**
 * Simulator: built with NT_SIM_READ_KEY only (passed as both keys; a read key cannot write: the simulator answers 401).
 * stripe_refund: built with STRIPE_SECRET_KEY (a test key; the system has no separate Stripe read key) and exposes only the
 * read methods (the refund list). The object returned carries no write method.
 */
export async function readOnlyProviderView(id: ProviderId, env: ProviderEnv): Promise<ProviderReadView> {
  let p: PaymentProvider & Partial<Pick<ProviderReadView, "searchOperations" | "listEvents">>;
  if (id === "stripe_refund") {
    p = await createProvider("stripe_refund", env);
  } else {
    const readKey = env.NT_SIM_READ_KEY;
    if (!readKey) throw new ProviderConfigError("readOnlyProviderView: NT_SIM_READ_KEY is required");
    const account = env.account ?? (env.NT_RUN_ID ? `acct_${env.NT_RUN_ID}` : undefined);
    if (!account) throw new ProviderConfigError("readOnlyProviderView: NT_RUN_ID or account is required");
    const o = { baseUrl: env.NT_SIM_URL ?? "http://127.0.0.1:4010", account, writeKey: readKey, readKey, ...(env.readTimeoutMs !== undefined ? { readTimeoutMs: env.readTimeoutMs } : {}) };
    p = id === "sim_payout" ? await SimPayoutProvider.create(o) : await SimKeylessProvider.create(o);
  }
  const view: ProviderReadView = {
    capabilities: { ...p.capabilities },
    getOperation: (oid) => p.getOperation(oid),
    findOperationEvidence: (q) => p.findOperationEvidence(q),
    listOperations: (scope) => p.listOperations(scope),
  };
  if (typeof p.searchOperations === "function") view.searchOperations = (q) => p.searchOperations!(q);
  if (typeof p.listEvents === "function") view.listEvents = (q) => p.listEvents!(q);
  return Object.freeze(view);
}
