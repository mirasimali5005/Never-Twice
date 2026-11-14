// Tier 3 (CP-AUTH-1): seeding a hierarchical goodwill grant tree under the run's pool. Seeding only (owner connection or tests);
// the gateway never creates grants at run time. Node ids are relative ("GOODWILL", "GOODWILL/DESK_A", "GOODWILL/DESK_A/AGENT_1");
// stored _ids are `${run_id}:${id}`. The root must be "GOODWILL" (the run's pool); every other node names its parent, which must
// come earlier in the list. `ancestors` (parent first, root last) is computed here once and never changes.
import type { NtDb } from "@nt/db";
import { goodwillGrantId } from "./authority.ts";

export type GrantNode = { id: string; parent: string | null; grant_minor: number };

export async function seedGrantTree(db: NtDb, runId: string, nodes: readonly GrantNode[], policyVersion = "NT-GOODWILL@1"): Promise<string[]> {
  const ancestors = new Map<string, string[]>();
  const docs = nodes.map((n) => {
    if (!Number.isSafeInteger(n.grant_minor) || n.grant_minor < 0) throw new Error(`grant tree: ${n.id} grant_minor must be an integer >= 0`);
    if (n.parent === null) {
      if (`${runId}:${n.id}` !== goodwillGrantId(runId)) throw new Error(`grant tree: the root must be GOODWILL, got ${n.id}`);
      ancestors.set(n.id, []);
    } else {
      const up = ancestors.get(n.parent);
      if (up === undefined) throw new Error(`grant tree: ${n.id} names parent ${n.parent}, which is not listed before it`);
      ancestors.set(n.id, [n.parent, ...up]);
    }
    const anc = ancestors.get(n.id)!.map((a) => `${runId}:${a}`);
    return {
      _id: `${runId}:${n.id}`, run_id: runId, kind: "GOODWILL_POOL" as const, grant_minor: n.grant_minor, held_minor: 0, settled_minor: 0,
      frozen: false, currency: "CAD" as const, policy_version: policyVersion, ...(anc.length > 0 ? { ancestors: anc } : {}),
    };
  });
  if (!docs.some((d) => d._id === goodwillGrantId(runId))) throw new Error("grant tree: no root GOODWILL node");
  await db.grants.insertMany(docs);
  return docs.map((d) => d._id);
}
