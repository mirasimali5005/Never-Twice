// B-INT-03 (TEST_PLAN.md §3.9, HANDOVER.md §8.4 and §20 first-hour exception).
//
// Observes, with the raw `mongodb` driver and scratch collections only (no @nt/contracts, no @nt/db,
// no withTxn), the transaction behaviour the reserve transaction (HANDOVER.md §10.3) relies on:
//   (a) duplicate `_id` inside a snapshot/majority transaction: 11000 aborts it, the driver does not
//       re-run the callback, the error is caught outside withTransaction, nothing in the transaction
//       survives, and the caller then reads (adopts) the existing document with read concern majority;
//   (b) two transactions on one guarded counter document: the later one gets WriteConflict, the driver
//       re-runs its callback on a fresh snapshot, and the `$expr` cap is never exceeded;
//   (c) two (and more) concurrent reserve-shaped transactions on one key: exactly one commits, the
//       others end with 11000 caught outside and adopt; one intent, one audit document, counter moved once;
//   (d) an update pipeline using $$NOW for a lease comparison works inside a transaction;
//   (e) how the driver serialises JavaScript numbers (the validator wants a BSON integer for amount_minor).
//
// Deployment: NT_TEST_MONGODB_URI when set (the event sandbox or a local Docker replica set); otherwise a
// mongodb-memory-server replica set. Database: NT_TEST_DB_NAME or `nt_test_<random>`. The test drops its
// own collections at the end and never drops a database (the sandbox user may not; HANDOVER.md §24).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, MongoError, MongoServerError, ObjectId, type Collection, type Db, type TransactionOptions } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const TXN: TransactionOptions = { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } };
const GRANT_ID = "bint03:GOODWILL";
const CAP = 50_000;
const AMOUNT = 15_000;

type Grant = { _id: string; grant_minor: number; held_minor: number; settled_minor: number; frozen: boolean };
type Intent = { _id: string; amount_minor: number; state: string; lease?: { owner: string; expires_at: Date } | null; lease_epoch?: number };
type Audit = { _id: ObjectId; type: string; intent_id: string; worker: string };

class BudgetRefused extends Error {}

const rand = () => Math.random().toString(36).slice(2, 9);
const isDup = (e: unknown) => e instanceof MongoServerError && e.code === 11000;
const describeErr = (e: unknown) =>
  e instanceof MongoError
    ? { name: e.name, code: (e as MongoServerError).code, codeName: (e as MongoServerError).codeName, labels: e.errorLabels }
    : { name: (e as Error)?.name, message: (e as Error)?.message };

let repl: MongoMemoryReplSet | undefined;
let client: MongoClient;
let db: Db;
let grants: Collection<Grant>;
let intents: Collection<Intent>;
let audit: Collection<Audit>;
let leases: Collection<Intent>;
const prefix = `bint03_${rand()}_`;
const observed: Record<string, unknown> = {};

beforeAll(async () => {
  const external = process.env.NT_TEST_MONGODB_URI;
  let uri: string;
  if (external) {
    uri = external;
    observed.deployment = "NT_TEST_MONGODB_URI";
  } else {
    repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    uri = repl.getUri();
    observed.deployment = "mongodb-memory-server";
  }
  const t0 = Date.now();
  client = new MongoClient(uri, { writeConcern: { w: "majority" } });
  await client.connect();
  observed.connectMs = Date.now() - t0;
  db = client.db(process.env.NT_TEST_DB_NAME ?? `nt_test_${rand()}`);
  const hello = await db.admin().command({ hello: 1 });
  const build = await db.admin().command({ buildInfo: 1 });
  observed.server = { version: build.version, setName: hello.setName ?? null, db: db.databaseName };
  // Scratch collections are created before any transaction (HANDOVER.md §8).
  for (const n of ["grants", "intents", "audit", "leases"]) await db.createCollection(prefix + n);
  grants = db.collection<Grant>(prefix + "grants");
  intents = db.collection<Intent>(prefix + "intents");
  audit = db.collection<Audit>(prefix + "audit");
  leases = db.collection<Intent>(prefix + "leases");
}, 180_000);

afterAll(async () => {
  console.log("B-INT-03 observed:", JSON.stringify(observed, null, 2));
  if (db) for (const n of ["grants", "intents", "audit", "leases"]) await db.collection(prefix + n).drop().catch(() => {});
  await client?.close();
  await repl?.stop();
});

async function resetGrant(held = 0) {
  await grants.deleteMany({});
  await intents.deleteMany({});
  await audit.deleteMany({});
  await grants.insertOne({ _id: GRANT_ID, grant_minor: CAP, held_minor: held, settled_minor: 0, frozen: false });
}

/** The reserve shape of HANDOVER.md §10.3 on scratch collections. Ids are minted outside the callback. */
async function reserve(intentId: string, worker: string, runs: { n: number }, onError?: (e: unknown) => Promise<void>) {
  const intent: Intent = { _id: intentId, amount_minor: AMOUNT, state: "RESERVED" };
  const event: Audit = { _id: new ObjectId(), type: "INTENT_RESERVED", intent_id: intentId, worker };
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      runs.n++;
      try {
        const r = await grants.updateOne(
          { _id: GRANT_ID, frozen: false, $expr: { $lte: [{ $add: ["$held_minor", "$settled_minor", AMOUNT] }, "$grant_minor"] } },
          { $inc: { held_minor: AMOUNT } },
          { session },
        );
        if (r.modifiedCount !== 1) throw new BudgetRefused();
        await intents.insertOne(intent, { session });
        await audit.insertOne(event, { session });
      } catch (e) {
        if (onError) await onError(e);
        throw e; // never swallow inside the callback
      }
    }, TXN);
    return { kind: "RESERVED" as const };
  } catch (e) {
    if (e instanceof BudgetRefused) return { kind: "AWAITING_BUDGET" as const };
    if (isDup(e)) {
      const existing = await db.collection<Intent>(prefix + "intents", { readConcern: { level: "majority" } }).findOne({ _id: intentId });
      return { kind: "ADOPTED" as const, existing, error: describeErr(e) };
    }
    throw e;
  } finally {
    await session.endSession();
  }
}

describe("B-INT-03 duplicate key and write conflict inside the reserve transaction", () => {
  it("(a) duplicate _id: 11000 aborts, is not retried, is caught outside, leaves no increment and no audit, then adopts", async () => {
    await resetGrant();
    await intents.insertOne({ _id: "bint03:K-DUP", amount_minor: AMOUNT, state: "RESERVED" });
    const runs = { n: 0 };
    const res = await reserve("bint03:K-DUP", "w-a", runs);
    observed.a = { result: res, callbackRuns: runs.n };
    expect(res.kind).toBe("ADOPTED");
    if (res.kind !== "ADOPTED") return;
    expect(res.error.code).toBe(11000);
    expect(res.error.labels ?? []).not.toContain("TransientTransactionError");
    expect(runs.n).toBe(1); // the driver did not re-run the callback
    expect(res.existing?._id).toBe("bint03:K-DUP");
    expect((await grants.findOne({ _id: GRANT_ID }))?.held_minor).toBe(0); // the $inc was rolled back with the abort
    expect(await audit.countDocuments({})).toBe(0);
    expect(await intents.countDocuments({})).toBe(1);
  });

  it("(b1) two transactions on one grant: the later gets WriteConflict, its callback re-runs, both increments land", async () => {
    await resetGrant();
    const sA = client.startSession();
    sA.startTransaction(TXN);
    await grants.updateOne({ _id: GRANT_ID }, { $inc: { held_minor: AMOUNT } }, { session: sA }); // A holds an uncommitted write
    const errorsB: unknown[] = [];
    let conflictSeen!: () => void;
    const conflict = new Promise<void>((r) => (conflictSeen = r));
    const runs = { n: 0 };
    const b = reserve("bint03:K-B1", "w-b", runs, async (e) => {
      errorsB.push(describeErr(e));
      conflictSeen();
    });
    await conflict; // B's first run hit A's uncommitted write
    await sA.commitTransaction();
    await sA.endSession();
    const res = await b;
    observed.b1 = { result: res, callbackRuns: runs.n, errorsInsideB: errorsB };
    expect(res.kind).toBe("RESERVED");
    expect(runs.n).toBeGreaterThanOrEqual(2);
    expect(errorsB[0]).toMatchObject({ code: 112, codeName: "WriteConflict" });
    expect((errorsB[0] as { labels: string[] }).labels).toContain("TransientTransactionError");
    expect((await grants.findOne({ _id: GRANT_ID }))?.held_minor).toBe(2 * AMOUNT);
    // the re-run callback wrote one intent and one audit event (ids minted outside the callback)
    expect(await intents.countDocuments({ _id: "bint03:K-B1" })).toBe(1);
    expect(await audit.countDocuments({ intent_id: "bint03:K-B1" })).toBe(1);
  });

  it("(b2) cap under a write conflict: the re-run sees the committed increment and the $expr guard refuses", async () => {
    await resetGrant(30_000); // headroom 20000: only one more 15000 fits
    const sA = client.startSession();
    sA.startTransaction(TXN);
    const ra = await grants.updateOne(
      { _id: GRANT_ID, frozen: false, $expr: { $lte: [{ $add: ["$held_minor", "$settled_minor", AMOUNT] }, "$grant_minor"] } },
      { $inc: { held_minor: AMOUNT } },
      { session: sA },
    );
    expect(ra.modifiedCount).toBe(1);
    let conflictSeen!: () => void;
    const conflict = new Promise<void>((r) => (conflictSeen = r));
    const runs = { n: 0 };
    const errorsB: unknown[] = [];
    const b = reserve("bint03:K-B2", "w-b", runs, async (e) => {
      errorsB.push(describeErr(e));
      conflictSeen();
    });
    await conflict;
    await sA.commitTransaction();
    await sA.endSession();
    const res = await b;
    observed.b2 = { result: res, callbackRuns: runs.n, errorsInsideB: errorsB };
    expect(res.kind).toBe("AWAITING_BUDGET");
    expect(runs.n).toBeGreaterThanOrEqual(2);
    expect((await grants.findOne({ _id: GRANT_ID }))?.held_minor).toBe(45_000);
    expect(await intents.countDocuments({})).toBe(0);
    expect(await audit.countDocuments({})).toBe(0);
  });

  it("(b3) ten concurrent goodwill reservations, different keys: held never exceeds the cap; held equals the intents", async () => {
    await resetGrant();
    const runs = Array.from({ length: 10 }, () => ({ n: 0 }));
    const results = await Promise.all(runs.map((r, i) => reserve(`bint03:K-G${i}`, `w-${i}`, r)));
    const reserved = results.filter((r) => r.kind === "RESERVED").length;
    const refused = results.filter((r) => r.kind === "AWAITING_BUDGET").length;
    const g = await grants.findOne({ _id: GRANT_ID });
    observed.b3 = { reserved, refused, held: g?.held_minor, totalCallbackRuns: runs.reduce((s, r) => s + r.n, 0) };
    expect(reserved).toBe(3); // floor(50000 / 15000)
    expect(refused).toBe(7);
    expect(g?.held_minor).toBe(3 * AMOUNT);
    expect(g!.held_minor + g!.settled_minor).toBeLessThanOrEqual(CAP);
    expect(await intents.countDocuments({})).toBe(3);
    expect(await audit.countDocuments({})).toBe(3);
  }, 120_000);

  it("(c) concurrent reserve transactions on the same key: exactly one commits, the others get 11000 outside and adopt", async () => {
    for (const n of [2, 5]) {
      await resetGrant();
      const runs = Array.from({ length: n }, () => ({ n: 0 }));
      const errorsInside: unknown[] = [];
      const results = await Promise.all(
        runs.map((r, i) => reserve("bint03:K-SAME", `w-${i}`, r, async (e) => void errorsInside.push(describeErr(e)))),
      );
      const kinds = results.map((r) => r.kind);
      observed[`c_${n}`] = { kinds, callbackRuns: runs.map((r) => r.n), errorsInsideCallbacks: errorsInside };
      expect(kinds.filter((k) => k === "RESERVED")).toHaveLength(1);
      expect(kinds.filter((k) => k === "ADOPTED")).toHaveLength(n - 1);
      for (const r of results) if (r.kind === "ADOPTED") {
        expect(r.error.code).toBe(11000);
        expect(r.existing?._id).toBe("bint03:K-SAME");
      }
      expect(await intents.countDocuments({})).toBe(1);
      expect(await audit.countDocuments({})).toBe(1);
      expect((await grants.findOne({ _id: GRANT_ID }))?.held_minor).toBe(AMOUNT); // incremented once
    }
  }, 120_000);

  it("(d) an update pipeline with $$NOW compares and sets a lease inside a transaction", async () => {
    await leases.deleteMany({});
    const NO_LIVE_LEASE = { $or: [{ $eq: ["$lease", null] }, { $lte: ["$lease.expires_at", "$$NOW"] }] };
    const past = new Date(Date.now() - 60_000);
    await leases.insertOne({ _id: "bint03:L1", amount_minor: AMOUNT, state: "RESERVED", lease: { owner: "old", expires_at: past }, lease_epoch: 3 });
    const acquire = async (owner: string) => {
      const session = client.startSession();
      try {
        return await session.withTransaction(
          async () =>
            leases.findOneAndUpdate(
              { _id: "bint03:L1", state: "RESERVED", lease_epoch: { $gte: 0 }, $expr: NO_LIVE_LEASE },
              [{ $set: {
                state: "DISPATCHING",
                lease_epoch: { $add: ["$lease_epoch", 1] },
                lease: { owner: { $literal: owner }, expires_at: { $dateAdd: { startDate: "$$NOW", unit: "millisecond", amount: 8000 } } },
                lease_alt_expires_at: { $add: ["$$NOW", 8000] },
                updated_at: "$$NOW",
              } }],
              { session, returnDocument: "after" },
            ),
          TXN,
        );
      } finally {
        await session.endSession();
      }
    };
    const first = (await acquire("w1")) as (Intent & { updated_at: Date; lease_alt_expires_at: Date }) | null;
    // a second acquisition sees a live lease (expires_at > $$NOW) and matches nothing
    await leases.updateOne({ _id: "bint03:L1" }, { $set: { state: "RESERVED" } });
    const second = await acquire("w2");
    observed.d = { first, secondMatched: second !== null };
    expect(first?.state).toBe("DISPATCHING");
    expect(first?.lease_epoch).toBe(4);
    expect(first?.lease?.owner).toBe("w1");
    expect(first?.lease?.expires_at).toBeInstanceOf(Date);
    expect(first!.lease!.expires_at.getTime() - first!.updated_at.getTime()).toBe(8000);
    expect(first!.lease_alt_expires_at.getTime() - first!.updated_at.getTime()).toBe(8000); // date + number = ms
    expect(second).toBeNull();
  });

  // Observed on driver 7.9.0: an integral number inside int32 range becomes BSON int; one outside it becomes a
  // double (not a long). amount_minor never approaches 2^31 cents, so the validator's ["int", "long"] holds.
  it("(e) the driver serialises integral JavaScript numbers in int32 range as BSON int, larger ones as double", async () => {
    await leases.deleteMany({});
    await leases.insertMany([
      { _id: "bint03:N1", amount_minor: 15000, state: "X" },
      { _id: "bint03:N2", amount_minor: 3_000_000_000, state: "X" },
      { _id: "bint03:N3", amount_minor: 12.5, state: "X" },
    ]);
    const types = await leases
      .aggregate<{ _id: string; t: string }>([{ $match: { state: "X" } }, { $project: { t: { $type: "$amount_minor" } } }, { $sort: { _id: 1 } }])
      .toArray();
    observed.e = types;
    expect(types.map((x) => x.t)).toEqual(["int", "double", "double"]);
  });
});
