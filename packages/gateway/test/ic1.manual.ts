// IC1 manual run (not a vitest file): one obligation through propose → dispatch → CONFIRMED against the running provider
// simulator and the database named by NT_MONGODB_URI / NT_DB_NAME. Seeds its own run (fresh run id, simulator account
// acct_<run>) and one S0-shaped obligation directly; the real seed script is task H1.
// Run from the repository root:  node --env-file=.env packages/gateway/test/ic1.manual.ts
import { newRunId, type Obligation } from "@nt/contracts";
import { closeAll, connect } from "@nt/db";
import { createProvider } from "@nt/providers";
import { createGateway } from "../src/index.ts";

const env = process.env;
const runId = newRunId();
const account = `acct_${runId}`;
const simUrl = env.NT_SIM_URL ?? "http://127.0.0.1:4010";

const res = await fetch(`${simUrl}/admin/accounts`, {
  method: "POST",
  headers: { authorization: `Bearer ${env.NT_SIM_ADMIN_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ account }),
});
console.log(`simulator account ${account}: HTTP ${res.status}`);

const db = await connect("gateway", env);
const effect_key = "ZT4H9X.P02.NT101-20261110.APPR_DELAY";
const ob: Obligation = {
  _id: `${runId}:${effect_key}`, run_id: runId, effect_key, booking_ref: "ZT4H9X", passenger_id: "P02", disruption_id: "NT101-20261110",
  entitlement_type: "APPR_DELAY", status: "OWED", amount_minor: 70000, currency: "CAD", payee_ref: "payee_P02", rail: "instant",
  reason_code: null, rule_citation: "s. 19(1)(a)(ii)", policy_version: "APPR-SOR-2019-150@2022-09-08", due_by: null,
  claim_ids: ["C02"], decided_at: new Date(),
};
await db.obligations.insertOne(ob);

const penv = { ...env, NT_RUN_ID: runId };
const gateway = createGateway({
  db,
  runId,
  workerId: "ic1-runner",
  providers: { sim_payout: await createProvider("sim_payout", penv), sim_keyless: await createProvider("sim_keyless", penv) },
  config: { leaseMs: Number(env.NT_LEASE_MS ?? 8000), dispatchTimeoutMs: Number(env.NT_DISPATCH_TIMEOUT_MS ?? 3000), keyMarginMs: Number(env.NT_KEY_MARGIN_MS ?? 60000), stripeEnabled: false },
});

const proposed = await gateway.propose({
  run_id: runId, effect_key, amount_minor: 70000, currency: "CAD", payee_ref: "payee_P02", claim_ids: ["C02"], proposed_by: { kind: "orchestrator", id: "ic1" },
});
console.log(`propose → ${proposed.kind}`);
if (proposed.kind !== "RESERVED") process.exit(1);
const after = await gateway.dispatch(proposed.intent._id);
console.log(`dispatch → ${after.state}`);

// What is visible in MongoDB afterwards (fresh reads).
const stored = await db.intents.findOne({ _id: ob._id });
console.log("payment_intents:", JSON.stringify({
  _id: stored?._id, state: stored?.state, lease: stored?.lease, lease_epoch: stored?.lease_epoch, idempotency_key: stored?.idempotency_key,
  first_dispatch_at: stored?.first_dispatch_at, key_expires_at: stored?.key_expires_at, attempts: stored?.attempts, evidence: stored?.evidence,
}, null, 2));
const events = await db.audit.find({ run_id: runId }).sort({ _id: 1 }).toArray();
for (const e of events) console.log(`audit_events: ${e.type} ${e.from_state ?? "-"} -> ${e.to_state ?? "-"} ${JSON.stringify(e.detail)}`);

const lookup = await fetch(`${simUrl}/v1/payouts?account=${account}&payee_ref=payee_P02`, { headers: { authorization: `Bearer ${env.NT_SIM_READ_KEY}` } });
const page = (await lookup.json()) as { data: { id: string; status: string; amount_minor: number; metadata: Record<string, string> }[] };
for (const o of page.data) console.log(`simulator ledger: ${o.id} ${o.status} ${o.amount_minor} nt_marker=${o.metadata["nt_marker"]}`);
await closeAll();
