// The database's clock. Fixed code that needs "now" for a lease or key-window decision uses $$NOW inside the
// write itself; dbNow is for the few places that must read it (scan candidates, reports). Never Date.now().
import type { NtDb } from "./client.ts";

/** Server time, read with an aggregation that projects $$NOW (no document needed). `_runId` is accepted for the field-9 signature. */
export async function dbNow(ntdb: Pick<NtDb, "db">, _runId?: string): Promise<Date> {
  const [row] = await ntdb.db.aggregate<{ now: Date }>([{ $documents: [{}] }, { $project: { _id: 0, now: "$$NOW" } }]).toArray();
  if (!row || !(row.now instanceof Date)) throw new Error("dbNow: the server did not return $$NOW");
  return row.now;
}
