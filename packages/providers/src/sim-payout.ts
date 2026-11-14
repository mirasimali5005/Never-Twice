// SimPayoutProvider: provider id "sim_payout", rail "instant": the simulator deduplicates on Idempotency-Key (HANDOVER §12.1).
import { SimClient, readAccount } from "./sim-client.ts";
import type { SimAccountInfo, SimClientOptions } from "./sim-client.ts";

export class SimPayoutProvider extends SimClient {
  protected constructor(o: SimClientOptions, info: SimAccountInfo) {
    super({ id: "sim_payout", rail: "instant" }, o, info);
  }

  /** Reads the account's capabilities once, from GET /v1/accounts/:account. Throws ProviderConfigError if it cannot. */
  static async create(o: SimClientOptions): Promise<SimPayoutProvider> {
    return new SimPayoutProvider(o, await readAccount(o));
  }
}
