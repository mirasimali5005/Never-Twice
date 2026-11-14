// The deterministic investigator (HANDOVER.md §11.2): list by payee since first_dispatch_at minus 60 s, follow pagination to the end,
// return every record. Built first; also the fallback whenever the model path is slow, fails or proposes nothing valid. No model, no clock.
import type { Intent, Investigator, PastInvestigation, ReadOnlyEvidenceTools } from "@nt/contracts";
import { EvidenceCollector, type WitnessEvidence } from "./collector.ts";
import { LIST_PAGE_CAP, LIST_PAGE_MAX, defaultListSince } from "./tools.ts";

export const DETERMINISTIC_HYPOTHESIS = "deterministic plan: list by payee";

export type DeterministicOptions = { pageSize?: number; maxPages?: number };

export async function collectDeterministic(
  it: Intent,
  tools: ReadOnlyEvidenceTools,
  o: DeterministicOptions & { fallbackReason?: string | null } = {},
): Promise<WitnessEvidence> {
  const c = new EvidenceCollector(it, o.maxPages ?? LIST_PAGE_CAP);
  if (o.fallbackReason) c.note("fallback", { from: "llm" }, `model path abandoned: ${o.fallbackReason}`);
  await c.run(tools, "list_provider_payments_by_payee", {
    created_gte: defaultListSince(it).toISOString(),
    limit: o.pageSize ?? LIST_PAGE_MAX,
    all_pages: true,
  });
  return c.result("deterministic", DETERMINISTIC_HYPOTHESIS, o.fallbackReason ?? null);
}

export function createDeterministicInvestigator(o: DeterministicOptions = {}): Omit<Investigator, "collect"> & {
  collect(it: Intent, tools: ReadOnlyEvidenceTools, opts: { timeoutMs: number; recalled?: PastInvestigation[] }): Promise<WitnessEvidence>;
} {
  return {
    kind: "deterministic",
    collect: (it, tools) => collectDeterministic(it, tools, o),
  };
}
