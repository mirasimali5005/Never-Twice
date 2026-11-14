// @nt/recovery/investigator (task D3): the Witness investigator. The model contributes a hypothesis and the choice of read-only
// queries; it never contributes a verdict and never types a record. This module never imports @nt/providers and holds no write path.
import type { Intent, Investigator, ModelClient, PastInvestigation, ReadOnlyEvidenceTools } from "@nt/contracts";
import type { WitnessEvidence } from "./collector.ts";
import { collectDeterministic, type DeterministicOptions } from "./deterministic.ts";
import { collectLlm } from "./llm.ts";
import { createReadOnlyEvidenceTools, type ReadOnlyProviderView } from "./tools.ts";

export { EvidenceCollector, type WitnessEvidence, type QueryOutcome } from "./collector.ts";
export { collectDeterministic, createDeterministicInvestigator, DETERMINISTIC_HYPOTHESIS, type DeterministicOptions } from "./deterministic.ts";
export {
  collectLlm,
  FollowUpEnvelope,
  HYPOTHESIS_MAX,
  INVESTIGATOR_PROMPT_VERSION,
  INVESTIGATOR_SYSTEM_PROMPT,
  PlanEnvelope,
  type LlmInvestigatorOptions,
} from "./llm.ts";
export {
  createReadOnlyEvidenceTools,
  defaultListSince,
  intentSummary,
  isInvestigationTool,
  LIST_MARGIN_MS,
  LIST_PAGE_CAP,
  LIST_PAGE_MAX,
  TOOL_ARGS,
  TOOL_CATALOGUE,
  type ProviderEvent,
  type ReadOnlyProviderView,
  type ToolArgs,
} from "./tools.ts";

/** NT_INVESTIGATOR_TIMEOUT_MS default (HANDOVER.md §5.1). */
export const DEFAULT_INVESTIGATOR_TIMEOUT_MS = 45_000;

export type CreateInvestigatorOptions = DeterministicOptions & {
  mode: "llm" | "deterministic";
  /** Read-only provider view used by collectFor(); collect() uses the tools it is given. */
  provider?: ReadOnlyProviderView;
  /** Required for mode "llm". */
  model?: ModelClient;
  /** NT_INVESTIGATOR_TIMEOUT_MS; the model path is abandoned after it and the deterministic investigator answers. */
  timeoutMs?: number;
  /** llm only: make the optional call 2 (default true). */
  followUp?: boolean;
};

/** An Investigator (assignable to the contracts type) whose collect returns WitnessEvidence. */
export type WitnessInvestigator = Omit<Investigator, "collect"> & {
  readonly timeoutMs: number;
  collect(it: Intent, tools: ReadOnlyEvidenceTools, opts: { timeoutMs: number; recalled?: PastInvestigation[] }): Promise<WitnessEvidence>;
  /** Builds the intent-bound read-only tools over `provider` and collects with the configured timeout. */
  collectFor(it: Intent, opts?: { timeoutMs?: number; recalled?: PastInvestigation[] }): Promise<WitnessEvidence>;
};

export function createInvestigator(o: CreateInvestigatorOptions): WitnessInvestigator {
  const timeoutMs = o.timeoutMs ?? DEFAULT_INVESTIGATOR_TIMEOUT_MS;
  const det: DeterministicOptions = {};
  if (o.pageSize !== undefined) det.pageSize = o.pageSize;
  if (o.maxPages !== undefined) det.maxPages = o.maxPages;
  let collect: WitnessInvestigator["collect"];
  if (o.mode === "deterministic") collect = (it, tools) => collectDeterministic(it, tools, det);
  else if (o.mode === "llm") {
    const model = o.model;
    if (model === undefined) throw new Error("createInvestigator: mode llm needs a ModelClient");
    const followUp = o.followUp ?? true;
    collect = (it, tools, opts) => collectLlm(it, tools, opts, { model, followUp, deterministic: det });
  } else throw new Error(`createInvestigator: unknown mode ${String(o.mode)}`);
  return {
    kind: o.mode,
    timeoutMs,
    collect,
    collectFor(it, opts = {}) {
      if (o.provider === undefined) throw new Error("createInvestigator: collectFor needs a provider view");
      const c: { timeoutMs: number; recalled?: PastInvestigation[] } = { timeoutMs: opts.timeoutMs ?? timeoutMs };
      if (opts.recalled !== undefined) c.recalled = opts.recalled;
      return collect(it, createReadOnlyEvidenceTools(it, o.provider), c);
    },
  };
}
