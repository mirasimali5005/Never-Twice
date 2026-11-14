// Builds the gateway for the runner process through @nt/gateway's createGatewayFromEnv (task B3).
// The runner never imports @nt/providers (HANDOVER.md §18): the write credential reaches only the provider objects
// that the gateway package builds internally. Orchestration code gets back a gateway with propose and dispatch.
import { createGatewayFromEnv } from "@nt/gateway";
import { connect, type NtDb, type RoleEnv as DbRoleEnv } from "@nt/db";
import type { RoleEnv } from "@nt/contracts";
import type { RunnerGateway } from "./orchestrator.ts";

type RunnerEnv = RoleEnv<"runner">;

export async function buildGateway(env: RunnerEnv, runId: string, workerId: string): Promise<{ gateway: RunnerGateway; db: NtDb }> {
  const gatewayDb = await connect("gateway", env as DbRoleEnv);
  const gateway = await createGatewayFromEnv("runner", env as unknown as Parameters<typeof createGatewayFromEnv>[1], { runId, workerId });
  return { gateway: gateway as unknown as RunnerGateway, db: gatewayDb };
}
