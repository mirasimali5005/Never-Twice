// Test world for B2 integration tests: a replica set (mongodb-memory-server or NT_TEST_MONGODB_URI) with db:init applied,
// seed helpers for obligations, grants and bookings, and providers that only expose capabilities (B2 never sends).
import { newRunId, type Actor, type EntitlementType, type Obligation, type PaymentProvider, type ProposedPayment, type ProviderId } from "@nt/contracts";
import { openNtDb, type NtDb } from "@nt/db";
import { startTestReplSet, type TestReplSet } from "@nt/db/testing";
import type { GatewayDeps, GatewayHooks } from "../../src/index.ts";

export type World = { rs: TestReplSet; db: NtDb; stop(): Promise<void> };

export async function startWorld(): Promise<World> {
  const rs = await startTestReplSet();
  const db = await openNtDb({ uri: rs.uri, dbName: rs.dbName, role: "gateway" });
  return { rs, db, stop: async () => { await db.close(); await rs.stop(); } };
}

/** A provider that answers capabilities and fails the test on any contact (B2 must never call a provider). */
export function capsOnlyProvider(id: ProviderId, dedupes: boolean): PaymentProvider {
  const contact = () => { throw new Error(`provider ${id} contacted during a B2 test`); };
  return {
    id,
    capabilities: { dedupesOnIdempotencyKey: dedupes, keyRetentionMs: dedupes ? 86_400_000 : null, declaredMaxInFlightMs: null, stronglyConsistentList: true },
    createPaymentOrRefund: contact,
    getOperation: contact,
    findOperationEvidence: contact,
    listOperations: contact,
  };
}

export function depsFor(
  db: NtDb,
  runId: string,
  opts: { mutation?: string; stripeEnabled?: boolean; barriers?: string[]; providers?: GatewayDeps["providers"]; workerId?: string; leaseMs?: number } = {},
): GatewayDeps {
  const hooks: GatewayHooks = {
    barrier: (name) => { opts.barriers?.push(name); },
    mutation: (id) => opts.mutation === id,
  };
  return {
    db,
    runId,
    workerId: opts.workerId ?? "test-runner",
    providers: opts.providers ?? {
      sim_payout: capsOnlyProvider("sim_payout", true),
      sim_keyless: capsOnlyProvider("sim_keyless", false),
      stripe_refund: capsOnlyProvider("stripe_refund", true),
    },
    config: { leaseMs: opts.leaseMs ?? 8000, dispatchTimeoutMs: 3000, keyMarginMs: 60000, stripeEnabled: opts.stripeEnabled ?? false },
    hooks,
  };
}

let pax = 0;
/** An OWED obligation with a fresh passenger id, so keys never collide inside a run. */
export function obligation(runId: string, o: Partial<Obligation> & { entitlement_type?: EntitlementType } = {}): Obligation {
  const passenger_id = o.passenger_id ?? `P${String(++pax).padStart(2, "0")}`;
  const entitlement_type = o.entitlement_type ?? "APPR_DELAY";
  const booking_ref = o.booking_ref ?? "ZT4H9X";
  const disruption_id = "NT101-20261110";
  const effect_key = `${booking_ref}.${passenger_id}.${disruption_id}.${entitlement_type}`;
  const goodwill = entitlement_type === "GOODWILL";
  return {
    _id: `${runId}:${effect_key}`,
    run_id: runId,
    effect_key,
    booking_ref,
    passenger_id,
    disruption_id,
    entitlement_type,
    status: "OWED",
    amount_minor: goodwill ? 15000 : 70000,
    currency: "CAD",
    payee_ref: `payee_${passenger_id}`,
    rail: "instant",
    reason_code: null,
    rule_citation: goodwill ? "NT-GOODWILL@1 OVERNIGHT_STRANDED" : "s. 19(1)(a)(ii)",
    policy_version: goodwill ? "NT-GOODWILL@1" : "APPR-SOR-2019-150@2022-09-08",
    due_by: null,
    claim_ids: ["C01"],
    decided_at: new Date(),
    ...o,
  } as Obligation;
}

export async function seedGrant(db: NtDb, runId: string, o: { grant_minor?: number; held_minor?: number; settled_minor?: number; frozen?: boolean } = {}) {
  await db.grants.insertOne({
    _id: `${runId}:GOODWILL`, run_id: runId, kind: "GOODWILL_POOL", grant_minor: o.grant_minor ?? 50000,
    held_minor: o.held_minor ?? 0, settled_minor: o.settled_minor ?? 0, frozen: o.frozen ?? false, currency: "CAD", policy_version: "NT-GOODWILL@1",
  });
}

const orchestrator: Actor = { kind: "orchestrator", id: "test" };
export function proposalFor(ob: Obligation, o: Partial<ProposedPayment> = {}): ProposedPayment {
  return { run_id: ob.run_id, effect_key: ob.effect_key, amount_minor: ob.amount_minor, currency: "CAD", payee_ref: ob.payee_ref, claim_ids: ob.claim_ids, proposed_by: orchestrator, ...o };
}

export const freshRun = () => newRunId();
