// PRB-08 (CP-LETTER-1): an ADMITTED generated probe feeds the fixed matcher for decision letters sent through NotifySim (keyless).
// Real pieces: a replica set (@nt/db/testing), the provider simulator as a child process, the real gateway (propose, dispatch,
// acquireLease, settle, quarantine) with the real NotifyLetterProvider, the real reconciler investigate() with the probe evidence
// source, and a probe admitted by the fixed admission code (four canaries) and stored in `probes`.
//   (a) DROP_RESPONSE_AFTER_APPLY on a letter → OUTCOME_UNKNOWN → the admitted probe finds it → MATCH → T6 CONFIRMED (source PROBE)
//   (b) DROP_REQUEST on a letter → OUTCOME_UNKNOWN → the probe finds nothing → QUARANTINED NO_DEDUPE_NO_EVIDENCE; never re-sent
//   (c) no probe admitted for the tool's current schema → QUARANTINED PROBE_NOT_ADMITTED (even though this letter WAS sent)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { marker, simAccountOf, type Intent, type Obligation } from "@nt/contracts";
import { openNtDb, type NtDb } from "@nt/db";
import { startTestReplSet, type TestReplSet } from "@nt/db/testing";
import { createGatewayFromEnv, type Gateway } from "@nt/gateway";
import { admitProbe, saveAdmittedProbe, toolSchemaHash, type ProbeCollection, type ToolDescription } from "@nt/recovery/probes";
import { makeCollect } from "../src/collect.ts";
import { investigate } from "../src/investigate.ts";
import type { ReconcilerGateway } from "../src/ports.ts";
import { makeProbeCollect } from "../src/probe-collect.ts";
import { createMongoStore } from "../src/store.ts";
import { SIM_KEYS, SimProcess } from "../../../packages/recovery/test/support/sim-process.ts";
import { NOTIFY_TOOL, goodSpec } from "../../../packages/recovery/test/support/probes.ts";

const RUN = "rprb0801";
let repl: TestReplSet;
let db: NtDb;
let sim: SimProcess;
let runner: Gateway;
let recon: Gateway;

/** The real gateway wiring (createGatewayFromEnv): the notify_letter provider gets the write key; nothing else does. */
function gatewayFor(role: "runner" | "reconciler", workerId: string): Promise<Gateway> {
  return createGatewayFromEnv(
    role,
    {
      NT_MONGODB_URI: repl.uri,
      NT_DB_NAME: repl.dbName,
      NT_SIM_URL: sim.baseUrl,
      NT_SIM_WRITE_KEY: SIM_KEYS.write,
      NT_SIM_READ_KEY: SIM_KEYS.read,
      NT_STRIPE_ENABLED: "false",
      NT_DISPATCH_TIMEOUT_MS: "600",
      NT_LEASE_MS: "8000",
      NT_LETTERS_ENABLED: "true",
    },
    { runId: RUN, workerId },
  );
}

function letterObligation(claim: string, payee: string): Obligation {
  const effect_key = `LETTER.${claim}`;
  return {
    _id: marker(RUN, effect_key),
    run_id: RUN,
    effect_key,
    booking_ref: "ZT4H9X",
    passenger_id: payee.replace("payee_", ""),
    disruption_id: "NT101-20261110",
    entitlement_type: "DECISION_LETTER",
    status: "OWED",
    amount_minor: 0,
    currency: "CAD",
    payee_ref: payee,
    rail: "instant",
    reason_code: null,
    rule_citation: "written decision",
    policy_version: "APPR@test",
    due_by: null,
    claim_ids: [claim],
    decided_at: new Date(),
  };
}

/** Reserve and dispatch a letter through the real gateway; returns the intent as it stands afterwards. */
async function sendLetter(claim: string, payee: string): Promise<Intent> {
  const ob = letterObligation(claim, payee);
  await db.obligations.insertOne(ob);
  const r = await runner.propose({ run_id: RUN, effect_key: ob.effect_key, amount_minor: 0, currency: "CAD", payee_ref: payee, claim_ids: [claim], proposed_by: { kind: "orchestrator", id: "test" } });
  if (r.kind !== "RESERVED") throw new Error(`propose: ${r.kind}`);
  expect(r.intent.provider).toBe("notify_letter");
  expect(r.intent.idempotency_key).toBeNull(); // keyless
  return runner.dispatch(r.intent._id, "runner-test");
}

async function reconcile(it0: Intent, tool: ToolDescription): Promise<Intent> {
  const it = await recon.acquireLease(it0._id, it0.lease_epoch);
  if (!it) throw new Error("lease not acquired");
  const letters = makeProbeCollect({ probes: db.probes as unknown as ProbeCollection, tool, baseUrl: sim.baseUrl, readKey: SIM_KEYS.read });
  const gw = recon as unknown as ReconcilerGateway;
  const collect = makeCollect({ gateway: { readOnlyProviderView: () => { throw new Error("letters have no read view"); } }, mode: "deterministic", timeoutMs: 5000, letters });
  await investigate({ workerId: "reconciler-test", gateway: gw, store: createMongoStore({ gw: db, inv: db, runId: RUN }), collect, barrier: () => {} }, it);
  return (await db.intents.findOne({ _id: it._id }))!;
}

async function messagesFor(m: string): Promise<unknown[]> {
  const r = await fetch(`${sim.baseUrl}/v1/messages?account=${simAccountOf(RUN)}&limit=20`, { headers: { Authorization: `Bearer ${SIM_KEYS.read}` } });
  return ((await r.json()) as { data: { metadata: { nt_marker?: string } }[] }).data.filter((x) => x.metadata.nt_marker === m);
}

async function postsFor(): Promise<number> {
  const log = (await sim.admin<{ data: { method: string; path: string }[] }>("GET", `/admin/request-log?account=${simAccountOf(RUN)}`)).json.data;
  return log.filter((l) => l.method === "POST" && l.path === "/v1/messages").length;
}

beforeAll(async () => {
  repl = await startTestReplSet();
  db = await openNtDb({ uri: repl.uri, dbName: repl.dbName });
  sim = await SimProcess.start();
  const acct = await sim.admin("POST", "/admin/accounts", { account: simAccountOf(RUN), search_lag_ms: 5000 });
  if (acct.status !== 201) throw new Error("sim account");
  await sim.faults(simAccountOf(RUN), [
    { match: { marker: marker(RUN, "LETTER.C02") }, fault: "DROP_RESPONSE_AFTER_APPLY" },
    { match: { marker: marker(RUN, "LETTER.C03") }, fault: "DROP_REQUEST" },
    { match: { marker: marker(RUN, "LETTER.C04") }, fault: "DROP_RESPONSE_AFTER_APPLY" },
  ]);
  runner = await gatewayFor("runner", "runner-test");
  recon = await gatewayFor("reconciler", "reconciler-test");
  // The probe is admitted by the fixed admission code against the simulator (scratch accounts), then stored as {tool_id}:{schema_hash}.
  const spec = goodSpec();
  const v = await admitProbe(spec, { tool: NOTIFY_TOOL, allowedOrigins: [new URL(sim.baseUrl).origin] }, { baseUrl: sim.baseUrl, readKey: SIM_KEYS.read, adminKey: SIM_KEYS.admin, accountPrefix: "prb08" });
  if (!v.admitted) throw new Error(`setup: probe not admitted: ${v.reason}`);
  await saveAdmittedProbe(db.probes as unknown as ProbeCollection, spec, v);
}, 120_000);

afterAll(async () => {
  await runner?.deps.db.close();
  await recon?.deps.db.close();
  await sim?.stop();
  await db?.close();
  await repl?.stop();
});

describe("PRB-08 admitted probe feeds the fixed matcher for decision letters", () => {
  it("(a) response lost after the letter was sent: OUTCOME_UNKNOWN → probe finds it → CONFIRMED, evidence source PROBE, one message", async () => {
    const it0 = await sendLetter("C02", "payee_P02");
    expect(it0.state).toBe("OUTCOME_UNKNOWN");
    const it = await reconcile(it0, NOTIFY_TOOL);
    expect(it.state).toBe("CONFIRMED");
    expect(it.evidence).toMatchObject({ source: "PROBE", status: "sent", amount_minor: 0, payee_ref: "payee_P02", marker: it._id });
    expect(await messagesFor(it._id)).toHaveLength(1);
    const rec = await db.investigations.findOne({ intent_id: it._id });
    expect(rec?.match).toBe("MATCH");
  });

  it("(b) request dropped (the letter never arrived): probe finds nothing → QUARANTINED NO_DEDUPE_NO_EVIDENCE; never re-sent", async () => {
    const before = await postsFor();
    const it0 = await sendLetter("C03", "payee_P03");
    expect(it0.state).toBe("OUTCOME_UNKNOWN");
    const it = await reconcile(it0, NOTIFY_TOOL);
    expect(it.state).toBe("QUARANTINED");
    expect(it.quarantine?.reason).toBe("NO_DEDUPE_NO_EVIDENCE");
    expect(it.attempts).toHaveLength(1); // no licence, no second send
    expect(await messagesFor(it._id)).toHaveLength(0);
    expect((await postsFor()) - before).toBe(1);
  });

  it("(c) no probe admitted for the tool's current schema: QUARANTINED PROBE_NOT_ADMITTED, even though this letter was sent", async () => {
    const changed: ToolDescription = structuredClone(NOTIFY_TOOL);
    changed.object_schema.channel = "string"; // the tool's schema changed since admission
    expect(toolSchemaHash(changed)).not.toBe(toolSchemaHash(NOTIFY_TOOL));
    const it0 = await sendLetter("C04", "payee_P04");
    expect(it0.state).toBe("OUTCOME_UNKNOWN");
    const it = await reconcile(it0, changed);
    expect(it.state).toBe("QUARANTINED");
    expect(it.quarantine?.reason).toBe("PROBE_NOT_ADMITTED");
    expect(await messagesFor(it._id)).toHaveLength(1); // it was sent; without an admitted probe the system refuses to guess
    expect(it.attempts).toHaveLength(1);
  });

  it("a letter whose response arrives is CONFIRMED directly from the response (T3) through the same matcher", async () => {
    const it = await sendLetter("C05", "payee_P05");
    expect(it.state).toBe("CONFIRMED");
    expect(it.evidence).toMatchObject({ source: "RESPONSE", status: "sent", amount_minor: 0 });
  });
});
