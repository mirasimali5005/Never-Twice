// REV-INT (Tier 3, CP-REV-1): the reconciler's reversal watch against a real replica set and the real gateway function.
// CONFIRMED intents whose provider object is now reversed get exactly one PROVIDER_REVERSAL event; the intent is not written;
// still-paid and missing objects change nothing; the watch runs only with --watch; nothing is ever sent.
import { afterAll, beforeAll, describe, expect, it as test } from "vitest";
import type { Intent, PaymentProvider, ProviderObject } from "@nt/contracts";
import { dbNow, openNtDb, type NtDb } from "@nt/db";
import { startTestReplSet, type TestReplSet } from "@nt/db/testing";
import { recordProviderReversal } from "@nt/gateway";
import { tick, type LoopDeps } from "../src/loop.ts";
import type { ReconcilerGateway } from "../src/ports.ts";
import { createMongoStore } from "../src/store.ts";
import { CAPS, RUN, intent, obj } from "./support/fixtures.ts";

let repl: TestReplSet;
let db: NtDb;
const ledger = new Map<string, ProviderObject>();
const sends: string[] = [];

const confirmed = (p: string, now: Date): Intent => {
  const base = intent(p, "sim_payout", { state: "CONFIRMED", lease: null, next_attempt_at: null });
  const o = obj(base);
  ledger.set(o.id, o);
  return { ...base, evidence: { source: "RESPONSE", provider_object_id: o.id, status: "paid", amount_minor: o.amount_minor, currency: o.currency, payee_ref: o.payee_ref, marker: base._id, retrieved_at: now } };
};

beforeAll(async () => {
  repl = await startTestReplSet();
  db = await openNtDb({ uri: repl.uri, dbName: repl.dbName });
  const now = await dbNow(db);
  const r1 = confirmed("P21", now);
  const r2 = confirmed("P22", now);
  const r3 = { ...confirmed("P23", now) };
  ledger.delete(r3.evidence!.provider_object_id); // provider no longer lists it: absence is not a reversal
  await db.intents.insertMany([r1, r2, r3]);
  ledger.get(r1.evidence!.provider_object_id)!.status = "reversed";
}, 180_000);

afterAll(async () => {
  await db?.close();
  await repl?.stop();
});

function deps(watch: boolean): LoopDeps {
  const view = {
    async getOperation(id: string) {
      const o = ledger.get(id);
      return o ? structuredClone(o) : null;
    },
    async findOperationEvidence() {
      return { records: [], complete: true };
    },
    async *listOperations() {},
  };
  const gdeps = { db, runId: RUN, workerId: "reconciler-test", providers: {} as Record<string, PaymentProvider>, config: { leaseMs: 8000, dispatchTimeoutMs: 3000, keyMarginMs: 60000, stripeEnabled: false } };
  const fail = (m: string) => async () => {
    sends.push(m);
    throw new Error(`${m} must not be called`);
  };
  const gateway = {
    dispatch: fail("dispatch"), takeOverExpired: fail("takeOverExpired"), acquireLease: fail("acquireLease"), settle: fail("settle"),
    quarantine: fail("quarantine"), recordLicence: fail("recordLicence"), resend: fail("resend"), applyResendResult: fail("applyResendResult"),
    readOnlyProviderView: () => view,
    capabilitiesOf: (p: keyof typeof CAPS) => CAPS[p],
    recordProviderReversal: (it: Intent, o: ProviderObject) => recordProviderReversal(gdeps, it, o),
  } as unknown as ReconcilerGateway;
  return {
    runId: RUN, workerId: "reconciler-test", leaseMs: 8000, watch, gateway,
    store: createMongoStore({ gw: db, inv: db, runId: RUN }),
    collect: async () => { throw new Error("no investigation expected"); },
    barrier: () => {},
  };
}

describe("reversal watch", () => {
  test("without --watch nothing is read or recorded", async () => {
    const r = await tick(deps(false));
    expect(r.reversals).toBe(0);
    expect(await db.audit.countDocuments({ type: "PROVIDER_REVERSAL" })).toBe(0);
  });

  test("with --watch: one event for the reversed object, none for still-paid or missing; idempotent across passes", async () => {
    const before = await db.intents.find({ run_id: RUN }).sort({ _id: 1 }).toArray();
    const r = await tick(deps(true));
    expect(r).toMatchObject({ reversals: 1, errors: 0 });
    const evs = await db.audit.find({ run_id: RUN, type: "PROVIDER_REVERSAL" }).toArray();
    expect(evs.map((e) => e.intent_id)).toEqual([`${RUN}:ZT4H9X.P21.NT101-20261110.APPR_DELAY`]);
    expect(await db.intents.find({ run_id: RUN }).sort({ _id: 1 }).toArray()).toEqual(before); // no intent written
    const s = createMongoStore({ gw: db, inv: db, runId: RUN });
    expect((await s.confirmedUnreversed!(RUN)).map((x) => x.effect_key.split(".")[1])).toEqual(["P22", "P23"]);
    const again = await tick(deps(true));
    expect(again.reversals).toBe(0);
    expect(await db.audit.countDocuments({ run_id: RUN, type: "PROVIDER_REVERSAL" })).toBe(1);
    expect(sends).toEqual([]);
  });
});

describe("recovery guards under hierarchical authority (CP-AUTH-1)", () => {
  test("a frozen or missing ancestor of the intent's grant reads as grantFrozen (AUTHORITY_REVOKED)", async () => {
    const RUN2 = "rtest002";
    await db.grants.insertMany([
      { _id: `${RUN2}:GOODWILL`, run_id: RUN2, frozen: true },
      { _id: `${RUN2}:GOODWILL/DESK_A`, run_id: RUN2, frozen: false, ancestors: [`${RUN2}:GOODWILL`] },
      { _id: `${RUN2}:GOODWILL/DESK_A/AGENT_1`, run_id: RUN2, frozen: false, ancestors: [`${RUN2}:GOODWILL/DESK_A`, `${RUN2}:GOODWILL`] },
      { _id: `${RUN2}:GOODWILL/DESK_B/AGENT_9`, run_id: RUN2, frozen: false, ancestors: [`${RUN2}:GOODWILL/DESK_B`, `${RUN2}:GOODWILL`] },
    ] as never[]);
    const s = createMongoStore({ gw: db, inv: db, runId: RUN2 });
    const it1 = intent("P31", "sim_payout", { draws_on: `${RUN2}:GOODWILL/DESK_A/AGENT_1` });
    expect((await s.guards(it1)).grantFrozen).toBe(true);
    await db.grants.updateOne({ _id: `${RUN2}:GOODWILL` } as never, { $set: { frozen: false } });
    expect((await s.guards(it1)).grantFrozen).toBe(false);
    const it2 = intent("P32", "sim_payout", { draws_on: `${RUN2}:GOODWILL/DESK_B/AGENT_9` }); // DESK_B missing
    expect((await s.guards(it2)).grantFrozen).toBe(true);
  });
});
