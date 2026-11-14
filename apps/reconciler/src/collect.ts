// Evidence collection for one intent (HANDOVER.md §11.2): the model-driven investigator with the deterministic fallback after
// NT_INVESTIGATOR_TIMEOUT_MS, or the deterministic investigator only (NT_RECONCILER_INVESTIGATOR=deterministic). Provider access is the
// gateway's read-only view; this module never imports @nt/providers and holds no write path.
import type { Intent, ModelClient, ProviderId } from "@nt/contracts";
import { collectDeterministic, createInvestigator, createReadOnlyEvidenceTools, type WitnessEvidence, type WitnessInvestigator } from "@nt/recovery/investigator";
import type { RecalledInvestigation } from "@nt/recovery/recall";
import type { Collect, CollectedWithRecall, Logger, ReconcilerGateway } from "./ports.ts";

export type CollectMode = "llm" | "deterministic";

export type MakeCollectOptions = {
  gateway: Pick<ReconcilerGateway, "readOnlyProviderView">;
  mode: CollectMode;
  model?: ModelClient | undefined;
  timeoutMs: number;
  /** Extra time after timeoutMs before the reconciler itself abandons a model path that ignored its own timeout. */
  graceMs?: number;
  /**
   * Tier 2 (advisory): Vector Search over past investigations. Consulted only on the LLM path, before the model's first call; its
   * time counts against timeoutMs. It returns [] on any failure; a throw is caught here too. The deterministic path never uses it.
   */
  recall?: { similar(it: Intent, k: number): Promise<RecalledInvestigation[]> } | undefined;
  /** How many past records to show (default 3). */
  recallK?: number;
  log?: Logger | undefined;
};

/** The model path is always given at least this long after recall, whatever recall cost. */
const MIN_MODEL_BUDGET_MS = 1_000;

/** Rails whose evidence never goes through the model (AGENT_TASKS.md D2: no investigator tool may hold a Stripe key). */
const DETERMINISTIC_ONLY: ReadonlySet<ProviderId> = new Set<ProviderId>(["stripe_refund"]);

export function makeCollect(o: MakeCollectOptions): Collect {
  const graceMs = o.graceMs ?? 2_000;
  const cache = new Map<string, WitnessInvestigator>();
  const investigatorFor = (provider: ProviderId, mode: CollectMode): WitnessInvestigator => {
    const k = `${provider}:${mode}`;
    let inv = cache.get(k);
    if (!inv) {
      inv = createInvestigator({ mode, provider: o.gateway.readOnlyProviderView(provider), model: o.model, timeoutMs: o.timeoutMs });
      cache.set(k, inv);
    }
    return inv;
  };

  const deterministic = (it: Intent, reason: string | null): Promise<WitnessEvidence> =>
    collectDeterministic(it, createReadOnlyEvidenceTools(it, o.gateway.readOnlyProviderView(it.provider)), { fallbackReason: reason });

  return async (it) => {
    const useLlm = o.mode === "llm" && o.model !== undefined && !DETERMINISTIC_ONLY.has(it.provider);
    if (!useLlm) {
      const why = o.mode === "llm" && o.model === undefined ? "no model client configured" : null;
      return deterministic(it, why);
    }
    // Tier 2 recall: advisory context for the model's plan. Failure → no context, never a blocked investigation.
    let recalled: RecalledInvestigation[] = [];
    let budgetMs = o.timeoutMs;
    if (o.recall !== undefined) {
      const t0 = Date.now();
      try {
        recalled = await o.recall.similar(it, o.recallK ?? 3);
      } catch (e) {
        o.log?.(`recall: no context for ${it._id} (${e instanceof Error ? e.message : String(e)})`.slice(0, 300));
        recalled = [];
      }
      const spent = Date.now() - t0;
      budgetMs = Math.max(MIN_MODEL_BUDGET_MS, o.timeoutMs - spent);
      o.log?.(
        `recall: ${recalled.length} past investigation(s) for ${it._id} in ${spent} ms` +
          (recalled.length > 0 ? `: ${recalled.map((r) => `${r.id} ${r.match}/${r.decision_kind} found_by=[${r.evidence_queries.join(",")}] score=${r.score.toFixed(3)}`).join("; ")}` : ""),
      );
    }
    const withRecall = (ev: WitnessEvidence): CollectedWithRecall => (o.recall !== undefined ? { ...ev, recalled: recalled.map((r) => r.id) } : ev);
    // The model path abandons itself at timeoutMs and answers deterministically; this outer guard covers a path that throws or hangs.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hardStop = new Promise<{ ok: false; reason: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: `TIMEOUT: no evidence within ${budgetMs + graceMs} ms (reconciler guard)` }), budgetMs + graceMs);
    });
    try {
      const res = await Promise.race([
        investigatorFor(it.provider, "llm")
          .collectFor(it, recalled.length > 0 ? { timeoutMs: budgetMs, recalled } : { timeoutMs: budgetMs })
          .then((ev) => ({ ok: true as const, ev }))
          .catch((e: unknown) => ({ ok: false as const, reason: `ERROR: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) })),
        hardStop,
      ]);
      if (res.ok) return withRecall(res.ev);
      return withRecall(await deterministic(it, res.reason));
    } finally {
      clearTimeout(timer);
    }
  };
}
