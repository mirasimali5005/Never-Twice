// Tier 2, advisory (HANDOVER.md §3, §8; ARCHITECTURE.md §4.7, ADD-33): closed investigation records are embedded so later
// investigations can recall them. investigate() only enqueues the closed record's id (after apply(), so recovery never waits);
// the loop flushes the queue once per tick in ONE Voyage call (a key without billing is limited to 3 requests per minute) and
// writes each record with a single-document update outside any transaction. A flush with backfill also picks up this run's
// closed records whose embedding is missing or null (an earlier failure). Never throws: failures write embedding null and are logged.
import type { Embedder } from "@nt/contracts";
import { embeddingText, type ClosedRecordForEmbedding } from "@nt/recovery/recall";
import type { ObjectId } from "mongodb";
import type { EmbedClosed, Logger } from "./ports.ts";

/** The calls this module makes on investigation_records (the nt_investigator client). */
export interface EmbedCollection {
  find(filter: Record<string, unknown>, options?: { limit?: number; projection?: Record<string, 0 | 1> }): { toArray(): Promise<unknown[]> };
  updateOne(filter: { _id: ObjectId }, update: { $set: Record<string, unknown> }): Promise<unknown>;
}

type Rec = ClosedRecordForEmbedding & { _id: ObjectId; closed_at?: Date | null; intent_id?: string };

export type EmbedQueue = {
  /** investigate()'s hook: remembers the id; no network call. */
  enqueue: EmbedClosed;
  /** Embeds every queued record (and, with backfill, this run's unembedded closed records) in one call. Never throws. */
  flush(o?: { backfill?: boolean }): Promise<void>;
  readonly pending: number;
};

const BACKFILL_MAX = 20;

export function makeEmbedQueue(o: { collection: EmbedCollection; embedder: Embedder; runId?: string; log?: Logger }): EmbedQueue {
  const queue = new Map<string, ObjectId>();
  const projection = { embedding: 0 as const, records: 0 as const };
  return {
    get pending() {
      return queue.size;
    },
    async enqueue(id) {
      queue.set(id.toHexString(), id);
    },
    async flush(f = {}) {
      const ids = [...queue.values()];
      queue.clear();
      let docs: Rec[] = [];
      try {
        if (ids.length > 0) docs = (await o.collection.find({ _id: { $in: ids } }, { projection }).toArray()) as Rec[];
        if (f.backfill && o.runId !== undefined) {
          const more = (await o.collection
            .find({ run_id: o.runId, closed_at: { $ne: null }, embedding: { $not: { $type: "array" } } }, { limit: BACKFILL_MAX, projection })
            .toArray()) as Rec[];
          const seen = new Set(docs.map((d) => d._id.toHexString()));
          for (const d of more) if (!seen.has(d._id.toHexString())) docs.push(d);
        }
      } catch (e) {
        o.log?.(`embed: could not read records (${e instanceof Error ? e.message : String(e)})`.slice(0, 300));
        return;
      }
      docs = docs.filter((d) => d.closed_at !== null && d.closed_at !== undefined);
      if (docs.length === 0) return;
      const texts = docs.map((d) => embeddingText(d));
      const t0 = Date.now();
      let vectors: number[][];
      try {
        vectors = await o.embedder.embed(texts, "document");
        if (vectors.length !== docs.length) throw new Error(`expected ${docs.length} vectors, got ${vectors.length}`);
      } catch (e) {
        o.log?.(`embed: ${docs.length} record(s) not embedded (${e instanceof Error ? e.message : String(e)})`.slice(0, 300));
        for (const [i, d] of docs.entries()) {
          try {
            await o.collection.updateOne({ _id: d._id }, { $set: { embedding_text: texts[i], embedding_model: null, embedding: null } });
          } catch {
            // best effort only
          }
        }
        return;
      }
      let written = 0;
      for (const [i, d] of docs.entries()) {
        try {
          await o.collection.updateOne({ _id: d._id }, { $set: { embedding_text: texts[i], embedding_model: o.embedder.model, embedding: vectors[i] } });
          written++;
        } catch (e) {
          o.log?.(`embed: record ${d._id.toHexString()} not written (${e instanceof Error ? e.message : String(e)})`.slice(0, 300));
        }
      }
      o.log?.(
        `embed: ${written}/${docs.length} closed record(s) embedded with ${o.embedder.model} (${vectors[0]?.length ?? 0} dims) in one call, ${Date.now() - t0} ms: ` +
          docs.map((d) => `${d._id.toHexString()} ${d.intent_id ?? "?"}`).join("; "),
      );
    },
  };
}
