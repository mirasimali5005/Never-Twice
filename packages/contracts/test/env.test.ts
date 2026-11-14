// A2-UNIT-07 and SEC-01: environment schema and role scoping.
import { describe, expect, it } from "vitest";
import { EnvSchema, parseEnv } from "../src/index.ts";

// Placeholders only; none is a real credential.
const COMMON = {
  NT_ENV: "local",
  NT_MONGODB_URI: "mongodb://127.0.0.1:27017/?replicaSet=rs0",
  NT_MODEL: "claude-opus-5-5",
  NT_MODEL_MODE: "replay",
  NT_RUN_ID: "r7k2m9qa",
  NT_ARM: "nt",
  NT_SIM_WRITE_KEY: "w-placeholder",
  NT_SIM_READ_KEY: "r-placeholder",
  NT_SIM_ADMIN_KEY: "a-placeholder",
  STRIPE_SECRET_KEY: "sk_test_placeholder",
  NT_SIM_EVAL_READ_KEY: "e-placeholder",
  EVAL_STRIPE_KEY: "rk_test_placeholder",
};

describe("EnvSchema", () => {
  it("applies the defaults", () => {
    const e = EnvSchema.parse({ NT_ENV: "local", NT_MONGODB_URI: COMMON.NT_MONGODB_URI, NT_MODEL: "m", NT_MODEL_MODE: "replay", NT_STRIPE_ENABLED: "false" });
    expect(e.NT_MODEL_BACKEND).toBe("cli");
    expect(e.NT_INVESTIGATOR_TIMEOUT_MS).toBe(45000);
    expect(e.NT_LEASE_MS).toBe(8000);
    expect(e.NT_DISPATCH_TIMEOUT_MS).toBe(3000);
    expect(e.NT_RECONCILE_INTERVAL_MS).toBe(1000);
    expect(e.NT_KEY_MARGIN_MS).toBe(60000);
    expect(e.NT_DB_NAME).toBe("never_twice");
    expect(e.NT_SIM_URL).toBe("http://127.0.0.1:4010");
    expect(e.NT_MODEL_CASSETTE_DIR).toBe("fixtures/cassettes");
    expect(e.NT_STRIPE_ENABLED).toBe(false);
  });

  it("NT_STRIPE_ENABLED defaults to true and then needs a key", () => {
    const r = EnvSchema.safeParse({ NT_ENV: "local", NT_MONGODB_URI: COMMON.NT_MONGODB_URI, NT_MODEL: "m", NT_MODEL_MODE: "replay" });
    expect(r.success).toBe(false);
  });
});

describe("parseEnv", () => {
  it("runner and reconciler load with no ANTHROPIC_API_KEY under the cli backend", () => {
    for (const role of ["runner", "reconciler"] as const) {
      const r = parseEnv(role, { ...COMMON, NT_MODEL_MODE: "live" });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
  });

  it("runner and reconciler fail without ANTHROPIC_API_KEY under sdk + live, pass under sdk + replay or with a key", () => {
    for (const role of ["runner", "reconciler"] as const) {
      const bad = parseEnv(role, { ...COMMON, NT_MODEL_BACKEND: "sdk", NT_MODEL_MODE: "live" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.errors.join("\n")).toContain("ANTHROPIC_API_KEY");
      expect(parseEnv(role, { ...COMMON, NT_MODEL_BACKEND: "sdk", NT_MODEL_MODE: "record" }).ok).toBe(false);
      expect(parseEnv(role, { ...COMMON, NT_MODEL_BACKEND: "sdk", NT_MODEL_MODE: "replay" }).ok).toBe(true);
      expect(parseEnv(role, { ...COMMON, NT_MODEL_BACKEND: "sdk", NT_MODEL_MODE: "live", ANTHROPIC_API_KEY: "placeholder" }).ok).toBe(true);
    }
  });

  it("reconciler gets the investigator timeout default and role URIs default to NT_MONGODB_URI", () => {
    const r = parseEnv("reconciler", COMMON);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.env.NT_INVESTIGATOR_TIMEOUT_MS).toBe(45000);
    expect(r.env.NT_MONGODB_URI_GATEWAY).toBe(COMMON.NT_MONGODB_URI);
    expect(r.env.NT_MONGODB_URI_INVESTIGATOR).toBe(COMMON.NT_MONGODB_URI);
    const o = parseEnv("runner", { ...COMMON, NT_MONGODB_URI_AGENT: "mongodb+srv://agent@x/" });
    if (!o.ok) throw new Error(o.errors.join("\n"));
    expect(o.env.NT_MONGODB_URI_AGENT).toBe("mongodb+srv://agent@x/");
    expect(o.env.NT_MONGODB_URI_GATEWAY).toBe(COMMON.NT_MONGODB_URI);
  });

  it("enforces NT_DISPATCH_TIMEOUT_MS < NT_LEASE_MS", () => {
    expect(parseEnv("runner", { ...COMMON, NT_DISPATCH_TIMEOUT_MS: "8000", NT_LEASE_MS: "8000" }).ok).toBe(false);
    expect(parseEnv("runner", { ...COMMON, NT_DISPATCH_TIMEOUT_MS: "7999", NT_LEASE_MS: "8000" }).ok).toBe(true);
    expect(EnvSchema.safeParse({ ...COMMON, NT_DISPATCH_TIMEOUT_MS: "9000" }).success).toBe(false);
  });

  it.each(["sk_live_placeholder", "rk_live_placeholder", "pk_test_placeholder", ""])("Stripe guard refuses %j for every role (SEC-01)", (key) => {
    for (const role of ["runner", "reconciler", "script"] as const) {
      const r = parseEnv(role, { ...COMMON, NT_STRIPE_ENABLED: "true", STRIPE_SECRET_KEY: key });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join("\n")).not.toContain(key || "\u0000"); // never prints the value
    }
  });

  it("a non-test Stripe key fails even for desk-api and even with Stripe disabled", () => {
    expect(parseEnv("desk-api", { ...COMMON, STRIPE_SECRET_KEY: "sk_live_placeholder" }).ok).toBe(false);
    expect(parseEnv("runner", { ...COMMON, NT_STRIPE_ENABLED: "false", STRIPE_SECRET_KEY: "sk_live_placeholder" }).ok).toBe(false);
  });

  it.each(["sk_test_placeholder", "rk_test_placeholder"])("accepts %j", (key) => {
    expect(parseEnv("runner", { ...COMMON, STRIPE_SECRET_KEY: key }).ok).toBe(true);
  });

  it("desk-api exposes no write, Stripe, model or admin key", () => {
    const r = parseEnv("desk-api", { ...COMMON, ANTHROPIC_API_KEY: "placeholder", VOYAGE_API_KEY: "placeholder" });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    const keys = Object.keys(r.env);
    for (const k of ["NT_SIM_WRITE_KEY", "NT_SIM_ADMIN_KEY", "STRIPE_SECRET_KEY", "ANTHROPIC_API_KEY", "VOYAGE_API_KEY", "NT_SIM_EVAL_READ_KEY", "EVAL_STRIPE_KEY", "NT_MONGODB_URI"]) {
      expect(keys).not.toContain(k);
    }
    expect(r.env.NT_SIM_READ_KEY).toBe(COMMON.NT_SIM_READ_KEY);
    expect(r.env.NT_MONGODB_URI_DESK).toBe(COMMON.NT_MONGODB_URI);
  });

  it("no role receives NT_SIM_EVAL_READ_KEY or EVAL_*; only script receives the admin key", () => {
    for (const role of ["runner", "reconciler", "desk-api", "script"] as const) {
      const r = parseEnv(role, COMMON);
      if (!r.ok) throw new Error(`${role}: ${r.errors.join("\n")}`);
      const keys = Object.keys(r.env);
      expect(keys.some((k) => k.startsWith("EVAL_") || k === "NT_SIM_EVAL_READ_KEY")).toBe(false);
      expect(keys.includes("NT_SIM_ADMIN_KEY")).toBe(role === "script");
    }
  });

  it("runner requires its run variables and rejects NT_MUTATION outside nt_mutant", () => {
    const { NT_RUN_ID: _r, ...noRun } = COMMON;
    expect(parseEnv("runner", noRun).ok).toBe(false);
    expect(parseEnv("runner", { ...COMMON, NT_MUTATION: "M2" }).ok).toBe(false);
    expect(parseEnv("runner", { ...COMMON, NT_MUTATION: "M2", NT_ARM: "nt_mutant" }).ok).toBe(true);
  });

  it("treats empty strings as unset", () => {
    expect(parseEnv("runner", { ...COMMON, ANTHROPIC_API_KEY: "", VOYAGE_API_KEY: "", NT_CRASH_AT: "" }).ok).toBe(true);
  });

  it("validates NT_CRASH_AT syntax", () => {
    expect(parseEnv("runner", { ...COMMON, NT_CRASH_AT: "BR_DISPATCH_RESPONSE_RECEIVED@ZT4H9X.P02.NT101-20261110.APPR_DELAY" }).ok).toBe(true);
    expect(parseEnv("runner", { ...COMMON, NT_CRASH_AT: "kill-now" }).ok).toBe(false);
  });
});

describe("NT_AUTHORITY_GRANT (Tier 3, CP-AUTH-1)", () => {
  it("reaches the runner and the reconciler when set, is absent by default, and rejects a node outside GOODWILL", () => {
    const r = parseEnv("runner", { ...COMMON, NT_AUTHORITY_GRANT: "GOODWILL/DESK_YYZ/AGENT_1" });
    expect(r.ok && r.env.NT_AUTHORITY_GRANT).toBe("GOODWILL/DESK_YYZ/AGENT_1");
    const d = parseEnv("runner", COMMON);
    expect(d.ok && d.env.NT_AUTHORITY_GRANT).toBeUndefined();
    expect(parseEnv("reconciler", { ...COMMON, NT_AUTHORITY_GRANT: "GOODWILL" }).ok).toBe(true);
    expect(parseEnv("runner", { ...COMMON, NT_AUTHORITY_GRANT: "OTHER/AGENT" }).ok).toBe(false);
  });
});
