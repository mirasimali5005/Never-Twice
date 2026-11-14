// B1-INT-01 and the validator cases of B1-INT-02 (AGENT_TASKS.md B1 field 14).
// Deployment: mongodb-memory-server, or NT_TEST_MONGODB_URI (then a fresh nt_test_<random> database whose
// collections are dropped at the end; the database itself is never dropped).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoServerError } from "mongodb";
import { COLLECTION_NAMES, INDEXES, initDatabase, openNtDb, type NtDb } from "../src/index.ts";
import { startTestReplSet, type TestReplSet } from "../src/testing.ts";

let rs: TestReplSet;
let ntdb: NtDb;

beforeAll(async () => {
  rs = await startTestReplSet({ init: false });
  ntdb = await openNtDb({ uri: rs.uri, dbName: rs.dbName });
}, 180_000);

afterAll(async () => {
  await ntdb?.close();
  await rs?.stop();
});

const validIntent = () => ({
  _id: "r7k2m9qa:ZT4H9X.P02.NT101-20261110.APPR_DELAY",
  run_id: "r7k2m9qa",
  effect_key: "ZT4H9X.P02.NT101-20261110.APPR_DELAY",
  obligation_id: "r7k2m9qa:ZT4H9X.P02.NT101-20261110.APPR_DELAY",
  entitlement_type: "APPR_DELAY",
  amount_minor: 70000,
  currency: "CAD",
  payee_ref: "payee_P02",
  provider: "sim_payout",
  idempotency_key: "r7k2m9qa:ZT4H9X.P02.NT101-20261110.APPR_DELAY",
  frozen_request: { provider: "sim_payout", operation: "PAYOUT" },
  frozen_request_sha256: "a".repeat(64),
  draws_on: null,
  state: "RESERVED",
  lease: null,
  lease_epoch: 0,
  first_dispatch_at: null,
  last_send_at: null,
  key_expires_at: null,
  next_attempt_at: null,
  attempts: [],
  evidence: null,
  rejection: null,
  quarantine: null,
  policy_version: "APPR-SOR-2019-150@2022-09-08",
  rule_citation: "s. 19(1)(a)(ii)",
  created_at: new Date(),
  updated_at: new Date(),
});

describe("initDatabase", () => {
  it("creates ten collections and every index; a second run changes nothing", async () => {
    const first = await initDatabase(ntdb.db);
    expect(first.collections.filter((c) => c.action === "created").map((c) => c.name).sort()).toEqual([...COLLECTION_NAMES].sort());
    expect(first.indexes.filter((i) => i.action === "created")).toHaveLength(INDEXES.length);

    const names = (await ntdb.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    expect(names.sort()).toEqual([...COLLECTION_NAMES].sort());
    const intentIx = (await ntdb.intents.listIndexes().toArray()).map((i) => i.key);
    expect(intentIx).toContainEqual({ run_id: 1, state: 1, "lease.expires_at": 1 });
    expect(intentIx).toContainEqual({ run_id: 1, state: 1, next_attempt_at: 1 });
    const info = await ntdb.db.listCollections({ name: "payment_intents" }).toArray();
    expect(info[0]).toMatchObject({ options: { validationLevel: "strict", validationAction: "error" } });

    const second = await initDatabase(ntdb.db);
    expect(second.collections.every((c) => c.action === "existing")).toBe(true);
    expect(second.validators.every((v) => v.action === "unchanged")).toBe(true);
    expect(second.indexes.every((i) => i.action === "existing")).toBe(true);
    console.log("init first run:", JSON.stringify(first));
    console.log("init second run:", JSON.stringify(second));
  });

  it("re-applies a validator that was changed (collMod) and leaves data in place", async (ctx) => {
    const denied = await ntdb.db.command({ collMod: "payment_intents", validator: {}, validationLevel: "off" }).then(
      () => false,
      (e: { code?: number }) => e.code === 13,
    );
    // The event sandbox user may not run collMod (observed: code 13 Unauthorized); the case cannot be set up there.
    if (denied) ctx.skip("collMod is not authorized on this deployment");
    const r = await initDatabase(ntdb.db);
    expect(r.validators.find((v) => v.name === "payment_intents")?.action).toBe("updated");
    expect((await initDatabase(ntdb.db)).validators.find((v) => v.name === "payment_intents")?.action).toBe("unchanged");
  });
});

describe("payment_intents validator", () => {
  const rejects = async (doc: Record<string, unknown>) => {
    const err = await ntdb.intents.insertOne(doc as never).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MongoServerError);
    expect((err as MongoServerError).code).toBe(121); // DocumentValidationFailure
  };

  it("accepts the HANDOVER §8.1 shape", async () => {
    await ntdb.intents.deleteMany({});
    await expect(ntdb.intents.insertOne(validIntent() as never)).resolves.toBeTruthy();
    await ntdb.intents.deleteMany({});
  });

  it('rejects state "PAID" with amount 0', async () => {
    await rejects({ ...validIntent(), state: "PAID", amount_minor: 0 });
  });

  it('rejects state "PAID" alone, amount 0 alone, amount 12.5, currency USD, a lease with an epoch, a missing field', async () => {
    await rejects({ ...validIntent(), state: "PAID" });
    await rejects({ ...validIntent(), amount_minor: 0 });
    await rejects({ ...validIntent(), amount_minor: 12.5 });
    await rejects({ ...validIntent(), currency: "USD" });
    await rejects({ ...validIntent(), lease: { owner: "w", expires_at: new Date(), epoch: 1 } });
    const { lease_epoch: _omit, ...missing } = validIntent();
    await rejects(missing);
    expect(await ntdb.intents.countDocuments({})).toBe(0);
  });

  it("audit_events require run_id, type, at and actor", async () => {
    const err = await ntdb.audit.insertOne({ run_id: "r1", type: "X" } as never).then(() => null, (e: unknown) => e);
    expect((err as MongoServerError).code).toBe(121);
  });
});
