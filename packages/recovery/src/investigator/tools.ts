// The four read-only evidence tools of HANDOVER.md §11.2, bound to one intent (ARCHITECTURE.md §6.7, [ADD-13]).
// They read through an injected read-only provider view: never @nt/providers, never createPaymentOrRefund. The account, the payee
// and the marker come from the intent when the tools are created; nothing the model supplies can change them.
import { z } from "zod";
import { INVESTIGATION_TOOLS } from "@nt/contracts";
import type { Intent, IntentSummary, InvestigationTool, PaymentProvider, ProviderObject, ProviderPage, ReadOnlyEvidenceTools } from "@nt/contracts";

export type ProviderEvent = { type: string; object_id: string; at: string };

/**
 * The read-only slice of a provider the investigator may hold. The three required methods are the contracts' PaymentProvider read
 * methods, so a PaymentProvider satisfies it structurally; createPaymentOrRefund is not part of it and is never copied into the tools.
 * The two optional methods map the simulator's lagging search (`GET /v1/search/payouts`) and its event log (`GET /v1/events`, Tier 2);
 * a provider without them makes the matching tool return [] (which is never evidence of absence).
 */
export type ReadOnlyProviderView = Pick<PaymentProvider, "getOperation" | "findOperationEvidence" | "listOperations"> & {
  searchOperations?(q: { account: string; marker: string }): Promise<ProviderObject[]>;
  listEvents?(q: { account: string; since?: Date }): Promise<ProviderEvent[]>;
};

/** Window margin before first_dispatch_at for the by-payee list (AGENT_TASKS.md D3). */
export const LIST_MARGIN_MS = 60_000;
export const LIST_PAGE_MAX = 100;
/** Cap on pages followed by one `all_pages` query (AGENT_TASKS.md D3). */
export const LIST_PAGE_CAP = 50;

/** Where the by-payee list starts when the caller names no window: first_dispatch_at (or created_at) minus the margin. */
export function defaultListSince(it: Pick<Intent, "first_dispatch_at" | "created_at">): Date {
  const base = it.first_dispatch_at ?? it.created_at;
  return new Date(base.getTime() - LIST_MARGIN_MS);
}

const IsoDateTime = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date-time");

/** Per-tool argument schemas. Fixed code re-validates every model-proposed query against these (HANDOVER.md §5.1). */
export const TOOL_ARGS = {
  get_intent_summary: z.object({}).strict(),
  list_provider_payments_by_payee: z
    .object({
      created_gte: IsoDateTime.optional(),
      starting_after: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(LIST_PAGE_MAX).optional(),
      all_pages: z.boolean().optional(),
    })
    .strict(),
  search_provider_payments: z.object({}).strict(),
  list_provider_events: z.object({ since: IsoDateTime.optional() }).strict(),
} as const satisfies Record<InvestigationTool, z.ZodType>;
export type ToolArgs = { [K in InvestigationTool]: z.infer<(typeof TOOL_ARGS)[K]> };

/** The catalogue the model sees: names, arguments and caveats. No key, no account, no URL. */
export const TOOL_CATALOGUE: readonly { name: InvestigationTool; args: string; description: string }[] = [
  {
    name: "get_intent_summary",
    args: "{}",
    description: "The intent's own record: marker, rail, amount, currency, payee token, send times, attempts. No secrets.",
  },
  {
    name: "list_provider_payments_by_payee",
    args: '{ created_gte?: ISO date-time, starting_after?: object id (cursor), limit?: 1..100, all_pages?: boolean }',
    description:
      "The provider's list endpoint for this intent's account and payee. Strongly consistent and paginated: one page per call " +
      "unless all_pages is true (follows next_cursor, at most 50 pages). The reliable path.",
  },
  {
    name: "search_provider_payments",
    args: "{}",
    description:
      "The provider's search endpoint for this intent's marker. It LAGS: objects created in the last few seconds are missing. " +
      "An empty search proves nothing.",
  },
  {
    name: "list_provider_events",
    args: "{ since?: ISO date-time }",
    description: "The provider's event log (Tier 2). Delayed and unordered; corroboration only. May be empty if the provider has none.",
  },
];

export function isInvestigationTool(name: unknown): name is InvestigationTool {
  return typeof name === "string" && (INVESTIGATION_TOOLS as readonly string[]).includes(name);
}

export function intentSummary(it: Intent): IntentSummary {
  return {
    _id: it._id,
    provider: it.provider,
    rail: it.frozen_request.rail,
    amount_minor: it.amount_minor,
    currency: it.currency,
    payee_ref: it.payee_ref,
    first_dispatch_at: it.first_dispatch_at,
    last_send_at: it.last_send_at,
    attempts: it.attempts.map((a) => ({ n: a.n, at: a.at, licence: a.licence, result: a.result })),
  };
}

/**
 * Builds the four tools for one intent over a read-only provider view. Only the read methods are captured (bound), so the
 * returned object holds no reference through which a write could be reached. Every tool returns provider objects as the
 * provider returned them; nothing here builds a record from model text.
 */
export function createReadOnlyEvidenceTools(it: Intent, provider: ReadOnlyProviderView): ReadOnlyEvidenceTools {
  const account = it.frozen_request.account;
  const payee = it.payee_ref;
  const marker = it._id;
  const listOperations = provider.listOperations.bind(provider);
  const search = provider.searchOperations?.bind(provider);
  const events = provider.listEvents?.bind(provider);
  const fallbackSince = defaultListSince(it);

  const tools: ReadOnlyEvidenceTools = {
    async get_intent_summary() {
      return intentSummary(it);
    },

    async list_provider_payments_by_payee(q) {
      const since = q.created_gte !== undefined ? new Date(q.created_gte) : fallbackSince;
      if (Number.isNaN(since.getTime())) throw new Error("created_gte is not a date-time");
      const limit = Math.min(LIST_PAGE_MAX, Math.max(1, Math.trunc(q.limit ?? LIST_PAGE_MAX)));
      let pastCursor = q.starting_after === undefined;
      const records: ProviderObject[] = [];
      let hasMore = false;
      for await (const o of listOperations({ account, since })) {
        if (o.payee_ref !== payee) continue;
        if (!pastCursor) {
          if (o.id === q.starting_after) pastCursor = true;
          continue;
        }
        if (records.length === limit) {
          hasMore = true;
          break;
        }
        records.push(o);
      }
      // A cursor that never appeared must not read as "last page reached".
      if (!pastCursor) throw new Error(`cursor ${q.starting_after} not found in the list`);
      const page: ProviderPage = { records, has_more: hasMore, next_cursor: hasMore ? records[records.length - 1]!.id : null };
      return page;
    },

    async search_provider_payments() {
      if (search === undefined) return { records: [] };
      return { records: await search({ account, marker }) };
    },

    async list_provider_events(q) {
      if (events === undefined) return { events: [] };
      const since = q.since !== undefined ? new Date(q.since) : undefined;
      return { events: await events(since === undefined ? { account } : { account, since }) };
    },
  };
  return Object.freeze(tools);
}
