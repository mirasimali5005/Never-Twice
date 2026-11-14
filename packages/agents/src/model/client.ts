// createModelClient(env): the @nt/contracts ModelClient, NT_MODEL_MODE x NT_MODEL_BACKEND (HANDOVER.md §5.1, §5.2).
// No retry loop here: the caller retries a failed step once. Failures are returned as values.
import { z } from "zod";
import type {
  ModelBackend,
  ModelClient,
  ModelMode,
  ModelParseRequest,
  ModelParseResult,
  ModelToolRunRequest,
  ModelToolRunResult,
} from "@nt/contracts";
import { canonicalJson, sha256Hex } from "@nt/contracts";
import { CassetteStore, requestSha256 } from "./cassette.ts";
import { extractJsonObject, runClaude, type CliOptions } from "./cli-backend.ts";
import { sdkParse, sdkRunTools } from "./sdk-backend.ts";

/** The model-related variables of HANDOVER.md §5.2. Empty strings count as unset. */
export type ModelEnv = {
  NT_MODEL?: string | undefined;
  NT_MODEL_MODE?: string | undefined;
  NT_MODEL_BACKEND?: string | undefined;
  NT_MODEL_CASSETTE_DIR?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
};

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_CASSETTE_DIR = "fixtures/cassettes";

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v === "" ? undefined : v);

export type CreateModelClientOptions = Pick<CliOptions, "claudeBin" | "timeoutMs" | "parentEnv" | "cwd">;

/** Throws on a malformed mode or backend: that is a programmer or configuration error, not a model failure. */
export function createModelClient(env: ModelEnv, opts: CreateModelClientOptions = {}): ModelClient {
  const mode = (nonEmpty(env.NT_MODEL_MODE) ?? "live") as ModelMode;
  const backend = (nonEmpty(env.NT_MODEL_BACKEND) ?? "cli") as ModelBackend;
  if (mode !== "live" && mode !== "record" && mode !== "replay") throw new Error(`NT_MODEL_MODE must be live, record or replay (got "${mode}")`);
  if (backend !== "cli" && backend !== "sdk") throw new Error(`NT_MODEL_BACKEND must be cli or sdk (got "${backend}")`);
  const model = nonEmpty(env.NT_MODEL) ?? DEFAULT_MODEL;
  const store = new CassetteStore(nonEmpty(env.NT_MODEL_CASSETTE_DIR) ?? DEFAULT_CASSETTE_DIR);

  function schemaName(schema: z.ZodType): string {
    try {
      return `zod:${sha256Hex(canonicalJsonLoose(z.toJSONSchema(schema)))}`;
    } catch {
      return "zod:unrenderable";
    }
  }

  async function callBackend<T>(req: ModelParseRequest<T>, sha: string): Promise<ModelParseResult<T>> {
    let value: unknown;
    if (backend === "cli") {
      const raw = await runClaude(renderCliPrompt(req), model, req.effort, opts);
      if (!raw.ok) return { ok: false, failure: raw.failure, detail: raw.detail, requestSha256: sha };
      const obj = extractJsonObject(raw.text);
      if (!obj.ok) return { ok: false, failure: "INVALID_JSON", detail: obj.detail, requestSha256: sha };
      value = obj.value;
    } else {
      value = await sdkParse(model, req); // stub: throws "sdk backend not configured"
    }
    const parsed = req.schema.safeParse(value);
    if (!parsed.success) return { ok: false, failure: "SCHEMA_INVALID", detail: describeIssues(parsed.error), requestSha256: sha };
    return { ok: true, output: parsed.data, requestSha256: sha, source: "live" };
  }

  return {
    mode,
    model,
    backend,

    async parse<T>(req: ModelParseRequest<T>): Promise<ModelParseResult<T>> {
      const sha = requestSha256(model, req.promptVersion, {
        kind: "parse",
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        schema_name: schemaName(req.schema),
        effort: req.effort,
        max_tokens: req.maxTokens,
        tool_names: [],
      });

      if (mode === "replay") {
        const r = store.read(sha);
        if (r.kind === "miss") return { ok: false, failure: "CASSETTE_MISS", detail: `replay: ${r.detail} (model=${model}, prompt_version=${req.promptVersion})`, requestSha256: sha };
        if (r.kind === "corrupt") return { ok: false, failure: "SCHEMA_INVALID", detail: `replay: ${r.detail}`, requestSha256: sha };
        const resp = r.cassette.response as { parsed_output?: unknown } | null;
        const parsed = req.schema.safeParse(resp?.parsed_output);
        if (!parsed.success) return { ok: false, failure: "SCHEMA_INVALID", detail: `replay: stored output no longer matches the schema: ${describeIssues(parsed.error)}`, requestSha256: sha };
        return { ok: true, output: parsed.data, requestSha256: sha, source: "cassette" };
      }

      const result = await callBackend(req, sha);
      if (mode === "record" && result.ok) {
        store.write({
          request_sha256: sha,
          model,
          prompt_version: req.promptVersion,
          recorded_at: new Date().toISOString(),
          response: { parsed_output: result.output },
        });
      }
      return result;
    },

    async runTools(req: ModelToolRunRequest): Promise<ModelToolRunResult> {
      if (backend === "cli") return { ok: false, failure: "UNSUPPORTED", detail: "runTools is not available on the cli backend; use plan-then-execute with parse" };
      if (mode === "replay") return { ok: false, failure: "CASSETTE_MISS", detail: "replay: tool loops are not recorded; fall back to the deterministic investigator" };
      return sdkRunTools(model, req); // stub: throws "sdk backend not configured"
    },
  };
}

/** JSON Schema may hold non-integer numbers, which canonicalJson refuses; hash it by plain stable stringification instead. */
function canonicalJsonLoose(v: unknown): string {
  try {
    return canonicalJson(v);
  } catch {
    return JSON.stringify(v, (_k, val: unknown) =>
      val && typeof val === "object" && !Array.isArray(val)
        ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
        : val,
    );
  }
}

function describeIssues(err: z.ZodError): string {
  return err.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** system + conversation + JSON Schema, on stdin. Claim text stays inside the messages block as data. */
function renderCliPrompt<T>(req: ModelParseRequest<T>): string {
  let schemaText: string;
  try {
    schemaText = JSON.stringify(z.toJSONSchema(req.schema), null, 2);
  } catch {
    schemaText = "(schema could not be rendered; follow the instructions above)";
  }
  const convo = req.messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
  return [
    "<instructions>",
    req.system,
    "</instructions>",
    "",
    "<messages>",
    convo,
    "</messages>",
    "",
    "<output_format>",
    "Reply with exactly one JSON object, no prose and no markdown fence, that validates against this JSON Schema:",
    schemaText,
    "</output_format>",
    "",
  ].join("\n");
}
