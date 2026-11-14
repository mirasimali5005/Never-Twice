// Per-investigation evidence collector. Records enter only from tool return values, de-duplicated by provider object id; every call
// (and every dropped query) is logged as a step. The model never hands a record in: it only names a tool and arguments.
import type { CollectedEvidence, Intent, InvestigationStep, InvestigationTool, ProviderObject, ReadOnlyEvidenceTools } from "@nt/contracts";
import { LIST_PAGE_CAP, TOOL_ARGS, defaultListSince, isInvestigationTool, type ToolArgs } from "./tools.ts";

/** CollectedEvidence plus why the model path was abandoned (null when it was not, or when no model path ran). */
export type WitnessEvidence = CollectedEvidence & { fallback_reason: string | null };

/** dropped: the query never reached a tool (unknown tool or invalid args); otherwise the tool ran and its read failed. */
export type QueryOutcome = { ok: true; record_count: number } | { ok: false; error: string; dropped: boolean };

export class EvidenceCollector {
  readonly #records = new Map<string, ProviderObject>();
  readonly #steps: InvestigationStep[] = [];
  #complete = false;
  readonly #fullWindowSince: number;
  readonly maxPages: number;

  constructor(it: Pick<Intent, "first_dispatch_at" | "created_at">, maxPages: number = LIST_PAGE_CAP) {
    this.#fullWindowSince = defaultListSince(it).getTime();
    this.maxPages = maxPages;
  }

  get recordCount(): number {
    return this.#records.size;
  }

  /** Read-only views for prompts; the collector's own state is never handed out mutable. */
  records(): ProviderObject[] {
    return [...this.#records.values()].map((r) => structuredClone(r));
  }
  steps(): InvestigationStep[] {
    return this.#steps.map((s) => ({ ...s }));
  }

  note(tool: string, input: unknown, summary: string): void {
    this.#steps.push({ tool, input, summary, record_count: 0 });
  }

  #add(rs: readonly ProviderObject[]): void {
    for (const r of rs) if (!this.#records.has(r.id)) this.#records.set(r.id, structuredClone(r));
  }

  /** Validates `{ tool, args }` against the tool schemas and runs it. An unknown tool or invalid args is dropped and noted. Never throws. */
  async run(tools: ReadOnlyEvidenceTools, tool: unknown, args: unknown): Promise<QueryOutcome> {
    if (!isInvestigationTool(tool)) {
      const error = `dropped: unknown tool ${JSON.stringify(String(tool)).slice(0, 80)}`;
      this.note(String(tool).slice(0, 80), args, error);
      return { ok: false, error, dropped: true };
    }
    const parsed = TOOL_ARGS[tool].safeParse(args ?? {});
    if (!parsed.success) {
      const error = `dropped: invalid args (${parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ").slice(0, 200)})`;
      this.note(tool, args, error);
      return { ok: false, error, dropped: true };
    }
    return this.#runValid(tools, tool, parsed.data as never);
  }

  async #runValid<T extends InvestigationTool>(tools: ReadOnlyEvidenceTools, tool: T, args: ToolArgs[T]): Promise<QueryOutcome> {
    try {
      switch (tool) {
        case "get_intent_summary": {
          const s = await tools.get_intent_summary();
          this.#steps.push({ tool, input: args, summary: `intent ${s._id}: ${s.attempts.length} attempt(s)`, record_count: 0 });
          return { ok: true, record_count: 0 };
        }
        case "search_provider_payments": {
          const { records } = await tools.search_provider_payments();
          this.#add(records);
          this.#steps.push({ tool, input: args, summary: `search (lags): ${records.length} record(s)`, record_count: records.length });
          return { ok: true, record_count: records.length };
        }
        case "list_provider_events": {
          if (tools.list_provider_events === undefined) {
            this.note(tool, args, "events: not available on this provider");
            return { ok: true, record_count: 0 };
          }
          const a = args as ToolArgs["list_provider_events"];
          const { events } = await tools.list_provider_events(a.since === undefined ? {} : { since: a.since });
          // Events are corroboration only: they carry no ProviderObject and add nothing to the matcher's input.
          this.#steps.push({ tool, input: args, summary: `events (delayed, unordered): ${events.length}`, record_count: 0 });
          return { ok: true, record_count: 0 };
        }
        case "list_provider_payments_by_payee":
          return await this.#list(tools, args as ToolArgs["list_provider_payments_by_payee"]);
      }
    } catch (e) {
      const error = `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
      this.#steps.push({ tool, input: args, summary: error, record_count: 0 });
      return { ok: false, error, dropped: false };
    }
    return { ok: false, error: "unreachable", dropped: false };
  }

  async #list(tools: ReadOnlyEvidenceTools, a: ToolArgs["list_provider_payments_by_payee"]): Promise<QueryOutcome> {
    const pagesAllowed = a.all_pages === true ? this.maxPages : 1;
    let cursor = a.starting_after;
    let pages = 0;
    let count = 0;
    let lastPage = false;
    let error: string | null = null;
    while (pages < pagesAllowed) {
      try {
        const q: { created_gte?: string; starting_after?: string; limit?: number } = {};
        if (a.created_gte !== undefined) q.created_gte = a.created_gte;
        if (cursor !== undefined) q.starting_after = cursor;
        if (a.limit !== undefined) q.limit = a.limit;
        const page = await tools.list_provider_payments_by_payee(q);
        pages += 1;
        count += page.records.length;
        this.#add(page.records);
        if (!page.has_more || page.next_cursor === null) {
          lastPage = true;
          break;
        }
        cursor = page.next_cursor;
      } catch (e) {
        error = `${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
        break;
      }
    }
    // complete: the strongly consistent list was followed to its last page, from a window that covers the whole send period
    // (no cursor skipping the start, created_gte no later than first_dispatch_at minus the margin).
    const coversWindow =
      a.starting_after === undefined && (a.created_gte === undefined || Date.parse(a.created_gte) <= this.#fullWindowSince);
    if (lastPage && coversWindow) this.#complete = true;
    const tail = error !== null ? `page ${pages + 1} failed: ${error}` : lastPage ? "reached last page" : `stopped after ${pages} page(s), more remain`;
    this.#steps.push({
      tool: "list_provider_payments_by_payee",
      input: a,
      summary: `list by payee (consistent): ${pages} page(s), ${count} record(s), ${tail}`,
      record_count: count,
    });
    return error !== null ? { ok: false, error, dropped: false } : { ok: true, record_count: count };
  }

  result(investigator: "llm" | "deterministic", hypothesis: string | null, fallback_reason: string | null = null): WitnessEvidence {
    return { investigator, hypothesis, steps: this.steps(), records: this.records(), complete: this.#complete, fallback_reason };
  }
}
