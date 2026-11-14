// D2 store against a real replica set (@nt/db/testing): the four candidate scans on the database clock, the drained count,
// the recovery guards, and investigation_records + EVIDENCE_RECORDED. No gateway needed: the store never writes an intent.
import { afterAll, beforeAll, describe, expect, it as test } from "vitest";
import type { Intent } from "@nt/contracts";
import { dbNow, openNtDb, type NtDb } from "@nt/db";
import { startTestReplSet, type TestReplSet } from "@nt/db/testing";
import type { Document } from "mongodb";
import { createMongoStore } from "../src/store.ts";
import { RUN, intent, obj } from "./support/fixtures.ts";

let repl: TestReplSet;
let db: NtDb;
let now: Date;
const ago = (ms: number) => new Date(now.getTime() - ms);
const ahead = (ms: number) => new Date(now.getTime() + ms);

beforeAll(async () => {
  repl = await startTestReplSet();
  db = await openNtDb({ uri: repl.uri, dbName: repl.dbName });
  now = await dbNow(db);
  const docs: Intent[] = [
    intent("P01", "sim_payout", { state: "RESERVED", lease_epoch: 0, attempts: [], first_dispatch_at: null, created_at: ago(10_000) }),
    intent("P02", "sim_payout", { state: "RESERVED", lease_epoch: 0, attempts: [], first_dispatch_at: null, created_at: ago(1_000) }),
    intent("P03", "sim_payout", { state: "DISPATCHING", lease: { owner: "runner", expires_at: ago(1) } }),
    intent("P04", "sim_payout", { state: "DISPATCHING", lease: { owner: "runner", expires_at: ahead(60_000) } }),
    intent("P05", "sim_payout", { state: "OUTCOME_UNKNOWN", next_attempt_at: ago(1) }),
    intent("P06", "sim_payout", { state: "OUTCOME_UNKNOWN", next_attempt_at: ahead(60_000) }),
    intent("P07", "sim_payout", { state: "OUTCOME_UNKNOWN", next_attempt_at: ago(1), lease: { owner: "reconciler-x", expires_at: ahead(60_000) } }),
    intent("P08", "sim_keyless", { state: "QUARANTINED", quarantine: { reason: "NO_DEDUPE_NO_EVIDENCE", detail: "", at: now } }),
    intent("P09", "sim_payout", { state: "QUARANTINED", quarantine: { reason: "CONTRADICTORY_EVIDENCE", detail: "", at: now } }),
    intent("P10", "sim_payout", { state: "CONFIRMED" }),
  ];
  await db.intents.insertMany(docs);
  await db.obligations.insertOne({ _id: docs[4]!.obligation_id, run_id: RUN, status: "HELD", reason_code: "PAYEE_CHANGE_REQUESTED" } as Document as never);
  await db.grants.insertOne({ _id: `${RUN}:GOODWILL`, run_id: RUN, frozen: true } as Document as never);
});

afterAll(async () => {
  await db?.close();
  await repl?.stop();
});

const ids = (xs: Intent[]) => xs.map((x) => x.effect_key.split(".")[1]);

describe("D2 store (replica set)", () => {
  test("scans select candidates on the database clock", async () => {
    const s = createMongoStore({ gw: db, inv: db, runId: RUN });
    expect(ids(await s.orphans(RUN, 8000))).toEqual(["P01"]);
    expect(ids(await s.expiredDispatching(RUN))).toEqual(["P03"]);
    expect(ids(await s.dueUnknown(RUN))).toEqual(["P05"]);
    expect(ids(await s.watchable(RUN))).toEqual(["P08"]);
    // RESERVED ×2, DISPATCHING ×2, OUTCOME_UNKNOWN ×3; QUARANTINED and CONFIRMED do not count
    expect(await s.unresolvedCount(RUN)).toBe(7);
  });

  test("guards read obligation status/reason and the grant's frozen flag; a missing obligation is NOT_OWED", async () => {
    const s = createMongoStore({ gw: db, inv: db, runId: RUN });
    const p05 = (await db.intents.findOne({ _id: intent("P05", "sim_payout")._id }))!;
    expect(await s.guards(p05)).toEqual({ obligationStatus: "HELD", obligationReason: "PAYEE_CHANGE_REQUESTED", grantFrozen: false });
    expect(await s.guards({ ...p05, draws_on: `${RUN}:GOODWILL` })).toMatchObject({ grantFrozen: true });
    const p06 = (await db.intents.findOne({ _id: intent("P06", "sim_payout")._id }))!;
    expect(await s.guards(p06)).toEqual({ obligationStatus: "NOT_OWED", obligationReason: null, grantFrozen: false });
  });

  test("an investigation record is opened, closed with the trail, and an EVIDENCE_RECORDED audit event follows", async () => {
    const s = createMongoStore({ gw: db, inv: db, runId: RUN });
    const it = (await db.intents.findOne({ _id: intent("P05", "sim_payout")._id }))!;
    const rec = await s.openInvestigation(it, "reconciler-t");
    const o = obj(it);
    await s.closeInvestigation(
      rec,
      it,
      {
        investigator: "deterministic",
        fallback_reason: "TIMEOUT: x",
        hypothesis: "deterministic plan: list by payee",
        steps: [{ tool: "list_provider_payments_by_payee", input: { all_pages: true }, summary: "1 record", record_count: 1 }],
        records: [o],
        complete: true,
        match: "MATCH",
        match_detail: null,
        decision: { row: 2, kind: "SETTLE", object: o },
        licence: null,
        guards: { obligationStatus: "OWED", obligationReason: null, grantFrozen: false },
        db_now: now,
      },
      "reconciler-t",
    );
    const doc = (await db.investigations.findOne({ _id: rec.id } as Document)) as Document;
    expect(doc).toMatchObject({ run_id: RUN, intent_id: it._id, epoch: it.lease_epoch, investigator: "deterministic", match: "MATCH", licence: null });
    expect(doc.opened_at).toBeInstanceOf(Date);
    expect(doc.closed_at).toBeInstanceOf(Date);
    expect(doc.records).toHaveLength(1);
    expect(doc.evidence_queries).toEqual(["list_provider_payments_by_payee"]);
    const ev = await db.audit.findOne({ type: "EVIDENCE_RECORDED", intent_id: it._id });
    expect(ev).toMatchObject({ actor: { kind: "reconciler", id: "reconciler-t" }, to_state: null, detail: { match: "MATCH", decision: "SETTLE" } });
    // the store wrote no intent
    expect((await db.intents.findOne({ _id: it._id }))!.updated_at).toEqual(it.updated_at);
  });
});
