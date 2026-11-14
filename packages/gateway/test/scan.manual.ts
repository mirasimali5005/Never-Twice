// Manual (not vitest): scanInvariants for one run through createGatewayFromEnv, against the simulator and NT_MONGODB_URI.
//   NT_RUN_ID=<run> node --env-file=.env packages/gateway/test/scan.manual.ts
import { closeAll } from "@nt/db";
import { createGatewayFromEnv } from "../src/index.ts";
const gw = await createGatewayFromEnv("reconciler", process.env);
console.log(`workerId ${gw.deps.workerId}; providers ${Object.keys(gw.deps.providers).join(", ")}`);
console.log(JSON.stringify(await gw.scanInvariants(gw.deps.runId)));
await closeAll();
