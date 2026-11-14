// Test support for the desk API: seeded example documents (P02 Daniel Whitlock, booking ZT4H9X, 700.00 CAD), a stub simulator,
// and a collection wrapper that records every collection method the API calls.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ObjectId } from "mongodb";
import { sha256Hex } from "@nt/contracts";
import type { NtDb } from "@nt/db";
import type { DeskCollections } from "../src/read-model.ts";
import { READ_ONLY_METHODS } from "../src/read-model.ts";

export const GROUP = "g4x8p2nd";
export const NT = "r7k2m9qa";
export const CONTROL = "r3c9v5tb";
export const READ_KEY = "test-read-key-not-a-secret";
export const P02 = "ZT4H9X.P02.NT101-20261110.APPR_DELAY";
export const P13 = "KS2R9B.P13.NT880-20261110.APPR_DELAY";
export const P11 = "PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING";
export const POLICY = "APPR-SOR-2019-150@2022-09-08";
const T0 = new Date("2026-11-14T18:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

export const finalReport = (run: string, arm: string) => ({
  run_id: run,
  group_id: GROUP,
  arm,
  scenario: "S0",
  generated_at: "2026-11-14T18:02:20.511Z",
  complete: true,
  paid: [],
  refused: [],
  parked: [],
  awaiting_budget: [{ effect_key: "RW6N1K.P06.NT101-20261110.GOODWILL", amount_minor: 15000 }],
  failed_no_effect: [],
  unresolved: [],
});

const frozen = (run: string, key: string, provider: string, rail: string | null, amount: number, payee: string) => ({
  provider,
  operation: "PAYOUT",
  account: `acct_${run}`,
  rail,
  amount_minor: amount,
  currency: "CAD",
  payee_ref: payee,
  parent_ref: null,
  metadata: { nt_marker: `${run}:${key}`, nt_effect_key: key, nt_run_id: run, nt_type: key.split(".")[3]! },
});

function intent(key: string, state: string, extra: Record<string, unknown> = {}) {
  const type = key.split(".")[3]!;
  const pax = key.split(".")[1]!;
  const amount = type === "APPR_DENIED_BOARDING" ? 90000 : 70000;
  const provider = type === "APPR_DENIED_BOARDING" ? "sim_keyless" : "sim_payout";
  const fr = frozen(NT, key, provider, provider === "sim_keyless" ? "legacy" : "instant", amount, `payee_${pax}`);
  return {
    _id: `${NT}:${key}`,
    run_id: NT,
    effect_key: key,
    obligation_id: `${NT}:${key}`,
    entitlement_type: type,
    amount_minor: amount,
    currency: "CAD",
    payee_ref: `payee_${pax}`,
    provider,
    idempotency_key: provider === "sim_payout" ? `${NT}:${key}` : null,
    frozen_request: fr,
    frozen_request_sha256: sha256Hex(JSON.stringify(fr)),
    draws_on: null,
    state,
    lease: null,
    lease_epoch: 3,
    first_dispatch_at: at(7),
    last_send_at: at(7),
    key_expires_at: null,
    next_attempt_at: null,
    attempts: [
      { n: 1, at: at(7), licence: "FIRST_SEND", request_sha256: "b".repeat(64), epoch: 1, result: { kind: "LEASE_EXPIRED", cause: null, code: null, replayed: null, provider_object_id: null } },
    ],
    evidence: null,
    rejection: null,
    quarantine: null,
    policy_version: POLICY,
    rule_citation: type === "APPR_DENIED_BOARDING" ? "s. 20(1)" : "s. 19(1)(a)(ii)",
    created_at: at(5),
    updated_at: at(100),
    ...extra,
  };
}

const obligation = (key: string, claims: string[], extra: Record<string, unknown> = {}) => {
  const type = key.split(".")[3]!;
  const pax = key.split(".")[1]!;
  return {
    _id: `${NT}:${key}`,
    run_id: NT,
    effect_key: key,
    booking_ref: key.split(".")[0]!,
    passenger_id: pax,
    disruption_id: key.split(".")[2]!,
    entitlement_type: type,
    status: "OWED",
    amount_minor: type === "APPR_DENIED_BOARDING" ? 90000 : 70000,
    currency: "CAD",
    payee_ref: `payee_${pax}`,
    rail: type === "APPR_DENIED_BOARDING" ? "legacy" : "instant",
    reason_code: null,
    rule_citation: type === "APPR_DENIED_BOARDING" ? "s. 20(1)" : "s. 19(1)(a)(ii)",
    policy_version: POLICY,
    claim_ids: claims,
    decided_at: at(2),
    due_by: new Date("2026-12-11T14:05:00Z"),
    ...extra,
  };
};

const claim = (run: string, id: string, extra: Record<string, unknown> = {}) => ({
  _id: `${run}:${id}`,
  run_id: run,
  claim_id: id,
  channel: id === "C03" ? "agency-letter" : "email",
  received_at: new Date(id === "C03" ? "2026-11-11T15:00:00Z" : "2026-11-11T14:05:00Z"),
  raw_text: `Subject: NT101 cancelled\n\nMy name is Daniel Whitlock. (${id})`,
  status: "RESOLVED",
  hold_reason: null,
  extraction: {
    claimant_names: ["Daniel Whitlock"], booking_refs: [], flight_numbers: ["NT101"], travel_date: "2026-11-10",
    passengers_claimed_for: [{ name: "Daniel Whitlock", relation: null }], asserted_delay: "over nine hours", asserted_cause: "weather",
    requested_amount: "1,000", payee_change_request: { requested: false, quote: null }, hardship: { kind: "NONE", quote: null },
    injection_suspected: false, language: "en", notes: "",
  },
  extraction_meta: { model: "test-model", prompt_version: "intake@1", mode: "replay", request_sha256: "9f2c", attempts: 1 },
  resolution: { booking_ref: "ZT4H9X", passenger_ids: ["P02"], method: "NAME_FLIGHT_DATE", similarity: 1 },
  flags: { payeeChangeRequested: false, goodwillProposed: null },
  effect_keys: [P02],
  embedding: null,
  created_at: at(1),
  updated_at: at(1),
  ...extra,
});

const booking = {
  _id: `${NT}:ZT4H9X:P02`,
  run_id: NT,
  booking_ref: "ZT4H9X",
  passenger_id: "P02",
  carrier_code: "NT",
  carrier_size: "LARGE",
  flight_no: "NT101",
  ticket_price_minor: null,
  ticket_payment_ref: null,
  passenger: {
    passenger_id: "P02", name: "Daniel Whitlock", is_minor: false, arrival_delay_minutes: 532, payee_ref: "payee_P02", payout_rail: "instant",
    hardship_flags: [], refund_elected: false, other_regime_compensation: null, alternative_accepted_in_writing: null, denied_boarding: false,
  },
  disruption: {
    disruption_id: "NT101-20261110", flight_no: "NT101", scheduled_departure: new Date("2026-11-10T13:15:00Z"), kind: "CANCELLATION",
    cause_code: "CREW_SCHED", control_class: "WITHIN_CONTROL", notice_minutes_before_departure: 50,
  },
};

export const auditIds = {
  decided: new ObjectId("69176d43a1b2c3d4e5f60701"),
  reserved: new ObjectId("69176d43a1b2c3d4e5f60702"),
  t2: new ObjectId("69176d43a1b2c3d4e5f60703"),
  t6: new ObjectId("69176d43a1b2c3d4e5f60704"),
  other: new ObjectId("69176d43a1b2c3d4e5f60705"),
};
const ev = (_id: ObjectId, type: string, extra: Record<string, unknown>) => ({
  _id, run_id: NT, at: at(10), actor: { kind: "gateway", id: "g-1" }, type, intent_id: null, effect_key: null, claim_id: null,
  from_state: null, to_state: null, rule_citation: null, policy_version: null, detail: {}, ...extra,
});

/** Owner-role seed of every collection the desk API reads. */
export async function seed(db: NtDb): Promise<void> {
  const run = (id: string, arm: string, extra: Record<string, unknown> = {}) => ({
    _id: id, group_id: GROUP, arm, scenario: "S0", seed: 1, fault_schedule: "F-DEMO", sim_account: `acct_${id}`, status: "ENDED",
    started_at: at(0), ended_at: at(200), final_report: null, ...extra,
  });
  await db.db.collection("execution_runs").insertMany([
    run(NT, "nt", { final_report: finalReport(NT, "nt") }),
    run(CONTROL, "control", { final_report: finalReport(CONTROL, "control") }),
    run("r5h1w8ze", "nt_mutant", { status: "RUNNING" }),
  ] as never);
  await db.db.collection("bookings").insertOne(booking as never);
  await db.db.collection("claims").insertMany([
    claim(NT, "C02"),
    claim(NT, "C03"),
    claim(NT, "C09", { status: "HELD", hold_reason: "BOOKING_UNRESOLVED", resolution: null, effect_keys: [] }),
    // the control arm's own bookkeeping, `baseline` sub-document (AGENT_TASKS E5)
    claim(CONTROL, "C02", {
      baseline: {
        done: true,
        payments: [
          { effect_key: P02, amount_minor: 70000, currency: "CAD", payee_ref: "payee_P02", provider: "sim_payout", provider_object_id: "po_6a02f9d3c8b1e475", idempotency_key: "ctl_e07c53d1b96a", at: "2026-11-14T18:00:41.940Z", result: "provider answered 201" },
        ],
      },
      updated_at: at(41),
    }),
    claim(CONTROL, "C05", {
      effect_keys: [P13],
      baseline: { done: true, payments: [{ effect_key: P13, amount_minor: 70000, currency: "CAD", payee_ref: "payee_P13", provider: "sim_payout", provider_object_id: "po_2c8e51b7a940d36f", result: "provider answered 201" }] },
    }),
  ] as never);
  await db.db.collection("obligations").insertMany([
    obligation(P02, ["C02", "C03"]),
    obligation(P11, ["C07"]),
    obligation(P13, ["C05"]),
    obligation("RW6N1K.P06.NT101-20261110.GOODWILL", ["C08"], { status: "HELD", reason_code: "UNVERIFIED_HARDSHIP", amount_minor: 0, rail: "instant" }),
  ] as never);
  await db.db.collection("payment_intents").insertMany([
    intent(P02, "CONFIRMED", {
      evidence: { source: "PROBE", provider_object_id: "po_3f9a1c07e2b84d55", status: "paid", amount_minor: 70000, currency: "CAD", payee_ref: "payee_P02", marker: `${NT}:${P02}`, retrieved_at: at(104) },
    }),
    intent(P11, "QUARANTINED", { created_at: at(3), quarantine: { reason: "NO_DEDUPE_NO_EVIDENCE", detail: "keyless rail, nothing found", at: at(90) } }),
    intent(P13, "OUTCOME_UNKNOWN", { created_at: at(4) }),
  ] as never);
  await db.db.collection("authority_grants").insertOne({
    _id: `${NT}:GOODWILL`, run_id: NT, kind: "GOODWILL_POOL", grant_minor: 50000, held_minor: 0, settled_minor: 50000, frozen: false, currency: "CAD", policy_version: "NT-GOODWILL@1",
  } as never);
  await db.db.collection("audit_events").insertMany([
    ev(auditIds.decided, "OBLIGATION_DECIDED", { effect_key: P02, actor: { kind: "orchestrator", id: "runner-1" } }),
    ev(auditIds.reserved, "INTENT_RESERVED", { intent_id: `${NT}:${P02}`, effect_key: P02, to_state: "RESERVED" }),
    ev(auditIds.t2, "TRANSITION", { intent_id: `${NT}:${P02}`, effect_key: P02, from_state: "RESERVED", to_state: "DISPATCHING", detail: { transition: "T2", epoch: 1 } }),
    ev(auditIds.t6, "TRANSITION", { intent_id: `${NT}:${P02}`, effect_key: P02, from_state: "OUTCOME_UNKNOWN", to_state: "CONFIRMED", actor: { kind: "reconciler", id: "reconciler-1" }, detail: { transition: "T6", epoch: 3 } }),
    ev(auditIds.other, "TRANSITION", { intent_id: `${NT}:${P13}`, effect_key: P13, from_state: "DISPATCHING", to_state: "OUTCOME_UNKNOWN", detail: { transition: "T5" } }),
  ] as never);
  await db.db.collection("investigation_records").insertOne({
    _id: new ObjectId("69176d41a1b2c3d4e5f60712"), run_id: NT, intent_id: `${NT}:${P02}`, epoch: 3, investigator: "llm", hypothesis: "response lost after apply",
    steps: [{ tool: "get_intent_summary", input: {}, summary: "instant rail, 700.00 CAD", record_count: 0 }],
    records: [], match: "MATCH", decision: { kind: "SETTLE", row: 2 }, licence: null, opened_at: at(101), closed_at: at(104),
    embedding: [0.1, 0.2, 0.3], recalled: [],
  } as never);
}

// ---- stub simulator -------------------------------------------------------------------------------------------------
const obj = (id: string, key: string | null, amount: number, status: string, created: string) => ({
  id, kind: "payout", status, amount_minor: amount, currency: "CAD", payee_ref: "payee_x", parent_ref: null, created_at: created,
  metadata: key ? { nt_marker: `${CONTROL}:${key}`, nt_effect_key: key, nt_run_id: CONTROL, nt_type: "APPR_DELAY" } : {},
});
export const STUB_OBJECTS = [
  obj("po_6a02f9d3c8b1e475", P02, 70000, "paid", "2026-11-14T18:00:07.401Z"),
  obj("po_91d7e4a20c5b3f68", P02, 70000, "paid", "2026-11-14T18:00:41.977Z"),
  obj("po_2c8e51b7a940d36f", P13, 70000, "paid", "2026-11-14T18:00:06.720Z"),
  obj("po_aaaa00000000aaaa", P11, 90000, "failed", "2026-11-14T18:00:08.000Z"),
  obj("po_stray0000000001", null, 1000, "paid", "2026-11-14T18:00:09.000Z"),
];

export type StubSim = { url: string; requests: { path: string; auth: string | undefined }[]; close(): Promise<void> };
/** A simulator that serves GET /v1/payouts in pages of two objects for acct_<CONTROL>, only to the read key. */
export async function startStubSim(): Promise<StubSim> {
  const requests: StubSim["requests"] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://stub");
    requests.push({ path: `${u.pathname}${u.search}`, auth: req.headers.authorization });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${READ_KEY}`) return send(401, { error: "unauthorized" });
    if (req.method !== "GET" || u.pathname !== "/v1/payouts") return send(404, { error: "not_found" });
    if (u.searchParams.get("account") !== `acct_${CONTROL}`) return send(404, { error: "not_found" });
    const after = u.searchParams.get("starting_after");
    const start = after ? STUB_OBJECTS.findIndex((o) => o.id === after) + 1 : 0;
    const page = STUB_OBJECTS.slice(start, start + 2);
    const hasMore = start + 2 < STUB_OBJECTS.length;
    send(200, { data: page, has_more: hasMore, next_cursor: hasMore ? page[page.length - 1]!.id : null });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

// ---- read-only wrapper -----------------------------------------------------------------------------------------------
export type Spy = { reads: string[]; violations: string[] };
/** Wraps every collection of `db` so that any call other than find / findOne / countDocuments is recorded and refused. */
export function spyOn(db: NtDb): { cols: DeskCollections; spy: Spy } {
  const spy: Spy = { reads: [], violations: [] };
  const allowed = new Set<string>(READ_ONLY_METHODS);
  const wrap = (name: string) =>
    new Proxy(db.db.collection(name), {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (typeof v !== "function" || typeof prop !== "string") return v;
        if (allowed.has(prop)) {
          return (...args: unknown[]) => {
            spy.reads.push(`${name}.${prop}`);
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return () => {
          spy.violations.push(`${name}.${prop}`);
          throw new Error(`write path used: ${name}.${prop}`);
        };
      },
    });
  const cols = {
    bookings: wrap("bookings"), claims: wrap("claims"), obligations: wrap("obligations"), intents: wrap("payment_intents"),
    grants: wrap("authority_grants"), audit: wrap("audit_events"), runs: wrap("execution_runs"), investigations: wrap("investigation_records"),
  } as unknown as DeskCollections;
  return { cols, spy };
}
