// Child process for the crash tests: dispatches one intent with the REAL barrier and mutation hooks and an accepting fake
// provider. Env: CHILD_URI, CHILD_DB, CHILD_RUN, CHILD_ID, plus NT_CRASH_AT set by the parent.
import { openNtDb } from "@nt/db";
import { barrier, dispatch, mutation, type GatewayDeps } from "../../src/index.ts";
import { fakeProvider } from "./fake-provider.ts";

const db = await openNtDb({ uri: process.env.CHILD_URI!, dbName: process.env.CHILD_DB!, role: "gateway" });
const sim = fakeProvider("sim_payout", {}, ["ACCEPT"]);
sim.onCall = async () => { console.log("SENT"); };
const deps: GatewayDeps = {
  db,
  runId: process.env.CHILD_RUN!,
  workerId: "runner-child",
  providers: { sim_payout: sim, sim_keyless: fakeProvider("sim_keyless") },
  config: { leaseMs: 8000, dispatchTimeoutMs: 3000, keyMarginMs: 60000, stripeEnabled: false },
  hooks: { barrier, mutation },
};
const it = await dispatch(deps, process.env.CHILD_ID!);
console.log(`DONE ${it.state}`);
await db.close();
