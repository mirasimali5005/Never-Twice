// Shared B3 test flow: reserve one obligation with fake providers, optionally dispatch it into a given state.
import type { Intent, Obligation } from "@nt/contracts";
import { dispatch, propose, type GatewayDeps } from "../../src/index.ts";
import { fakeProvider, type FakeProvider, type Step } from "./fake-provider.ts";
import { depsFor, freshRun, obligation, proposalFor, seedGrant, type World } from "./world.ts";

export type Flow = { run: string; deps: GatewayDeps; ob: Obligation; id: string; provider: FakeProvider; barriers: string[] };

export async function reservedFlow(
  w: World,
  script: Step[] = [],
  o: Partial<Obligation> = {},
  opts: { mutation?: string; leaseMs?: number; run?: string; workerId?: string; seedGrant?: boolean } = {},
): Promise<Flow> {
  const run = opts.run ?? freshRun();
  if (opts.seedGrant !== false && !(await w.db.grants.findOne({ _id: `${run}:GOODWILL` }))) await seedGrant(w.db, run);
  const fp = { sim_payout: fakeProvider("sim_payout", {}, script), sim_keyless: fakeProvider("sim_keyless", {}, script), stripe_refund: fakeProvider("stripe_refund", {}, script), notify_letter: fakeProvider("notify_letter", {}, script) };
  const barriers: string[] = [];
  const deps = depsFor(w.db, run, { providers: fp, barriers, ...(opts.mutation ? { mutation: opts.mutation } : {}), ...(opts.leaseMs ? { leaseMs: opts.leaseMs } : {}), ...(opts.workerId ? { workerId: opts.workerId } : {}) });
  const ob = obligation(run, o);
  await w.db.obligations.insertOne(ob);
  const r = await propose(deps, proposalFor(ob));
  if (r.kind !== "RESERVED") throw new Error(`setup: ${r.kind}`);
  return { run, deps, ob, id: r.intent._id, provider: fp[r.intent.provider], barriers };
}

/** An OUTCOME_UNKNOWN intent: dispatched against an INDETERMINATE first send. */
export async function unknownFlow(w: World, o: Partial<Obligation> = {}, opts: Parameters<typeof reservedFlow>[3] = {}): Promise<Flow & { it: Intent }> {
  const f = await reservedFlow(w, [{ kind: "INDETERMINATE", cause: "TIMEOUT", detail: "no response" }], o, opts);
  const it = await dispatch(f.deps, f.id);
  if (it.state !== "OUTCOME_UNKNOWN") throw new Error(`setup: ${it.state}`);
  return { ...f, it };
}
