// Environment schema and role-scoped loading (HANDOVER.md §5.2; ARCHITECTURE.md §6.8, [ADD-16]).
// The simulator and the evaluator validate their own variables in their own code; neither imports this schema.
// No role reads NT_SIM_EVAL_READ_KEY or any EVAL_* variable.
import { z } from "zod";
import { RunId } from "./identity.ts";
import { Arm } from "./reasons.ts";

const ms = (dflt: number) => z.coerce.number().int().positive().default(dflt);
const mongoUri = z.string().regex(/^mongodb(\+srv)?:\/\//);
export const STRIPE_TEST_KEY_RE = /^(sk|rk)_test_/;

const ENV_SHAPE = {
  NT_ENV: z.enum(["local", "sandbox"]),
  NT_MONGODB_URI: mongoUri,
  NT_MONGODB_URI_GATEWAY: mongoUri.optional(), // each role URI defaults to NT_MONGODB_URI
  NT_MONGODB_URI_AGENT: mongoUri.optional(),
  NT_MONGODB_URI_INVESTIGATOR: mongoUri.optional(),
  NT_MONGODB_URI_DESK: mongoUri.optional(),
  NT_DB_NAME: z.string().min(1).default("never_twice"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(), // only with NT_MODEL_BACKEND=sdk; not needed by the default cli backend
  NT_MODEL_BACKEND: z.enum(["cli", "sdk"]).default("cli"),
  NT_MODEL: z.string().min(1), // default is the id frozen in HANDOVER.md §5; never with a date suffix
  NT_MODEL_MODE: z.enum(["live", "record", "replay"]),
  NT_MODEL_CASSETTE_DIR: z.string().default("fixtures/cassettes"),
  NT_SIM_URL: z.string().url().default("http://127.0.0.1:4010"),
  NT_SIM_WRITE_KEY: z.string().min(1).optional(),
  NT_SIM_READ_KEY: z.string().min(1).optional(),
  NT_SIM_ADMIN_KEY: z.string().min(1).optional(),
  NT_STRIPE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  STRIPE_SECRET_KEY: z.string().regex(STRIPE_TEST_KEY_RE).optional(), // any other value: the process exits at start
  NT_RUN_ID: RunId.optional(),
  NT_ARM: Arm.optional(),
  NT_CRASH_AT: z
    .string()
    .regex(/^(BR|CTRL)_[A-Z_]+(:\d+|@[A-Z0-9._-]+)$/)
    .optional(),
  NT_MUTATION: z.enum(["M1", "M2", "M3", "M4", "M5"]).optional(),
  NT_LEASE_MS: ms(8000),
  NT_DISPATCH_TIMEOUT_MS: ms(3000),
  NT_RECONCILE_INTERVAL_MS: ms(1000),
  NT_KEY_MARGIN_MS: ms(60000),
  VOYAGE_API_KEY: z.string().min(1).optional(), // Tier 2 embeddings; absent → recall and claim triage are off
  NT_INVESTIGATOR_TIMEOUT_MS: ms(45000), // reconciler; lease on OUTCOME_UNKNOWN = this + NT_DISPATCH_TIMEOUT_MS + NT_LEASE_MS
};

type EnvOut = z.output<z.ZodObject<typeof ENV_SHAPE>>;
type IssueSink = { addIssue(issue: { code: "custom"; message: string; path?: PropertyKey[] }): void };

/** The cross-field invariants of ARCHITECTURE.md §6.8, applied to whichever of the fields a schema holds. */
function checkInvariants(e: Partial<EnvOut>, ctx: IssueSink): void {
  if (e.NT_DISPATCH_TIMEOUT_MS !== undefined && e.NT_LEASE_MS !== undefined && e.NT_DISPATCH_TIMEOUT_MS >= e.NT_LEASE_MS) {
    ctx.addIssue({ code: "custom", message: "invariant: NT_DISPATCH_TIMEOUT_MS < NT_LEASE_MS", path: ["NT_DISPATCH_TIMEOUT_MS"] });
  }
  if (e.NT_STRIPE_ENABLED === true && !e.STRIPE_SECRET_KEY) {
    ctx.addIssue({ code: "custom", message: "NT_STRIPE_ENABLED needs a test-mode STRIPE_SECRET_KEY", path: ["STRIPE_SECRET_KEY"] });
  }
  if (e.NT_MODEL_BACKEND === "sdk" && e.NT_MODEL_MODE !== undefined && e.NT_MODEL_MODE !== "replay" && !e.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: "custom", message: "NT_MODEL_BACKEND=sdk needs ANTHROPIC_API_KEY unless NT_MODEL_MODE=replay", path: ["ANTHROPIC_API_KEY"] });
  }
  if (e.NT_MUTATION && e.NT_ARM !== "nt_mutant") {
    ctx.addIssue({ code: "custom", message: "NT_MUTATION is accepted only for arm nt_mutant", path: ["NT_MUTATION"] });
  }
}

/** Every variable, unscoped (ARCHITECTURE.md §6.8 verbatim, plus paths on the refinement issues). */
export const EnvSchema = z.object(ENV_SHAPE).superRefine(checkInvariants);
export type Env = z.output<typeof EnvSchema>;

export type Role = "runner" | "reconciler" | "desk-api" | "script";
export const ROLES = ["runner", "reconciler", "desk-api", "script"] as const satisfies readonly Role[];

const base = z.object(ENV_SHAPE);
const requiredKey = z.string().min(1);

const MODEL_KEYS = { NT_MODEL: true, NT_MODEL_MODE: true, NT_MODEL_BACKEND: true, NT_MODEL_CASSETTE_DIR: true, ANTHROPIC_API_KEY: true } as const;
const TIMING_KEYS = { NT_LEASE_MS: true, NT_DISPATCH_TIMEOUT_MS: true, NT_RECONCILE_INTERVAL_MS: true, NT_KEY_MARGIN_MS: true } as const;
const COMMON_KEYS = { NT_ENV: true, NT_MONGODB_URI: true, NT_DB_NAME: true, NT_SIM_URL: true } as const;
const STRIPE_KEYS = { NT_STRIPE_ENABLED: true, STRIPE_SECRET_KEY: true } as const;
const TEST_HOOK_KEYS = { NT_CRASH_AT: true, NT_MUTATION: true } as const;

const runnerSchema = base
  .pick({ ...COMMON_KEYS, ...MODEL_KEYS, ...TIMING_KEYS, ...STRIPE_KEYS, ...TEST_HOOK_KEYS, NT_MONGODB_URI_AGENT: true, NT_MONGODB_URI_GATEWAY: true, VOYAGE_API_KEY: true })
  .extend({ NT_RUN_ID: RunId, NT_ARM: Arm, NT_SIM_WRITE_KEY: requiredKey })
  .superRefine(checkInvariants)
  .transform((e) => ({
    ...e,
    NT_MONGODB_URI_AGENT: e.NT_MONGODB_URI_AGENT ?? e.NT_MONGODB_URI,
    NT_MONGODB_URI_GATEWAY: e.NT_MONGODB_URI_GATEWAY ?? e.NT_MONGODB_URI,
  }));

const reconcilerSchema = base
  .pick({
    ...COMMON_KEYS,
    ...MODEL_KEYS,
    ...TIMING_KEYS,
    ...STRIPE_KEYS,
    ...TEST_HOOK_KEYS,
    NT_MONGODB_URI_GATEWAY: true,
    NT_MONGODB_URI_INVESTIGATOR: true,
    NT_INVESTIGATOR_TIMEOUT_MS: true,
    VOYAGE_API_KEY: true,
  })
  .extend({ NT_RUN_ID: RunId, NT_ARM: Arm, NT_SIM_WRITE_KEY: requiredKey, NT_SIM_READ_KEY: requiredKey })
  .superRefine(checkInvariants)
  .transform((e) => ({
    ...e,
    NT_MONGODB_URI_GATEWAY: e.NT_MONGODB_URI_GATEWAY ?? e.NT_MONGODB_URI,
    NT_MONGODB_URI_INVESTIGATOR: e.NT_MONGODB_URI_INVESTIGATOR ?? e.NT_MONGODB_URI,
  }));

/** desk-api never receives a write key, a Stripe key, a model key or the admin key. */
const deskApiSchema = base
  .pick({ ...COMMON_KEYS, NT_MONGODB_URI_DESK: true })
  .extend({ NT_SIM_READ_KEY: requiredKey })
  .transform(({ NT_MONGODB_URI, NT_MONGODB_URI_DESK, ...rest }) => ({ ...rest, NT_MONGODB_URI_DESK: NT_MONGODB_URI_DESK ?? NT_MONGODB_URI }));

/** Seed, demo and sweep scripts: always the owner NT_MONGODB_URI. */
const scriptSchema = base
  .pick({ ...COMMON_KEYS, ...TIMING_KEYS, ...STRIPE_KEYS, NT_SIM_WRITE_KEY: true, NT_RUN_ID: true, NT_ARM: true })
  .extend({ NT_SIM_ADMIN_KEY: requiredKey })
  .superRefine(checkInvariants);

export const ROLE_ENV_SCHEMAS = {
  runner: runnerSchema,
  reconciler: reconcilerSchema,
  "desk-api": deskApiSchema,
  script: scriptSchema,
} as const;
export type RoleEnv<R extends Role> = z.output<(typeof ROLE_ENV_SCHEMAS)[R]>;

export type EnvParseResult<R extends Role> = { ok: true; env: RoleEnv<R> } | { ok: false; errors: string[] };

/** Validates without exiting. Empty strings count as unset (an `.env` copied from `.env.example` has empty values).
 *  A STRIPE_SECRET_KEY that is present and not a test key fails for every role, even one that does not receive it.
 *  Error lines name the variable and the rule, never the value. */
export function parseEnv<R extends Role>(role: R, source: Record<string, string | undefined> = process.env): EnvParseResult<R> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && v !== "") clean[k] = v;
  const errors: string[] = [];
  const stripe = clean["STRIPE_SECRET_KEY"];
  if (stripe !== undefined && !STRIPE_TEST_KEY_RE.test(stripe)) {
    errors.push("STRIPE_SECRET_KEY: must be a Stripe test-mode key (prefix sk_test_ or rk_test_)");
  }
  const schema = ROLE_ENV_SCHEMAS[role] as unknown as z.ZodType<RoleEnv<R>>;
  const r = schema.safeParse(clean);
  if (!r.success) {
    for (const issue of r.error.issues) {
      const name = issue.path.length > 0 ? issue.path.map(String).join(".") : "(env)";
      errors.push(`${name}: ${issue.message}`);
    }
  }
  if (errors.length > 0 || !r.success) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, env: r.data };
}

/** Validates, exits the process on any issue, and returns ONLY the role's variables (others are dropped) [ADD-16]. */
export function loadEnv<R extends Role>(role: R, source?: Record<string, string | undefined>): RoleEnv<R> {
  const r = parseEnv(role, source);
  if (!r.ok) {
    process.stderr.write(`environment invalid for role ${role}:\n${r.errors.map((e) => `  ${e}`).join("\n")}\n`);
    process.exit(1);
  }
  return r.env;
}
