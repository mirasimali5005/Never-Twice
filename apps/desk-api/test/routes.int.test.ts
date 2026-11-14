// G1 integration: every section 9 endpoint against the in-memory replica set (@nt/db/testing) with seeded example documents
// (P02 Daniel Whitlock, booking ZT4H9X, 700.00 CAD) and a stub simulator. Also: no write operation is issued, and the shapes
// carry the same keys as the UI's mock files (apps/desk-ui/src/mocks).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { openNtDb, type NtDb } from "@nt/db";
import { startTestReplSet, type TestReplSet } from "@nt/db/testing";
import { createApp } from "../src/routes.ts";
import { CONTROL, GROUP, NT, P02, P11, P13, READ_KEY, STUB_OBJECTS, seed, spyOn, startStubSim, type Spy, type StubSim } from "./support.ts";

let rs: TestReplSet;
let owner: NtDb;
let sim: StubSim;
let out: string;
let app: Hono;
let spy: Spy;

const MOCKS = path.resolve(import.meta.dirname, "../../desk-ui/src/mocks");
const mock = async (name: string): Promise<unknown> => JSON.parse(await readFile(path.join(MOCKS, name), "utf8"));
const keys = (v: unknown): string[] => Object.keys(v as object).sort();
const get = async (p: string) => {
  const res = await app.request(p);
  return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

beforeAll(async () => {
  rs = await startTestReplSet();
  owner = await openNtDb({ uri: rs.uri, dbName: rs.dbName });
  await seed(owner);
  sim = await startStubSim();
  out = await mkdtemp(path.join(os.tmpdir(), "nt-desk-out-"));
  await writeFile(path.join(out, `${GROUP}.commitment.json`), JSON.stringify({ group_id: GROUP, sha256: "7c1e5a09".padEnd(64, "0"), committed_at: "2026-11-14T17:57:40.118Z" }));
  await writeFile(path.join(out, `${NT}.certificate.json`), `{"certificate_version":1,"run_id":"${NT}","safety":"PASS"}`);
  const s = spyOn(owner);
  spy = s.spy;
  app = createApp({ cols: s.cols, sim: { url: sim.url, readKey: READ_KEY }, evaluatorOut: out, recorded: false, database: "local", now: () => new Date("2026-11-14T18:02:31.004Z") });
}, 180_000);

afterAll(async () => {
  await sim?.close();
  await owner?.close();
  await rs?.stop();
  if (out) await rm(out, { recursive: true, force: true });
});

describe("GET /api/groups/:group_id", () => {
  it("lists the runs and carries the commitment (addition)", async () => {
    const { status, body } = await get(`/api/groups/${GROUP}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ group_id: GROUP, scenario: "S0", recorded: false, intake_mode: "replay" });
    expect(body.runs.map((r: { run_id: string }) => r.run_id).sort()).toEqual(["r3c9v5tb", "r5h1w8ze", "r7k2m9qa"]);
    expect(keys(body.runs[0])).toEqual(["arm", "audited", "fault_schedule", "run_id", "sim_account", "status"]);
    expect(body.manifest_sha256).toBe("7c1e5a09".padEnd(64, "0"));
    expect(body.manifest_committed_at).toBe("2026-11-14T17:57:40.118Z");
    expect(body.database).toBe("local");
    const audited = Object.fromEntries(body.runs.map((r: { run_id: string; audited: boolean }) => [r.run_id, r.audited]));
    expect(audited).toEqual({ [NT]: true, [CONTROL]: false, r5h1w8ze: false });
    const m = (await mock("group.json")) as object;
    for (const k of keys(m)) expect(Object.keys(body)).toContain(k);
  });
  it("omits the commitment fields when no commitment file exists", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "nt-desk-empty-"));
    try {
      const a = createApp({ ...(await deps()), evaluatorOut: other });
      const body = (await (await a.request(`/api/groups/${GROUP}`)).json()) as Record<string, unknown>;
      expect("manifest_sha256" in body).toBe(false);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
  it("404 UNKNOWN_GROUP for an unknown or malformed id", async () => {
    expect(await get("/api/groups/g0000000")).toMatchObject({ status: 404, body: { error: "UNKNOWN_GROUP" } });
    expect(await get("/api/groups/..%2F..%2Fetc")).toMatchObject({ status: 404, body: { error: "UNKNOWN_GROUP" } });
  });
});

async function deps() {
  const s = spyOn(owner);
  return { cols: s.cols, sim: { url: sim.url, readKey: READ_KEY }, evaluatorOut: out, recorded: false };
}

describe("GET /api/runs/:run_id/summary", () => {
  it("counts intents by state and the three colours, and reads `complete` from the final report", async () => {
    const { status, body } = await get(`/api/runs/${NT}/summary`);
    expect(status).toBe(200);
    expect(body.intents_by_state).toEqual({ RESERVED: 0, DISPATCHING: 0, OUTCOME_UNKNOWN: 1, CONFIRMED: 1, FAILED_NO_EFFECT: 0, QUARANTINED: 1, RELEASED: 0 });
    // needs a person = 1 quarantined + 1 held obligation + 1 held claim
    expect(body.colours).toEqual({ in_doubt: 1, confirmed: 1, needs_person: 3 });
    expect(body.complete).toBe(true);
    expect(body.report_generated_at).toBe("2026-11-14T18:02:20.511Z");
    expect(keys(body)).toEqual(keys(await mock("summary.nt.json")));
  });
  it("complete is null until a final report exists", async () => {
    const { body } = await get("/api/runs/r5h1w8ze/summary");
    expect(body).toMatchObject({ arm: "nt_mutant", status: "RUNNING", complete: null, report_generated_at: null });
  });
  it("404 UNKNOWN_RUN for unknown and malformed ids", async () => {
    expect(await get("/api/runs/r0000000/summary")).toMatchObject({ status: 404, body: { error: "UNKNOWN_RUN" } });
    expect(await get("/api/runs/not-a-run/summary")).toMatchObject({ status: 404, body: { error: "UNKNOWN_RUN" } });
  });
});

describe("claims", () => {
  it("lists claims with effect keys", async () => {
    const { status, body } = await get(`/api/runs/${NT}/claims`);
    expect(status).toBe(200);
    expect(body.map((c: { claim_id: string }) => c.claim_id)).toEqual(["C02", "C09", "C03"]); // received_at order, then claim_id
    expect(body[0]).toMatchObject({ claim_id: "C02", channel: "email", status: "RESOLVED", hold_reason: null, effect_keys: [P02] });
    expect(body[1]).toMatchObject({ status: "HELD", hold_reason: "BOOKING_UNRESOLVED" });
    expect(keys(body[0])).toEqual(keys(((await mock("claims.nt.json")) as object[])[0]));
  });
  it("one case file: raw text, record facts, obligations and the merged duplicate", async () => {
    const { status, body } = await get(`/api/runs/${NT}/claims/C02`);
    expect(status).toBe(200);
    expect(body.raw_text).toContain("Daniel Whitlock");
    expect(body.resolution).toEqual({ booking_ref: "ZT4H9X", passenger_ids: ["P02"], method: "NAME_FLIGHT_DATE", similarity: 1 });
    expect(body.extraction_meta).toEqual({ mode: "replay", prompt_version: "intake@1", attempts: 1 }); // no model name, no request hash
    expect(body.record_facts).toEqual([{ flight_no: "NT101", cause_code: "CREW_SCHED", control_class: "WITHIN_CONTROL", arrival_delay_minutes: 532 }]);
    expect(body.obligations).toHaveLength(1);
    expect(body.obligations[0]).toMatchObject({ effect_key: P02, status: "OWED", amount_minor: 70000, currency: "CAD", rule_citation: "s. 19(1)(a)(ii)", policy_version: "APPR-SOR-2019-150@2022-09-08", claim_ids: ["C02", "C03"], due_by: "2026-12-11T14:05:00.000Z" });
    expect(body.merged_claims).toEqual(["C03"]);
    expect(keys(body)).toEqual(keys(await mock("claim.nt.S1.json")));
    expect(keys(body.obligations[0])).toEqual(keys(((await mock("claim.nt.S1.json")) as { obligations: object[] }).obligations[0]));
    // the agency letter sees the same obligation, merged the other way
    expect((await get(`/api/runs/${NT}/claims/C03`)).body.merged_claims).toEqual(["C02"]);
  });
  it("404 UNKNOWN_CLAIM", async () => {
    expect(await get(`/api/runs/${NT}/claims/C99`)).toMatchObject({ status: 404, body: { error: "UNKNOWN_CLAIM" } });
    expect(await get(`/api/runs/${NT}/claims/a%20b`)).toMatchObject({ status: 404, body: { error: "UNKNOWN_CLAIM" } });
  });
});

describe("payments", () => {
  it("compact rows for the Never Twice arm, with colour and quarantine reason", async () => {
    const { status, body } = await get(`/api/runs/${NT}/payments`);
    expect(status).toBe(200);
    const by = Object.fromEntries(body.map((r: { effect_key: string }) => [r.effect_key, r]));
    expect(by[P02]).toEqual({ effect_key: P02, passenger_id: "P02", entitlement_type: "APPR_DELAY", amount_minor: 70000, rail: "instant", provider: "sim_payout", state: "CONFIRMED", colour: "confirmed", quarantine_reason: null, source: "nt" });
    expect(by[P11]).toMatchObject({ state: "QUARANTINED", colour: "needs_person", quarantine_reason: "NO_DEDUPE_NO_EVIDENCE", rail: "legacy", provider: "sim_keyless" });
    expect(by[P13]).toMatchObject({ state: "OUTCOME_UNKNOWN", colour: "in_doubt" });
    expect(keys(body[0])).toEqual(keys(((await mock("payments.nt.json")) as object[])[0]));
  });
  it("baseline rows for the control arm come from claims.baseline: source baseline, state null", async () => {
    const { body } = await get(`/api/runs/${CONTROL}/payments`);
    expect(body.map((r: { effect_key: string }) => r.effect_key).sort()).toEqual([P13, P02].sort());
    expect(body[0]).toMatchObject({ source: "baseline", state: null, colour: null, quarantine_reason: null });
    expect(keys(body[0])).toEqual(keys(((await mock("payments.control.json")) as object[])[0]));
  });
  it("the evidence trail: whole intent, obligation, investigations (no embedding) and the audit trail in _id order", async () => {
    const { status, body } = await get(`/api/runs/${NT}/payments/${P02}`);
    expect(status).toBe(200);
    expect(keys(body)).toEqual(["audit", "intent", "investigations", "obligation"]);
    expect(body.intent).toMatchObject({ _id: `${NT}:${P02}`, state: "CONFIRMED", lease_epoch: 3 });
    expect(body.intent.frozen_request.metadata.nt_effect_key).toBe(P02);
    expect(body.intent.evidence.provider_object_id).toBe("po_3f9a1c07e2b84d55");
    expect(body.obligation).toMatchObject({ amount_minor: 70000, claim_ids: ["C02", "C03"] });
    expect(body.investigations).toHaveLength(1);
    expect(body.investigations[0]).toMatchObject({ epoch: 3, match: "MATCH", decision: { kind: "SETTLE", row: 2 } });
    expect("embedding" in body.investigations[0]).toBe(false);
    // intent events plus the obligation's OBLIGATION_DECIDED, in _id order; the P13 event is not here
    expect(body.audit.map((e: { type: string }) => e.type)).toEqual(["OBLIGATION_DECIDED", "INTENT_RESERVED", "TRANSITION", "TRANSITION"]);
    expect(body.audit.map((e: { _id: string }) => e._id)).toEqual([...body.audit.map((e: { _id: string }) => e._id)].sort());
    expect(body.audit[3]).toMatchObject({ from_state: "OUTCOME_UNKNOWN", to_state: "CONFIRMED", detail: { transition: "T6" } });
    const m = (await mock("payment.nt.ZT4H9X.P02.NT101-20261110.APPR_DELAY.CONFIRMED.json")) as { intent: object };
    for (const k of ["_id", "state", "amount_minor", "payee_ref", "provider", "lease", "lease_epoch", "attempts", "evidence"]) expect(Object.keys(body.intent)).toContain(k);
    expect(keys(m)).toContain("intent");
  });
  it("404 UNKNOWN_PAYMENT", async () => {
    expect(await get(`/api/runs/${NT}/payments/ZZZZZZ.P99.NT101-20261110.APPR_DELAY`)).toMatchObject({ status: 404, body: { error: "UNKNOWN_PAYMENT" } });
    expect(await get(`/api/runs/${NT}/payments/lower.case`)).toMatchObject({ status: 404, body: { error: "UNKNOWN_PAYMENT" } });
    expect(await get(`/api/runs/${CONTROL}/payments/ZZZZZZ.P99.NT101-20261110.APPR_DELAY`)).toMatchObject({ status: 404, body: { error: "UNKNOWN_PAYMENT" } });
  });
  it("BaselineTrail (addition): the control arm's own record, plus the payment the provider holds that it does not show", async () => {
    const { status, body } = await get(`/api/runs/${CONTROL}/payments/${P02}`);
    expect(status).toBe(200);
    expect(keys(body)).toEqual(keys(await mock("payment.control.ZT4H9X.P02.NT101-20261110.APPR_DELAY.MARKED_DONE.json")));
    expect(body).toMatchObject({ source: "baseline", effect_key: P02, passenger_id: "P02", entitlement_type: "APPR_DELAY", amount_minor: 70000, currency: "CAD", payee_ref: "payee_P02", marked_done: true, note: "a 2xx is treated as paid" });
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts.map((a: { n: number }) => a.n)).toEqual([1, 2]);
    expect(keys(body.attempts[0])).toEqual(["at", "idempotency_key", "n", "result"]);
    expect(body.attempts.some((a: { idempotency_key: string }) => a.idempotency_key === "ctl_e07c53d1b96a")).toBe(true);
    expect(body.attempts.some((a: { result: string }) => a.result.includes("po_91d7e4a20c5b3f68"))).toBe(true);
  });
});

describe("GET /api/runs/:run_id/provider-statement", () => {
  it("reads every page with the read key, groups by nt_effect_key and counts paid twice", async () => {
    sim.requests.length = 0;
    const { status, body } = await get(`/api/runs/${CONTROL}/provider-statement`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ run_id: CONTROL, account: `acct_${CONTROL}`, read_at: "2026-11-14T18:02:31.004Z", complete: true, paid_twice: 1 });
    const p02 = body.entitlements.find((e: { effect_key: string }) => e.effect_key === P02);
    expect(p02).toMatchObject({ count: 2, amount_minor_total: 140000 });
    expect(p02.objects.map((o: { id: string }) => o.id)).toEqual(["po_6a02f9d3c8b1e475", "po_91d7e4a20c5b3f68"]);
    expect(keys(p02.objects[0])).toEqual(["amount_minor", "created_at", "id", "status"]);
    // an object in a status that is not accepted is listed but not counted
    expect(body.entitlements.find((e: { effect_key: string }) => e.effect_key === P11)).toMatchObject({ count: 0, amount_minor_total: 0 });
    expect(body.unattributed.map((o: { id: string }) => o.id)).toEqual(["po_stray0000000001"]);
    expect(sim.requests).toHaveLength(Math.ceil(STUB_OBJECTS.length / 2));
    expect(sim.requests.every((r) => r.path.startsWith("/v1/payouts?") && r.auth === `Bearer ${READ_KEY}`)).toBe(true);
    expect(sim.requests.some((r) => r.path.includes("/search"))).toBe(false);
    expect(keys(body)).toEqual(keys(await mock("provider-statement.control.json")));
  });
  it("502 PROVIDER_UNREACHABLE while every other endpoint keeps working", async () => {
    const a = createApp({ ...(await deps()), sim: { url: "http://127.0.0.1:1", readKey: READ_KEY, timeoutMs: 500 } });
    const res = await a.request(`/api/runs/${CONTROL}/provider-statement`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "PROVIDER_UNREACHABLE" });
    expect((await a.request(`/api/runs/${NT}/summary`)).status).toBe(200);
    // the baseline trail still serves from its own records
    const trail = await a.request(`/api/runs/${CONTROL}/payments/${P02}`);
    expect(trail.status).toBe(200);
    expect(((await trail.json()) as { attempts: unknown[] }).attempts).toHaveLength(1);
  });
  it("a wrong read key is 502, never an empty statement", async () => {
    const a = createApp({ ...(await deps()), sim: { url: sim.url, readKey: "wrong" } });
    expect((await a.request(`/api/runs/${CONTROL}/provider-statement`)).status).toBe(502);
  });
});

describe("pool and certificate", () => {
  it("the goodwill pool, with awaiting_budget copied from the final report", async () => {
    const { status, body } = await get(`/api/runs/${NT}/pool`);
    expect(status).toBe(200);
    expect(body).toEqual({ run_id: NT, grant_minor: 50000, held_minor: 0, settled_minor: 50000, frozen: false, currency: "CAD", awaiting_budget: ["RW6N1K.P06.NT101-20261110.GOODWILL"] });
    expect(keys(body)).toEqual(keys(await mock("pool.json")));
  });
  it("404 NO_POOL for a run with no grant document", async () => {
    expect(await get(`/api/runs/${CONTROL}/pool`)).toMatchObject({ status: 404, body: { error: "NO_POOL" } });
  });
  it("the certificate file's own bytes, or 404 NOT_AUDITED", async () => {
    const res = await app.request(`/api/runs/${NT}/certificate`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`{"certificate_version":1,"run_id":"${NT}","safety":"PASS"}`);
    expect(await get(`/api/runs/${CONTROL}/certificate`)).toMatchObject({ status: 404, body: { status: "NOT_AUDITED" } });
  });
});

describe("methods, unknown paths, database errors", () => {
  it("anything but GET is 405 METHOD_NOT_ALLOWED", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app.request(`/api/runs/${NT}/summary`, { method });
      expect(res.status, method).toBe(405);
      expect(await res.json()).toEqual({ error: "METHOD_NOT_ALLOWED" });
    }
    expect((await app.request("/api/anything", { method: "POST" })).status).toBe(405);
    expect((await app.request("/api/anything")).status).toBe(404);
  });
  it("CORS allows the UI origin only", async () => {
    const ok = await app.request(`/api/runs/${NT}/summary`, { headers: { origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const no = await app.request(`/api/runs/${NT}/summary`, { headers: { origin: "http://evil.example" } });
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("503 DATABASE_UNAVAILABLE when the database cannot be reached; no driver text leaks", async () => {
    const a = createApp(async () => {
      const e = new Error("connect ECONNREFUSED mongodb://user:secret@host");
      e.name = "MongoServerSelectionError";
      throw e;
    });
    const res = await a.request(`/api/runs/${NT}/summary`);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "DATABASE_UNAVAILABLE" });
    expect(text).not.toContain("secret");
  });
});

describe("provider reversal (Tier 3, CP-REV-1)", () => {
  it("a CONFIRMED payment with a PROVIDER_REVERSAL event: red 'reversed' row and count, and the trail carries the reversal", async () => {
    const { ObjectId } = await import("mongodb");
    const id = new ObjectId();
    await owner.audit.insertOne({
      _id: id, run_id: NT, at: new Date("2026-11-14T18:05:00.000Z"), actor: { kind: "reconciler", id: "reconciler-1" }, type: "PROVIDER_REVERSAL",
      intent_id: `${NT}:${P02}`, effect_key: P02, claim_id: null, from_state: null, to_state: null, rule_citation: null, policy_version: null,
      detail: { reason: "PROVIDER_REVERSAL", provider_object_id: "po_x", status_now: "reversed" },
    });
    try {
      const rows = (await get(`/api/runs/${NT}/payments`)).body;
      expect(rows.find((r: { effect_key: string }) => r.effect_key === P02)).toMatchObject({ state: "CONFIRMED", colour: "reversed", reversed_at_provider: true });
      expect((await get(`/api/runs/${NT}/summary`)).body.colours).toEqual({ in_doubt: 1, confirmed: 0, needs_person: 4, reversed: 1 });
      const trail = (await get(`/api/runs/${NT}/payments/${P02}`)).body;
      expect(trail.reversal).toMatchObject({ status_now: "reversed", provider_object_id: "po_x" });
    } finally {
      await owner.audit.deleteOne({ _id: id });
    }
  });
});

describe("read only", () => {
  it("issued no write operation: only find / findOne / countDocuments reached the collections", () => {
    expect(spy.violations).toEqual([]);
    expect(spy.reads.length).toBeGreaterThan(20);
    expect(new Set(spy.reads.map((r) => r.split(".")[1]))).toEqual(new Set(["find", "findOne", "countDocuments"]));
  });
  it("left the database unchanged", async () => {
    const counts = Object.fromEntries(await Promise.all(["claims", "obligations", "payment_intents", "audit_events", "execution_runs", "authority_grants"].map(async (n) => [n, await owner.db.collection(n).countDocuments()])));
    expect(counts).toEqual({ claims: 5, obligations: 4, payment_intents: 3, audit_events: 5, execution_runs: 3, authority_grants: 1 });
  });
});
