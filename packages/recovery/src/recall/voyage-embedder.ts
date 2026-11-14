// Tier 2, advisory only (HANDOVER.md §3, §5): an Embedder over the Voyage AI REST API with plain fetch. Outside the safety argument:
// nothing here can reach a payment decision. The API key is sent only as the Authorization header and never logged or echoed.
// Measured at build time (2026-11-14, 12:52 local): voyage-3.5-lite returns 1024-dimensional vectors (voyage-4-lite also 1024).
import type { Embedder } from "@nt/contracts";

export const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
export const DEFAULT_VOYAGE_MODEL = "voyage-3.5-lite";
/** The dimension measured for DEFAULT_VOYAGE_MODEL; the vector index `investigation_recall` is created with it. */
export const DEFAULT_VOYAGE_DIMS = 1024;

export type VoyageEmbedderOptions = {
  apiKey: string;
  model?: string;
  dims?: number;
  url?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

type VoyageResponse = { data?: { embedding?: unknown; index?: unknown }[]; model?: unknown };

export function createVoyageEmbedder(o: VoyageEmbedderOptions): Embedder {
  if (!o.apiKey) throw new Error("createVoyageEmbedder: apiKey is required");
  const model = o.model || DEFAULT_VOYAGE_MODEL;
  const dims = o.dims ?? DEFAULT_VOYAGE_DIMS;
  const url = o.url ?? VOYAGE_EMBEDDINGS_URL;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const doFetch = o.fetch ?? fetch;
  return {
    model,
    dims,
    async embed(texts, inputType) {
      if (texts.length === 0) return [];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
          body: JSON.stringify({ input: texts, model, input_type: inputType }),
          signal: ctrl.signal,
        });
      } catch (e) {
        throw new Error(`voyage: request failed: ${e instanceof Error ? e.name === "AbortError" ? `timeout after ${timeoutMs} ms` : e.message : String(e)}`);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`voyage: HTTP ${res.status} ${body}`);
      }
      const j = (await res.json()) as VoyageResponse;
      const data = Array.isArray(j.data) ? [...j.data] : [];
      if (data.length !== texts.length) throw new Error(`voyage: expected ${texts.length} embedding(s), got ${data.length}`);
      data.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
      return data.map((d, i) => {
        const v = d.embedding;
        if (!Array.isArray(v) || !v.every((x) => typeof x === "number")) throw new Error(`voyage: embedding ${i} is not a number array`);
        if (v.length !== dims) throw new Error(`voyage: embedding ${i} has ${v.length} dimensions, expected ${dims} (model ${model})`);
        return v as number[];
      });
    },
  };
}
