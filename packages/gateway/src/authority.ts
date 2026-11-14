// The authority gate: the single guarded goodwill pool (HANDOVER.md §10.3, property P2). Mutation site M1.
// The guard is on the document being updated (never read-then-write), so a concurrent reservation either sees the
// earlier increment or gets a WriteConflict and is re-run by the driver on a fresh snapshot (B-INT-03 b1-b3).
import type { ClientSession, Document } from "mongodb";
import type { NtDb } from "@nt/db";
import { BudgetRefused } from "./errors.ts";
import type { GatewayHooks } from "./types.ts";

export const goodwillGrantId = (runId: string) => `${runId}:GOODWILL`;

/** The grant filter: not frozen, and held + settled + amount <= grant. Under M1 the cap clause is omitted (and only then). */
export function goodwillGuard(grantId: string, amountMinor: number, hooks: GatewayHooks): Document {
  const filter: Document = { _id: grantId, frozen: false };
  if (!hooks.mutation("M1")) {
    filter.$expr = { $lte: [{ $add: ["$held_minor", "$settled_minor", amountMinor] }, "$grant_minor"] };
  }
  return filter;
}

/** Inside the reserve transaction: hold `amountMinor` on the pool or throw BudgetRefused (which aborts the transaction). */
export async function holdGoodwill(db: NtDb, session: ClientSession, grantId: string, amountMinor: number, hooks: GatewayHooks): Promise<void> {
  const r = await db.grants.updateOne(goodwillGuard(grantId, amountMinor, hooks), { $inc: { held_minor: amountMinor } }, { session });
  if (r.modifiedCount !== 1) throw new BudgetRefused();
}
