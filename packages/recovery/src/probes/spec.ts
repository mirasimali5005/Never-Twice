// Generated probes (Tier 3, task D4; HANDOVER.md §11.4). A probe is DECLARATIVE: the model writes this JSON, never code.
// Fixed code decides whether it is admitted (admit.ts) and executes it with the read key (run.ts).
import { z } from "zod";
import { canonicalJson, sha256Hex } from "@nt/contracts";

// ------------------------------------------------------------------------------------------------------------- tool description

/** A tool the system has never seen, as described to the probe author (fixtures/tool-descriptions/<tool_id>.json). */
export const ToolDescription = z.object({
  tool_id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  base_url: z.string().optional(),
  auth: z.record(z.string(), z.string()).optional(),
  endpoints: z.array(z.object({ method: z.string(), path: z.string(), auth: z.string(), summary: z.string() })).min(1),
  object_schema: z.record(z.string(), z.string()),
});
export type ToolDescription = z.infer<typeof ToolDescription>;

/** The tool's schema hash: endpoints and object schema (the prose name and description are not part of it). Any change to them
 *  gives a new hash, and an admission is keyed by `{tool_id}:{schema_hash}`, so it no longer applies (PRB-07). */
export function toolSchemaHash(tool: ToolDescription): string {
  return sha256Hex(canonicalJson({ tool_id: tool.tool_id, endpoints: tool.endpoints, object_schema: tool.object_schema }));
}

export function probeId(toolId: string, schemaHash: string): string {
  return `${toolId}:${schemaHash}`;
}

// ------------------------------------------------------------------------------------------------------------- the spec

/** The only values a template may draw on: fields of the intent being investigated. Never claim text, never a model string. */
export const INTENT_TEMPLATE_FIELDS = ["marker", "payee_ref", "account", "first_dispatch_at", "amount_minor", "currency"] as const;
export type IntentTemplateField = (typeof INTENT_TEMPLATE_FIELDS)[number];
/** The values templates are rendered from. `marker` is the intent's _id (its nt_marker). */
export type ProbeContext = Record<IntentTemplateField, string>;

export const ProbePagination = z
  .object({
    cursor_param: z.string().describe("query parameter that receives the cursor, e.g. starting_after"),
    next_path: z.string().describe("JSONPath in the response body to the next cursor, e.g. $.next_cursor; null/absent ends paging"),
    max_pages: z.number().int().describe("upper bound on pages fetched, 1 to 10"),
  })
  .strict();

/** What the probe author writes (one messages.parse per tool). */
export const ProbeDraft = z
  .object({
    request: z
      .object({
        method: z.string().describe("HTTP method"),
        path: z.string().describe("endpoint path, e.g. /v1/..."),
        query: z.record(z.string(), z.string()).describe('query parameters; values may be literals or templates such as "{{payee_ref}}"'),
        credential: z.string().describe('which credential the probe runs with: "read"'),
        headers: z.record(z.string(), z.string()).optional().describe("extra headers (normally none)"),
      })
      .strict(),
    items_path: z.string().describe("JSONPath to the list of objects in the response body, e.g. $.data[*]"),
    marker_path: z.string().nullable().describe("JSONPath, relative to one object, to the marker the caller stored; compared with {{marker}}"),
    pagination: ProbePagination.nullable(),
  })
  .strict();
export type ProbeDraft = z.infer<typeof ProbeDraft>;

/** A complete spec: the draft plus the tool identity, which fixed code fills in from the tool description. */
export const ProbeSpec = ProbeDraft.extend({ tool_id: z.string(), schema_hash: z.string() }).strict();
export type ProbeSpec = z.infer<typeof ProbeSpec>;

export function completeSpec(draft: ProbeDraft, tool: ToolDescription): ProbeSpec {
  return { tool_id: tool.tool_id, schema_hash: toolSchemaHash(tool), ...draft };
}

// ------------------------------------------------------------------------------------------------------------- templates

const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Every template name used in a string. */
export function templateNames(s: string): string[] {
  return [...s.matchAll(TEMPLATE)].map((m) => m[1]!);
}

export function isIntentField(name: string): name is IntentTemplateField {
  return (INTENT_TEMPLATE_FIELDS as readonly string[]).includes(name);
}

/** Render "{{field}}" from the context. Throws on a non-intent field (static admission rejects those first). */
export function renderTemplate(s: string, ctx: ProbeContext): string {
  return s.replace(TEMPLATE, (_m, name: string) => {
    if (!isIntentField(name)) throw new Error(`template {{${name}}} is not an intent field`);
    return ctx[name];
  });
}

// ------------------------------------------------------------------------------------------------------------- JSONPath subset

type Seg = { kind: "key"; key: string } | { kind: "all" } | { kind: "index"; i: number };

/** The JSONPath subset a probe may use: $ then .name, ['name'], [*] or [n]. Returns null when the path is not in the subset. */
export function parsePath(path: string): Seg[] | null {
  if (!path.startsWith("$")) return null;
  const segs: Seg[] = [];
  let i = 1;
  while (i < path.length) {
    const rest = path.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(rest))) segs.push({ kind: "key", key: m[1]! });
    else if ((m = /^\[\*\]/.exec(rest))) segs.push({ kind: "all" });
    else if ((m = /^\[(\d{1,4})\]/.exec(rest))) segs.push({ kind: "index", i: Number(m[1]) });
    else if ((m = /^\['([A-Za-z0-9_.-]+)'\]/.exec(rest))) segs.push({ kind: "key", key: m[1]! });
    else return null;
    i += m[0].length;
  }
  return segs;
}

/** All values the path selects (an empty list when nothing matches). Throws on a path outside the subset. */
export function evalPath(value: unknown, path: string): unknown[] {
  const segs = parsePath(path);
  if (segs === null) throw new Error(`unsupported JSONPath ${path}`);
  let cur: unknown[] = [value];
  for (const s of segs) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (s.kind === "key") {
        if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v, s.key)) next.push((v as Record<string, unknown>)[s.key]);
      } else if (s.kind === "all") {
        if (Array.isArray(v)) next.push(...v);
      } else if (Array.isArray(v) && s.i < v.length) {
        next.push(v[s.i]);
      }
    }
    cur = next;
  }
  return cur;
}
