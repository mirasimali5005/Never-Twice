// Texts embedded for Vector Search over past investigations (Tier 2, advisory; ARCHITECTURE.md §4.7, ADD-33). Pure functions.
// The stored record's text and the lookup's query text share their leading fields (provider, rail, fault) so that a new
// investigation lands near past ones with the same provider and first-send failure.
import type { Intent } from "@nt/contracts";

/** The first-send (and any later) attempt results, normalised: "INDETERMINATE:TIMEOUT", "NO_RESULT" for a send with no response. */
export function attemptsSignature(it: Pick<Intent, "attempts">): string {
  if (it.attempts.length === 0) return "NONE";
  return it.attempts
    .map((a) => {
      const r = a.result;
      if (r === null) return "NO_RESULT";
      const why = r.cause ?? r.code;
      return why ? `${r.kind}:${why}` : r.kind;
    })
    .join(",");
}

/** fault_signature stored on a closed record: provider, normalised attempt results, matcher result. */
export function faultSignature(it: Pick<Intent, "provider" | "attempts">, match: string): string {
  return `${it.provider}|attempts:${attemptsSignature(it)}|match:${match}`;
}

/** The fields of a closed investigation_records document the embedding text is built from. */
export type ClosedRecordForEmbedding = {
  hypothesis?: string | null;
  provider?: string | null;
  rail?: string | null;
  fault_signature?: string | null;
  evidence_queries?: string[] | null;
  steps?: { tool: string; record_count: number }[] | null;
  match?: string | null;
  decision?: { kind?: string } | null;
  licence?: string | null;
  investigator?: string | null;
};

/** embedding_text: hypothesis + provider/rail + fault signature + which queries found the evidence + decision. */
export function embeddingText(r: ClosedRecordForEmbedding): string {
  const ran = [...new Set((r.steps ?? []).map((s) => s.tool))];
  const found = r.evidence_queries && r.evidence_queries.length > 0 ? [...new Set(r.evidence_queries)].join(", ") : "none";
  return [
    `provider: ${r.provider ?? "unknown"}`,
    `rail: ${r.rail ?? "none"}`,
    `fault: ${r.fault_signature ?? "unknown"}`,
    `hypothesis: ${(r.hypothesis ?? "none").slice(0, 280)}`,
    `queries run: ${ran.length > 0 ? ran.join(", ") : "none"}`,
    `evidence found by: ${found}`,
    `outcome: ${r.match ?? "unknown"}, ${r.decision?.kind ?? "unknown"}${r.licence ? ` (${r.licence})` : ""}`,
    `investigator: ${r.investigator ?? "unknown"}`,
  ].join(" | ");
}

/** The lookup text for an intent about to be investigated: what is known before any query runs. */
export function queryText(it: Pick<Intent, "provider" | "attempts" | "frozen_request">): string {
  return [
    `provider: ${it.provider}`,
    `rail: ${it.frozen_request.rail ?? "none"}`,
    `fault: ${it.provider}|attempts:${attemptsSignature(it)}`,
    `attempts: ${it.attempts.length}`,
  ].join(" | ");
}
