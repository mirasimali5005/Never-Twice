// Test helper ("@nt/db/testing"). Starts a mongodb-memory-server replica set, or uses NT_TEST_MONGODB_URI when set
// (the local Docker image or the event sandbox). Runs initDatabase on a fresh `nt_test_<random>` database.
// stop() drops only the collections of a database this helper named itself, and never drops a database
// (the sandbox user may not; HANDOVER.md §24).
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTION_NAMES } from "./collections.ts";
import { initDatabase } from "./init.ts";

export type TestReplSet = { uri: string; dbName: string; external: boolean; stop(): Promise<void> };

export const testDbName = () => `nt_test_${Math.random().toString(36).slice(2, 9)}`;

export async function startTestReplSet(opts: { init?: boolean; dbName?: string } = {}): Promise<TestReplSet> {
  const external = process.env.NT_TEST_MONGODB_URI;
  const repl = external ? undefined : await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const uri = external ?? repl!.getUri();
  const dbName = opts.dbName ?? testDbName();
  const ownDb = opts.dbName === undefined;
  if (opts.init !== false) {
    const c = new MongoClient(uri, { writeConcern: { w: "majority" } });
    try {
      await initDatabase(c.db(dbName));
    } finally {
      await c.close();
    }
  }
  return {
    uri,
    dbName,
    external: Boolean(external),
    async stop() {
      if (repl) {
        await repl.stop();
        return;
      }
      if (!ownDb) return; // never touch a database the caller named
      await dropTestCollections(uri, dbName);
    },
  };
}

/** Drops every collection of a `nt_test_*` database (the database itself disappears when empty). */
export async function dropTestCollections(uri: string, dbName: string): Promise<void> {
  if (!dbName.startsWith("nt_test_")) throw new Error(`refusing to drop collections of ${dbName}: not a nt_test_ database`);
  const c = new MongoClient(uri);
  try {
    const db = c.db(dbName);
    const names = new Set<string>([...COLLECTION_NAMES, ...(await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name)]);
    for (const n of names) await db.collection(n).drop().catch(() => {});
  } finally {
    await c.close();
  }
}
