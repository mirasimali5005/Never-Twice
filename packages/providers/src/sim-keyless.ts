// SimKeylessProvider: provider id "sim_keyless", rail "legacy": the simulator ignores any idempotency key, so this client never
// sends one and throws if it is handed one (HANDOVER §12.1; ARCHITECTURE.md §7.2).
import { SimClient, readAccount } from "./sim-client.ts";
import type { SimAccountInfo, SimClientOptions } from "./sim-client.ts";

export class SimKeylessProvider extends SimClient {
  protected constructor(o: SimClientOptions, info: SimAccountInfo) {
    super({ id: "sim_keyless", rail: "legacy" }, o, info);
  }

  /** Reads the account's capabilities once, from GET /v1/accounts/:account. Throws ProviderConfigError if it cannot. */
  static async create(o: SimClientOptions): Promise<SimKeylessProvider> {
    return new SimKeylessProvider(o, await readAccount(o));
  }
}
