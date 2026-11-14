// Evidence collection for one intent (HANDOVER.md §11.2): the model-driven investigator with the deterministic fallback after
// NT_INVESTIGATOR_TIMEOUT_MS, or the deterministic investigator only (NT_RECONCILER_INVESTIGATOR=deterministic). Provider access is the
// gateway's read-only view; this module never imports @nt/providers and holds no write path.
import type { Intent, ModelClient, ProviderId } from "@nt/contracts";
import { collectDeterministic, createInvestigator, createReadOnlyEvidenceTools, type WitnessEvidence, type WitnessInvestigator } from "@nt/recovery/investigator";
import type { Collect, ReconcilerGateway } from "./ports.ts";

export type CollectMode = "llm" | "deterministic";

export type MakeCollectOptions = {
  gateway: Pick<ReconcilerGateway, "readOnlyProviderView">;
  mode: CollectMode;
  model?: ModelClient | undefined;
  timeoutMs: number;
  /** Extra time after timeoutMs before the reconciler itself abandons a model path that ignored its own timeout. */
  graceMs?: number;
};

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
    // The model path abandons itself at timeoutMs and answers deterministically; this outer guard covers a path that throws or hangs.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hardStop = new Promise<{ ok: false; reason: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: `TIMEOUT: no evidence within ${o.timeoutMs + graceMs} ms (reconciler guard)` }), o.timeoutMs + graceMs);
    });
    try {
      const res = await Promise.race([
        investigatorFor(it.provider, "llm")
          .collectFor(it, { timeoutMs: o.timeoutMs })
          .then((ev) => ({ ok: true as const, ev }))
          .catch((e: unknown) => ({ ok: false as const, reason: `ERROR: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) })),
        hardStop,
      ]);
      if (res.ok) return res.ev;
      return deterministic(it, res.reason);
    } finally {
      clearTimeout(timer);
    }
  };
}
