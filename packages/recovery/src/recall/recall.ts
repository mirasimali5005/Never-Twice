// Recall over investigation_records with Atlas Vector Search (Tier 2, advisory; HANDOVER.md §3, §8; ARCHITECTURE.md §5.2, ADD-33).
// Searches ACROSS runs (past experience is the point), excludes the intent under investigation, only closed records (an embedding
// is written only after close, and the pre-filter also requires a matcher result). Returns compact PastInvestigation entries for the
// LLM investigator's prompt; never matcher input. Any failure (no key, no index, Voyage down, timeout) returns [] and is logged.
// This module takes a structural collection, so @nt/recovery gains no driver dependency and no write path.
import type { Embedder, EvidenceMatch, Intent, PastInvestigation, Rail, Recall, RecoveryDecision } from "@nt/contracts";
import { queryText } from "./text.ts";

export const RECALL_INDEX = "investigation_recall";
export const RECALL_NUM_CANDIDATES = 50;
export const RECALL_K = 3;

/** A PastInvestigation plus the record id it came from (stored as `recalled` on the new record). */
export type RecalledInvestigation = PastInvestigation & { id: string };

export interface RecallCollection {
  aggregate(pipeline: Record<string, unknown>[]): { toArray(): Promise<unknown[]> };
}

/** The $vectorSearch pipeline. Pure; exported for tests. */
export function recallPipeline(it: Pick<Intent, "_id" | "provider">, queryVector: number[], k: number = RECALL_K): Record<string, unknown>[] {
  return [
    {
      $vectorSearch: {
        index: RECALL_INDEX,
        path: "embedding",
        queryVector,
        numCandidates: Math.max(RECALL_NUM_CANDIDATES, k),
        limit: k,
        filter: {
          $and: [
            { provider: { $eq: it.provider } },
            { intent_id: { $ne: it._id } },
            { match: { $in: ["MATCH", "NO_MATCH", "CONTRADICTION"] } }, // closed records only
          ],
        },
      },
    },
    { $match: { closed_at: { $ne: null } } },
    {
      $project: {
        _id: 1,
        hypothesis: 1,
        rail: 1,
        fault_signature: 1,
        evidence_queries: 1,
        match: 1,
        decision_kind: "$decision.kind",
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];
}

const MATCHES = new Set(["MATCH", "NO_MATCH", "CONTRADICTION"]);
const DECISIONS = new Set(["SETTLE", "QUARANTINE", "REDISPATCH_SAME_KEY"]);

/** Defensive mapping of an aggregation row; rows that do not look like a closed record are dropped. */
export function toRecalled(row: unknown): RecalledInvestigation | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.match !== "string" || !MATCHES.has(r.match)) return null;
  if (typeof r.decision_kind !== "string" || !DECISIONS.has(r.decision_kind)) return null;
  const id = r._id !== undefined && r._id !== null ? String((r._id as { toHexString?: () => string }).toHexString?.() ?? r._id) : "";
  return {
    id,
    hypothesis: typeof r.hypothesis === "string" ? r.hypothesis.slice(0, 280) : null,
    rail: typeof r.rail === "string" ? (r.rail as Rail) : null,
    fault_signature: typeof r.fault_signature === "string" ? r.fault_signature.slice(0, 200) : "unknown",
    evidence_queries: Array.isArray(r.evidence_queries) ? r.evidence_queries.filter((q): q is string => typeof q === "string").slice(0, 6) : [],
    match: r.match as EvidenceMatch["kind"],
    decision_kind: r.decision_kind as RecoveryDecision["kind"],
    score: typeof r.score === "number" ? r.score : 0,
  };
}

export type RecallOptions = {
  collection: RecallCollection;
  embedder: Embedder;
  /** Whole lookup budget (embed + search). Default 5 000 ms. */
  timeoutMs?: number;
  log?: (line: string) => void;
};

export type VectorRecall = Recall & {
  similar(it: Intent, k: number): Promise<RecalledInvestigation[]>;
  /**
   * Embeds the query texts of several intents in ONE Voyage call and caches them by text, so a tick with several due intents costs
   * one embedding request (a key without billing is limited to 3 requests per minute). Never throws.
   */
  prime(its: Intent[]): Promise<void>;
};

export function createRecall(o: RecallOptions): VectorRecall {
  const timeoutMs = o.timeoutMs ?? 5_000;
  const cache = new Map<string, number[]>();
  const lookup = async (it: Intent, k: number): Promise<RecalledInvestigation[]> => {
    const text = queryText(it);
    let vector = cache.get(text);
    if (vector === undefined) {
      [vector] = await o.embedder.embed([text], "query");
      if (!vector) throw new Error("embedder returned no vector");
      cache.set(text, vector);
    }
    const rows = await o.collection.aggregate(recallPipeline(it, vector, k)).toArray();
    return rows.map(toRecalled).filter((r): r is RecalledInvestigation => r !== null).slice(0, k);
  };
  return {
    async prime(its) {
      const texts = [...new Set(its.map(queryText))].filter((t) => !cache.has(t));
      if (texts.length === 0) return;
      try {
        const vs = await o.embedder.embed(texts, "query");
        texts.forEach((t, i) => {
          const v = vs[i];
          if (v) cache.set(t, v);
        });
      } catch (e) {
        o.log?.(`recall: query embedding failed (${e instanceof Error ? e.message : String(e)})`.slice(0, 300));
      }
    },
    async similar(it, k) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
        });
        return await Promise.race([lookup(it, k), timeout]);
      } catch (e) {
        o.log?.(`recall: no context for ${it._id} (${e instanceof Error ? e.message : String(e)})`.slice(0, 300));
        return [];
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
