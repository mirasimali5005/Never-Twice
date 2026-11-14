// B1-INT-03 (withTxn) and B1-INT-04 (dbNow), AGENT_TASKS.md B1 field 14.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { CasMiss, dbNow, openNtDb, tryTxn, withTxn, type NtDb } from "../src/index.ts";
import { startTestReplSet, type TestReplSet } from "../src/testing.ts";

let rs: TestReplSet;
let ntdb: NtDb;
const RUN = "rtxntest";
const audit = (type: string) => ({ _id: new ObjectId(), run_id: RUN, at: new Date(), actor: { kind: "gateway", id: "t" }, type });

beforeAll(async () => {
  rs = await startTestReplSet();
  ntdb = await openNtDb({ uri: rs.uri, dbName: rs.dbName });
}, 180_000);

afterAll(async () => {
  await ntdb?.close();
  await rs?.stop();
});

describe("withTxn / tryTxn", () => {
  it("commits several writes together and ends the session", async () => {
    const ended: unknown[] = [];
    const before = await ntdb.audit.countDocuments({ run_id: RUN });
    const v = await withTxn(ntdb, async (s) => {
      await ntdb.audit.insertOne(audit("A"), { session: s });
      await ntdb.audit.insertOne(audit("B"), { session: s });
      ended.push(s.hasEnded);
      return 7;
    });
    expect(v).toBe(7);
    expect(ended).toEqual([false]);
    expect(await ntdb.audit.countDocuments({ run_id: RUN })).toBe(before + 2);
  });

  it("a thrown error leaves no write and the session is ended", async () => {
    const before = await ntdb.audit.countDocuments({ run_id: RUN });
    let seen: { hasEnded: boolean } | undefined;
    const out = await tryTxn(ntdb, async (s) => {
      seen = s;
      await ntdb.audit.insertOne(audit("C"), { session: s });
      throw new CasMiss();
    });
    expect(out.kind).toBe("CAS_MISS");
    expect(seen?.hasEnded).toBe(true);
    expect(await ntdb.audit.countDocuments({ run_id: RUN })).toBe(before);
  });

  it("maps a duplicate _id inside the transaction to DUPLICATE_KEY and rolls back the other writes", async () => {
    const id = new ObjectId();
    await ntdb.audit.insertOne({ ...audit("D"), _id: id });
    const before = await ntdb.audit.countDocuments({ run_id: RUN });
    const out = await tryTxn(ntdb, async (s) => {
      await ntdb.audit.insertOne(audit("E"), { session: s });
      await ntdb.audit.insertOne({ ...audit("D2"), _id: id }, { session: s });
    });
    expect(out.kind).toBe("DUPLICATE_KEY");
    expect(await ntdb.audit.countDocuments({ run_id: RUN })).toBe(before);
  });

  it("rethrows other errors unchanged", async () => {
    class Domain extends Error {}
    await expect(tryTxn(ntdb, async () => { throw new Domain("x"); })).rejects.toBeInstanceOf(Domain);
  });
});

describe("dbNow", () => {
  it("returns a Date from the server", async () => {
    const now = await dbNow(ntdb, RUN);
    expect(now).toBeInstanceOf(Date);
    expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(5 * 60_000);
  });
});
