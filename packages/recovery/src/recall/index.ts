// @nt/recovery/recall (Tier 2, advisory): Vector Search over past investigations. Never imports @nt/providers; no payment path.
export { createVoyageEmbedder, DEFAULT_VOYAGE_DIMS, DEFAULT_VOYAGE_MODEL, VOYAGE_EMBEDDINGS_URL, type VoyageEmbedderOptions } from "./voyage-embedder.ts";
export {
  createRecall,
  recallPipeline,
  toRecalled,
  RECALL_INDEX,
  RECALL_K,
  RECALL_NUM_CANDIDATES,
  type RecallCollection,
  type RecallOptions,
  type RecalledInvestigation,
  type VectorRecall,
} from "./recall.ts";
export { attemptsSignature, embeddingText, faultSignature, queryText, type ClosedRecordForEmbedding } from "./text.ts";

/** NT_RECALL_ENABLED (default true when VOYAGE_API_KEY is set; "false" or "0" turns it off). */
export function recallEnabled(env: { NT_RECALL_ENABLED?: string | undefined; VOYAGE_API_KEY?: string | undefined }): boolean {
  if (!env.VOYAGE_API_KEY) return false;
  const v = (env.NT_RECALL_ENABLED ?? "").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "off" || v === "no");
}
