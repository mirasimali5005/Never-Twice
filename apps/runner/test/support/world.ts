// Test world for the runner: an in-memory replica set with db:init applied, a seeded run (bookings, claims, grant, policies, execution_runs)
// from the real fixtures, the real B2 reserver for `propose`, and a fake `dispatch` that stands in for B3 (the provider is never contacted).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelClient } from "@nt/agents";
import { ClaimIndex, OpsRecord, newGroupId, newRunId, type Arm, type Booking, type Claim, type Intent, type PaymentProvider, type PolicyBundle, type ProviderId } from "@nt/contracts";
import { openNtDb, type NtDb } from "@nt/db";
import { startTestReplSet, type TestReplSet } from "@nt/db/testing";
import { createReserver } from "@nt/gateway";
import { loadPolicyBundle } from "@nt/rules";
import type { RunnerDeps, RunnerGateway } from "../../src/orchestrator.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

export type World = { rs: TestReplSet; db: NtDb; stop(): Promise<void> };

export async function startWorld(): Promise<World> {
  const rs = await startTestReplSet();
  const db = await openNtDb({ uri: rs.uri, dbName: rs.dbName, role: "agent" });
  return {
    rs,
    db,
    stop: async () => {
      await db.close();
      await rs.stop();
    },
  };
}

export const policyBundle = (): PolicyBundle => loadPolicyBundle(join(ROOT, "fixtures", "policies"));

export type Seeded = { runId: string; groupId: string };

/** Seeds a run from fixtures/scenarios/<scenario>. `claimIds` limits which claims are inserted (default: all). */
export async function seedRun(db: NtDb, scenario: "S0" | "S1", o: { arm?: Arm; claimIds?: string[]; runId?: string } = {}): Promise<Seeded> {
  const runId = o.runId ?? newRunId();
  const groupId = newGroupId();
  const dir = join(ROOT, "fixtures", "scenarios", scenario);
  const ops = OpsRecord.parse(JSON.parse(readFileSync(join(dir, "ops-record.json"), "utf8")));
  const dates = new Map(ops.flights.map((f) => [f.flight_no, f.scheduled_departure_local_date]));
  const bookings: Booking[] = ops.bookings.map((b) => ({
    ...b,
    _id: `${runId}:${b.booking_ref}:${b.passenger_id}`,
    run_id: runId,
    disruption: { ...b.disruption, scheduled_departure: new Date(b.disruption.scheduled_departure) },
    // the resolver uses the local flight date when the record carries one (ops flights do)
    ...(dates.has(b.flight_no) ? {} : {}),
  }));
  await db.bookings.insertMany(bookings);

  const index = ClaimIndex.parse(JSON.parse(readFileSync(join(dir, "claims", "index.json"), "utf8")));
  const now = new Date();
  const claims: Claim[] = index
    .filter((c) => !o.claimIds || o.claimIds.includes(c.claim_id))
    .map((c) => ({
      _id: `${runId}:${c.claim_id}`,
      run_id: runId,
      claim_id: c.claim_id,
      channel: c.channel,
      received_at: new Date(c.received_at),
      raw_text: readFileSync(join(dir, "claims", c.file), "utf8"),
      status: "RECEIVED",
      hold_reason: null,
      extraction: null,
      extraction_meta: null,
      resolution: null,
      flags: { payeeChangeRequested: false, goodwillProposed: null },
      effect_keys: [],
      embedding: null,
      created_at: now,
      updated_at: now,
    }));
  await db.claims.insertMany(claims);

  await db.grants.insertOne({
    _id: `${runId}:GOODWILL`,
    run_id: runId,
    kind: "GOODWILL_POOL",
    grant_minor: ops.goodwill_pool.grant_minor,
    held_minor: 0,
    settled_minor: 0,
    frozen: false,
    currency: "CAD",
    policy_version: ops.goodwill_pool.policy_version,
  });
  await db.runs.insertOne({
    _id: runId,
    group_id: groupId,
    arm: o.arm ?? "nt",
    scenario,
    seed: 1,
    fault_schedule: "F-DEMO",
    sim_account: `acct_${runId}`,
    status: "SEEDED",
    started_at: null,
    ended_at: null,
    final_report: null,
  });
  return { runId, groupId };
}

export function replayModel() {
  return createModelClient({ NT_MODEL_MODE: "replay", NT_MODEL_BACKEND: "cli", NT_MODEL_CASSETTE_DIR: join(ROOT, "fixtures", "cassettes") });
}

function capsOnly(id: ProviderId, dedupes: boolean): PaymentProvider {
  const contact = () => {
    throw new Error(`provider ${id} contacted in a runner test`);
  };
  return {
    id,
    capabilities: { dedupesOnIdempotencyKey: dedupes, keyRetentionMs: dedupes ? 86_400_000 : null, declaredMaxInFlightMs: null, stronglyConsistentList: true },
    createPaymentOrRefund: contact,
    getOperation: contact,
    findOperationEvidence: contact,
    listOperations: contact,
  };
}

export type FakeGateway = RunnerGateway & { proposed: string[]; dispatched: string[]; onPropose?: (effectKey: string) => Promise<void> | void };

/** Real B2 `propose` (reserve transaction, goodwill cap) plus a fake `dispatch`: it settles the intent in MongoDB the way the outcome map says. */
export function fakeGateway(db: NtDb, runId: string, outcome: (effectKey: string) => "CONFIRMED" | "OUTCOME_UNKNOWN" = () => "CONFIRMED"): FakeGateway {
  const reserver = createReserver({
    db,
    runId,
    workerId: "runner-1",
    providers: { sim_payout: capsOnly("sim_payout", true), sim_keyless: capsOnly("sim_keyless", false), stripe_refund: capsOnly("stripe_refund", true), notify_letter: capsOnly("notify_letter", false) },
    config: { leaseMs: 8000, dispatchTimeoutMs: 3000, keyMarginMs: 60000, stripeEnabled: false },
  });
  const gw: FakeGateway = {
    proposed: [],
    dispatched: [],
    async propose(p) {
      gw.proposed.push(p.effect_key);
      await gw.onPropose?.(p.effect_key);
      return reserver.propose(p);
    },
    async dispatch(intentId, worker): Promise<Intent> {
      if (worker !== "runner-1") throw new Error(`unexpected worker ${worker}`);
      const it = await db.intents.findOne({ _id: intentId });
      if (!it) throw new Error(`no intent ${intentId}`);
      if (it.state !== "RESERVED") throw new Error(`dispatch called on ${it.state}`);
      gw.dispatched.push(it.effect_key);
      const state = outcome(it.effect_key);
      const set =
        state === "CONFIRMED"
          ? {
              state,
              evidence: { source: "RESPONSE" as const, provider_object_id: `po_${it.effect_key}`, status: "paid", amount_minor: it.amount_minor, currency: it.currency, payee_ref: it.payee_ref, marker: it._id, retrieved_at: new Date() },
            }
          : { state };
      await db.intents.updateOne({ _id: intentId }, { $set: { ...set, updated_at: new Date() } });
      return (await db.intents.findOne({ _id: intentId })) as Intent;
    },
  };
  return gw;
}

export function depsFor(world: World, runId: string, repoRoot: string, gateway?: RunnerGateway, extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return { db: world.db, gateway: gateway ?? fakeGateway(world.db, runId), model: replayModel(), policy: policyBundle(), repoRoot, lettersEnabled: false, ...extra };
}
