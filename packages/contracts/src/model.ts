// Model output, the model client interface and the cli investigator's plan schemas
// (HANDOVER.md §5.1, §13; ARCHITECTURE.md §6.6–6.7). This file names no SDK type.
import { z } from "zod";

// ---------------------------------------------------------------------------------------------------------------- claim extraction

/** HANDOVER.md §13. Deliberately carries no amount to pay, key, payee token or state: the model has no write path to money. */
export const ClaimExtraction = z.object({
  claimant_names: z.array(z.string()),
  booking_refs: z.array(z.string()),
  flight_numbers: z.array(z.string()),
  travel_date: z.string().nullable(),
  passengers_claimed_for: z.array(z.object({ name: z.string(), relation: z.string().nullable() })),
  asserted_delay: z.string().nullable(),
  asserted_cause: z.string().nullable(),
  requested_amount: z.string().nullable(),
  payee_change_request: z.object({ requested: z.boolean(), quote: z.string().nullable() }),
  hardship: z.object({ kind: z.enum(["OVERNIGHT_STRANDED", "MOBILITY_ASSIST", "NONE"]), quote: z.string().nullable() }),
  injection_suspected: z.boolean(),
  language: z.string(),
  notes: z.string(),
});
export type ClaimExtraction = z.infer<typeof ClaimExtraction>;

// ---------------------------------------------------------------------------------------------------------------- model client

export const MODEL_MODES = ["live", "record", "replay"] as const;
export type ModelMode = (typeof MODEL_MODES)[number];
export const MODEL_BACKENDS = ["cli", "sdk"] as const;
export type ModelBackend = (typeof MODEL_BACKENDS)[number];

/** cli failures [ADD-35]; UNSUPPORTED = runTools on the cli backend. */
export const MODEL_FAILURES = [
  "PARSE_NULL",
  "REFUSAL",
  "MAX_TOKENS",
  "RATE_LIMIT",
  "API_ERROR",
  "TIMEOUT",
  "CASSETTE_MISS",
  "CLI_EXIT",
  "INVALID_JSON",
  "SCHEMA_INVALID",
  "UNSUPPORTED",
] as const;
export type ModelFailure = (typeof MODEL_FAILURES)[number];

export type ModelEffort = "low" | "medium";
export type ModelMessage = { role: "user" | "assistant"; content: string };
/** Adapted to the SDK's tool helper inside packages/agents. */
export type ModelTool = { name: string; description: string; inputSchema: z.ZodType; run(input: unknown): Promise<string> };
/** Alias of ModelTool (AGENT_TASKS.md packet A name). */
export type ModelToolDef = ModelTool;

export type ModelParseRequest<T> = {
  promptVersion: string;
  system: string;
  messages: ModelMessage[];
  schema: z.ZodType<T>;
  maxTokens: number;
  effort: ModelEffort;
};
export type ModelParseResult<T> =
  | { ok: true; output: T; requestSha256: string; source: "live" | "cassette" }
  | { ok: false; failure: ModelFailure; detail: string; requestSha256: string };

export type ModelToolRunRequest = {
  promptVersion: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  maxTokens: number;
  effort: ModelEffort;
  timeoutMs: number;
};
export type ModelToolRunResult =
  | { ok: true; finalText: string; toolCalls: { name: string; input: unknown }[] }
  | { ok: false; failure: ModelFailure; detail: string };

/** Implemented in packages/agents by task E1; NT_MODEL_MODE x NT_MODEL_BACKEND, any combination. */
export interface ModelClient {
  readonly mode: ModelMode;
  readonly model: string;
  readonly backend: ModelBackend;
  /** Structured output. request_sha256 = sha256Hex(model + promptVersion + canonicalJson(request)), unchanged and independent of the
   *  backend, so a cassette recorded with one backend replays under the other.
   *  cli: spawn `claude -p` (flags checked with `claude --help` at build time; never guessed), no tools, system + messages + the JSON
   *  schema rendered into the prompt on stdin, `--output-format json`, reply = the `result` field, which must be one JSON object;
   *  Zod-validated. sdk: messages.parse with zodOutputFormat. live: call the backend. record: call, then store the response under
   *  NT_MODEL_CASSETTE_DIR/<request_sha256>.json. replay: serve the stored response; a miss is { ok: false, failure: "CASSETTE_MISS" }
   *  and is never answered by a live call. */
  parse<T>(req: ModelParseRequest<T>): Promise<ModelParseResult<T>>;
  /** Tool loop, sdk backend only (cli returns UNSUPPORTED). Tool inputs differ per run (markers), so replay normally misses; a miss
   *  returns CASSETTE_MISS and the caller falls back [ADD-14]. */
  runTools(req: ModelToolRunRequest): Promise<ModelToolRunResult>;
}

/** Cassette file under NT_MODEL_CASSETTE_DIR/<request_sha256>.json. Model failures never touch a reserved payment. */
export const Cassette = z.object({
  request_sha256: z.string(),
  model: z.string(),
  prompt_version: z.string(),
  recorded_at: z.string(),
  response: z.unknown(),
});
export type Cassette = z.infer<typeof Cassette>;

// ---------------------------------------------------------------------------------------------------------------- cli investigator plan

/** cli investigator, call 1 and optional call 2 (HANDOVER.md §5.1). Field names beyond { hypothesis, queries: [{ tool, args }] } are [ADD-35]. */
export const INVESTIGATION_TOOLS = ["get_intent_summary", "list_provider_payments_by_payee", "search_provider_payments", "list_provider_events"] as const;
export const InvestigationTool = z.enum(INVESTIGATION_TOOLS);
export type InvestigationTool = z.infer<typeof InvestigationTool>;
/** args are re-validated per tool by fixed code. */
export const InvestigationQuery = z.object({ tool: InvestigationTool, args: z.record(z.string(), z.unknown()) }).strict();
export type InvestigationQuery = z.infer<typeof InvestigationQuery>;
export const InvestigationPlan = z.object({ hypothesis: z.string().max(200), queries: z.array(InvestigationQuery).min(1).max(4) }).strict();
export type InvestigationPlan = z.infer<typeof InvestigationPlan>;
export const InvestigationFollowUp = z.object({ queries: z.array(InvestigationQuery).max(2) }).strict();
export type InvestigationFollowUp = z.infer<typeof InvestigationFollowUp>;
