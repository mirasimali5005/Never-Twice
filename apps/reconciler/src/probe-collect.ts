// Evidence for a decision letter (provider notify_letter, CP-LETTER-1; HANDOVER.md §11.4): NotifySim is a tool the system has never
// seen, so its ONLY evidence source is a model-written, canary-admitted generated probe, looked up in the `probes` collection by
// `{tool_id}:{schema_hash}` of the tool AS DESCRIBED NOW. No admitted probe → probe_not_admitted (the caller quarantines with
// PROBE_NOT_ADMITTED). The probe runs with the read key only; its records go to the SAME fixed matcher. Never writes.
import type { Intent } from "@nt/contracts";
import { evidenceSourceFor, executeProbe, toProviderObjects, type ProbeCollection, type ToolDescription } from "@nt/recovery/probes";
import type { Collect, CollectedWithRecall, Logger } from "./ports.ts";

export const PROBE_SINCE_MARGIN_MS = 60_000;

export type ProbeCollectOptions = {
  probes: ProbeCollection;
  tool: ToolDescription;
  baseUrl: string;
  readKey: string;
  timeoutMs?: number;
  log?: Logger | undefined;
};

export function makeProbeCollect(o: ProbeCollectOptions): Collect {
  return async (it: Intent): Promise<CollectedWithRecall> => {
    const src = await evidenceSourceFor(o.probes, o.tool);
    if (src.kind === "NONE") {
      return {
        investigator: "deterministic",
        hypothesis: null,
        steps: [],
        records: [],
        complete: false,
        fallback_reason: null,
        probe_not_admitted: `no admitted probe for ${o.tool.tool_id} at its current schema hash`,
      };
    }
    const since = new Date((it.first_dispatch_at ?? it.created_at).getTime() - PROBE_SINCE_MARGIN_MS).toISOString();
    const ctx = {
      marker: it._id,
      payee_ref: it.payee_ref,
      account: it.frozen_request.account,
      first_dispatch_at: since,
      amount_minor: String(it.amount_minor),
      currency: it.currency,
    };
    const run = await executeProbe(src.spec, ctx, { baseUrl: o.baseUrl, readKey: o.readKey, timeoutMs: o.timeoutMs ?? 5000 });
    const records = run.ok ? toProviderObjects(run.records) : [];
    const summary = run.ok
      ? `admitted probe ${src.spec.tool_id}:${src.spec.schema_hash.slice(0, 12)} ${src.spec.request.method} ${src.spec.request.path}: ${records.length} record(s) in ${run.pages} page(s)`
      : `admitted probe failed: ${run.error}`;
    o.log?.(`${it._id}: ${summary}`);
    return {
      investigator: "deterministic",
      hypothesis: "decision letter: evidence from the admitted generated probe only",
      steps: [{ tool: "admitted_probe", input: { probe_id: `${src.spec.tool_id}:${src.spec.schema_hash}`, path: src.spec.request.path }, summary, record_count: records.length }],
      records,
      complete: run.ok && run.complete,
      fallback_reason: null,
    };
  };
}
