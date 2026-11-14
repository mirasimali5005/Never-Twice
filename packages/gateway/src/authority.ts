// The authority gate (HANDOVER.md §10.3, property P2). Mutation site M1.
// The guard is on the document being updated (never read-then-write), so a concurrent reservation either sees the
// earlier increment or gets a WriteConflict and is re-run by the driver on a fresh snapshot (B-INT-03 b1-b3).
//
// Tier 3 (CP-AUTH-1), hierarchical authority: a grant may name its `ancestors` (parent first, the run's pool
// `${run_id}:GOODWILL` last), e.g. airline pool → desk sub-pool → per-agent limit. A reservation on a leaf must fit EVERY level:
// inside the same reserve transaction, one guarded $inc per level (not frozen, held + settled + amount <= grant). Any level that
// refuses throws BudgetRefused and aborts the transaction, which undoes the increments already made on the levels below it.
// `ancestors` is structural and written once at seeding; reading it is not a read-then-write of a counter.
// The default (no leaf configured) is the single pool with no extra read, so S0/S1 behaviour is unchanged.
import type { ClientSession, Document } from "mongodb";
import type { NtDb } from "@nt/db";
import { BudgetRefused, ProgrammerError } from "./errors.ts";
import type { GatewayDeps, GatewayHooks } from "./types.ts";

export const goodwillGrantId = (runId: string) => `${runId}:GOODWILL`;

/** The grant a goodwill reservation draws on: the configured leaf (CP-AUTH-1), else the run's single pool. */
export function authorityLeafId(deps: Pick<GatewayDeps, "runId" | "config">): string {
  const leaf = deps.config.authorityGrantId;
  if (!leaf) return goodwillGrantId(deps.runId);
  return leaf.startsWith(`${deps.runId}:`) ? leaf : `${deps.runId}:${leaf}`;
}

/** The node id without the run prefix (carried in provider metadata as nt_authority so the auditor can attribute payments). */
export function relativeGrantId(runId: string, grantId: string): string {
  return grantId.startsWith(`${runId}:`) ? grantId.slice(runId.length + 1) : grantId;
}

/** The grant filter: not frozen, and held + settled + amount <= grant. Under M1 the cap clause is omitted (and only then). */
export function goodwillGuard(grantId: string, amountMinor: number, hooks: GatewayHooks): Document {
  const filter: Document = { _id: grantId, frozen: false };
  if (!hooks.mutation("M1")) {
    filter.$expr = { $lte: [{ $add: ["$held_minor", "$settled_minor", amountMinor] }, "$grant_minor"] };
  }
  return filter;
}

/** [grantId, ...ancestors] (leaf first, root last). A missing grant yields [grantId]; callers' guards then fail on it. */
export async function grantChain(db: NtDb, grantId: string, session?: ClientSession): Promise<string[]> {
  const g = await db.grants.findOne({ _id: grantId }, { session, projection: { ancestors: 1 } });
  const anc = (g as { ancestors?: unknown } | null)?.ancestors;
  return [grantId, ...(Array.isArray(anc) ? anc.filter((x): x is string => typeof x === "string") : [])];
}

/** True when any level of the chain is frozen or missing (conservative). */
export async function chainFrozen(db: NtDb, grantId: string, session?: ClientSession): Promise<{ frozen: boolean; detail: string }> {
  const ids = await grantChain(db, grantId, session);
  const docs = await db.grants.find({ _id: { $in: ids } }, { session }).toArray();
  for (const id of ids) {
    const d = docs.find((x) => x._id === id);
    if (!d) return { frozen: true, detail: `grant missing: ${id}` };
    if (d.frozen) return { frozen: true, detail: `grant frozen: ${id}` };
  }
  return { frozen: false, detail: "" };
}

/**
 * Inside the reserve transaction: hold `amountMinor` on every level of the chain or throw BudgetRefused (which aborts the
 * transaction). With `rootId` given, a chain that does not end at the run's pool is a programmer error (a leaf must sit under
 * the run's pool, so the pool-level cap of property P2 and auditor check C6 still bounds everything).
 */
export async function holdGoodwill(db: NtDb, session: ClientSession, grantId: string, amountMinor: number, hooks: GatewayHooks, rootId?: string): Promise<void> {
  const ids = rootId === undefined || grantId === rootId ? [grantId] : await grantChain(db, grantId, session);
  if (rootId !== undefined && ids[ids.length - 1] !== rootId) throw new ProgrammerError(`grant ${grantId} is not under the run's pool ${rootId}`);
  for (const id of ids) {
    const r = await db.grants.updateOne(goodwillGuard(id, amountMinor, hooks), { $inc: { held_minor: amountMinor } }, { session });
    if (r.modifiedCount !== 1) throw new BudgetRefused();
  }
}
