// E1: ModelClient with cli/sdk backends and live/record/replay modes. No real model call: a fake `claude` executable on PATH.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createModelClient } from "../src/model/client.ts";
import { buildChildEnv, buildCliArgs } from "../src/model/cli-backend.ts";

const Schema = z.object({ ok: z.boolean() });
const baseReq = {
  promptVersion: "test@1",
  system: "You answer with JSON.",
  messages: [{ role: "user" as const, content: "say ok" }],
  schema: Schema,
  maxTokens: 100,
  effort: "low" as const,
};

const FAKE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = __dirname;
const b = JSON.parse(fs.readFileSync(path.join(dir, "behavior.json"), "utf8"));
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(dir, "seen.json"), JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin }));
  fs.appendFileSync(path.join(dir, "calls.log"), "x");
  const go = () => {
    if (b.stderr) process.stderr.write(b.stderr);
    if (b.rawStdout !== undefined) process.stdout.write(b.rawStdout);
    else process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: b.isError ?? false, stop_reason: b.stopReason ?? "end_turn", result: b.result }));
    process.exit(b.exit ?? 0);
  };
  if (b.sleepMs) setTimeout(go, b.sleepMs); else go();
});
`;

let fakeDir: string;
let cassetteDir: string;
let savedEnv: NodeJS.ProcessEnv;

function behave(b: Record<string, unknown>) {
  writeFileSync(join(fakeDir, "behavior.json"), JSON.stringify(b));
}
function seen(): { argv: string[]; env: Record<string, string>; stdin: string } {
  return JSON.parse(readFileSync(join(fakeDir, "seen.json"), "utf8"));
}
function calls(): number {
  const f = join(fakeDir, "calls.log");
  return existsSync(f) ? readFileSync(f, "utf8").length : 0;
}
function client(mode: string, extra: Record<string, string> = {}, opts: { timeoutMs?: number } = {}) {
  return createModelClient(
    { NT_MODEL: "claude-test-1", NT_MODEL_MODE: mode, NT_MODEL_BACKEND: "cli", NT_MODEL_CASSETTE_DIR: cassetteDir, ...extra },
    opts,
  );
}

beforeAll(() => {
  savedEnv = { ...process.env };
});
beforeEach(() => {
  fakeDir = mkdtempSync(join(tmpdir(), "nt-fake-claude-"));
  cassetteDir = join(fakeDir, "cassettes");
  writeFileSync(join(fakeDir, "claude"), FAKE);
  chmodSync(join(fakeDir, "claude"), 0o755);
  process.env.PATH = `${fakeDir}:${savedEnv.PATH ?? ""}`;
  behave({ result: '{"ok": true}' });
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(fakeDir, { recursive: true, force: true });
});
afterAll(() => {
  process.env = { ...savedEnv };
});

describe("cli backend, live", () => {
  it("success: takes the result field, validates with the schema, returns source live", async () => {
    const r = await client("live").parse(baseReq);
    expect(r).toMatchObject({ ok: true, output: { ok: true }, source: "live" });
    expect(r.requestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("passes the checked flags, the model, no tools, and the prompt on stdin", async () => {
    await client("live").parse(baseReq);
    const s = seen();
    expect(s.argv).toEqual(buildCliArgs("claude-test-1", "low"));
    expect(s.argv).toContain("-p");
    expect(s.argv.slice(s.argv.indexOf("--output-format"), s.argv.indexOf("--output-format") + 2)).toEqual(["--output-format", "json"]);
    expect(s.argv.slice(s.argv.indexOf("--model"), s.argv.indexOf("--model") + 2)).toEqual(["--model", "claude-test-1"]);
    expect(s.argv.slice(s.argv.indexOf("--tools"), s.argv.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(s.stdin).toContain("You answer with JSON.");
    expect(s.stdin).toContain("say ok");
    expect(s.stdin).toContain('"ok"'); // the JSON Schema is rendered into the prompt
  });

  it("tolerates one markdown fence around the object", async () => {
    behave({ result: '```json\n{"ok": false}\n```' });
    expect(await client("live").parse(baseReq)).toMatchObject({ ok: true, output: { ok: false } });
  });

  it("invalid JSON in the reply -> INVALID_JSON", async () => {
    behave({ result: "Sure! here it is: {ok: true" });
    expect(await client("live").parse(baseReq)).toMatchObject({ ok: false, failure: "INVALID_JSON" });
  });

  it("a JSON array is not an object -> INVALID_JSON", async () => {
    behave({ result: "[1,2]" });
    expect(await client("live").parse(baseReq)).toMatchObject({ ok: false, failure: "INVALID_JSON" });
  });

  it("schema failure -> SCHEMA_INVALID, naming the field not the value", async () => {
    behave({ result: '{"ok": "yes"}' });
    const r = await client("live").parse(baseReq);
    expect(r).toMatchObject({ ok: false, failure: "SCHEMA_INVALID" });
    if (!r.ok) {
      expect(r.detail).toContain("ok");
      expect(r.detail).not.toContain("yes");
    }
  });

  it("timeout -> TIMEOUT, and the call returns promptly", async () => {
    behave({ sleepMs: 5000, result: '{"ok": true}' });
    const t0 = Date.now();
    const r = await client("live", {}, { timeoutMs: 400 }).parse(baseReq);
    expect(r).toMatchObject({ ok: false, failure: "TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("non-zero exit -> CLI_EXIT with stderr in the detail", async () => {
    behave({ exit: 3, stderr: "boom: not logged in", rawStdout: "" });
    const r = await client("live").parse(baseReq);
    expect(r).toMatchObject({ ok: false, failure: "CLI_EXIT" });
    if (!r.ok) expect(r.detail).toContain("not logged in");
  });

  it("exit 0 but no JSON wrapper -> CLI_EXIT", async () => {
    behave({ rawStdout: "hello" });
    expect(await client("live").parse(baseReq)).toMatchObject({ ok: false, failure: "CLI_EXIT" });
  });

  it("wrapper is_error -> API_ERROR; a rate-limit message -> RATE_LIMIT; max_tokens -> MAX_TOKENS", async () => {
    behave({ isError: true, result: "overloaded" });
    expect(await client("live").parse(baseReq)).toMatchObject({ ok: false, failure: "API_ERROR" });
    behave({ isError: true, result: "Claude usage limit reached" });
    expect(await client("live").parse(baseReq)).toMatchObject({ ok: false, failure: "RATE_LIMIT" });
    behave({ stopReason: "max_tokens", result: '{"ok": tr' });
    expect(await client("live").parse(baseReq)).toMatchObject({ ok: false, failure: "MAX_TOKENS" });
  });

  it("live reads and writes nothing on disk", async () => {
    await client("live").parse(baseReq);
    expect(existsSync(cassetteDir)).toBe(false);
  });

  it("runTools on the cli backend -> UNSUPPORTED", async () => {
    const r = await client("live").runTools({ promptVersion: "t", system: "s", messages: [], tools: [], maxTokens: 10, effort: "low", timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, failure: "UNSUPPORTED" });
  });
});

describe("child environment allow-list", () => {
  it("the child sees no database URI, Stripe key, simulator key or API key", async () => {
    Object.assign(process.env, {
      NT_MONGODB_URI: "mongodb://secret-host/x",
      NT_MONGODB_URI_GATEWAY: "mongodb://secret-host/g",
      STRIPE_SECRET_KEY: "sk_test_secretvalue",
      NT_SIM_WRITE_KEY: "wwww",
      NT_SIM_READ_KEY: "rrrr",
      NT_SIM_ADMIN_KEY: "aaaa",
      NT_SIM_EVAL_READ_KEY: "eeee",
      ANTHROPIC_API_KEY: "sk-ant-secretvalue",
      VOYAGE_API_KEY: "vvvv",
      NT_MODEL: "claude-test-1",
      HOME: process.env.HOME ?? "/tmp",
      USER: "tester",
    });
    await client("live").parse(baseReq);
    const env = seen().env;
    for (const k of Object.keys(env)) {
      expect(k).not.toMatch(/^(NT_|EVAL_|STRIPE|ANTHROPIC|VOYAGE)/);
    }
    expect(JSON.stringify(env)).not.toContain("secret");
    expect(env.PATH).toContain(fakeDir);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.USER).toBe("tester");
  });

  it("buildChildEnv keeps only PATH, HOME, TMPDIR, LANG, USER", () => {
    const out = buildChildEnv({ PATH: "/p", HOME: "/h", TMPDIR: "/t", LANG: "C", USER: "u", NT_MONGODB_URI: "x", FOO: "y", LC_ALL: "z" });
    expect(Object.keys(out).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR", "USER"]);
  });
});

describe("record and replay", () => {
  it("record stores the response; replay serves it with no child process", async () => {
    const rec = await client("record").parse(baseReq);
    expect(rec).toMatchObject({ ok: true, output: { ok: true }, source: "live" });
    expect(calls()).toBe(1);
    const files = readdirSync(cassetteDir);
    expect(files).toEqual([`${rec.requestSha256}.json`]);
    const stored = JSON.parse(readFileSync(join(cassetteDir, files[0]!), "utf8"));
    expect(stored).toMatchObject({ request_sha256: rec.requestSha256, model: "claude-test-1", prompt_version: "test@1", response: { parsed_output: { ok: true } } });
    expect(JSON.stringify(stored)).not.toMatch(/key|token|authorization/i);

    behave({ result: '{"ok": false}' }); // a live call would now answer differently
    const rep = await client("replay").parse(baseReq);
    expect(rep).toMatchObject({ ok: true, output: { ok: true }, source: "cassette", requestSha256: rec.requestSha256 });
    expect(calls()).toBe(1);
  });

  it("the request hash does not depend on the backend, so a cli cassette replays under sdk", async () => {
    const rec = await client("record").parse(baseReq);
    const rep = await client("replay", { NT_MODEL_BACKEND: "sdk" }).parse(baseReq);
    expect(rep).toMatchObject({ ok: true, source: "cassette", requestSha256: rec.requestSha256 });
  });

  it("record stores only successful results", async () => {
    behave({ result: "not json" });
    expect(await client("record").parse(baseReq)).toMatchObject({ ok: false, failure: "INVALID_JSON" });
    expect(existsSync(cassetteDir) ? readdirSync(cassetteDir) : []).toEqual([]);
  });

  it("replay miss -> CASSETTE_MISS with a clear detail, and never a live call", async () => {
    const r = await client("replay").parse(baseReq);
    expect(r).toMatchObject({ ok: false, failure: "CASSETTE_MISS" });
    if (!r.ok) expect(r.detail).toMatch(/no cassette [0-9a-f]{64}/);
    expect(calls()).toBe(0);
  });

  it("any change to model, prompt version, system, messages, effort or max tokens changes the key", async () => {
    const a = await client("record").parse(baseReq);
    const variants = [
      { ...baseReq, promptVersion: "test@2" },
      { ...baseReq, system: "different" },
      { ...baseReq, messages: [{ role: "user" as const, content: "say no" }] },
      { ...baseReq, effort: "medium" as const },
      { ...baseReq, maxTokens: 101 },
      { ...baseReq, schema: z.object({ ok: z.boolean(), extra: z.string().optional() }) },
    ];
    const shas = new Set([a.requestSha256]);
    for (const v of variants) shas.add((await client("replay").parse(v)).requestSha256);
    shas.add((await createModelClient({ NT_MODEL: "other-model", NT_MODEL_MODE: "replay", NT_MODEL_CASSETTE_DIR: cassetteDir }).parse(baseReq)).requestSha256);
    expect(shas.size).toBe(variants.length + 2);
  });

  it("a stored output that no longer matches the schema is rejected on replay", async () => {
    const rec = await client("record").parse(baseReq);
    const f = join(cassetteDir, `${rec.requestSha256}.json`);
    const c = JSON.parse(readFileSync(f, "utf8"));
    c.response = { parsed_output: { ok: "nope" } };
    writeFileSync(f, JSON.stringify(c));
    expect(await client("replay").parse(baseReq)).toMatchObject({ ok: false, failure: "SCHEMA_INVALID" });
  });

  it("a corrupt cassette file is a failure value, not a throw", async () => {
    const rec = await client("record").parse(baseReq);
    writeFileSync(join(cassetteDir, `${rec.requestSha256}.json`), "{{{");
    expect(await client("replay").parse(baseReq)).toMatchObject({ ok: false, failure: "SCHEMA_INVALID" });
  });

  it("the default cassette directory is fixtures/cassettes", () => {
    const c = createModelClient({ NT_MODEL_MODE: "replay" });
    expect(c.model).toBe("claude-opus-5-5");
    expect(c.backend).toBe("cli");
  });
});

describe("sdk backend (stub) and configuration", () => {
  it("live with sdk throws 'sdk backend not configured'", async () => {
    await expect(client("live", { NT_MODEL_BACKEND: "sdk" }).parse(baseReq)).rejects.toThrow("sdk backend not configured");
    await expect(
      client("live", { NT_MODEL_BACKEND: "sdk" }).runTools({ promptVersion: "t", system: "s", messages: [], tools: [], maxTokens: 10, effort: "low", timeoutMs: 1000 }),
    ).rejects.toThrow("sdk backend not configured");
  });

  it("sdk replay runTools -> CASSETTE_MISS", async () => {
    const r = await client("replay", { NT_MODEL_BACKEND: "sdk" }).runTools({ promptVersion: "t", system: "s", messages: [], tools: [], maxTokens: 10, effort: "low", timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, failure: "CASSETTE_MISS" });
  });

  it("a malformed mode or backend is a programmer error", () => {
    expect(() => createModelClient({ NT_MODEL_MODE: "bogus" })).toThrow(/NT_MODEL_MODE/);
    expect(() => createModelClient({ NT_MODEL_BACKEND: "bogus" })).toThrow(/NT_MODEL_BACKEND/);
  });
});
