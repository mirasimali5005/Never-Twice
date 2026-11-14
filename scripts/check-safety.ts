// pnpm check:safety (task H2; HANDOVER sections 18 and 21; TEST_PLAN SEC-02).
// Refuses to continue on: a non-test Stripe key in the environment or the .env files; a key-shaped string in any git-TRACKED file;
// a tracked .env file; a secret-named variable with a value in a tracked .env.example; a dependency-boundaries violation.
// It never prints a key: findings name the variable or file, the line number and the key's class only.
//
//   node --env-file-if-exists=.env scripts/check-safety.ts [--root <dir>]
// Exit codes: 0 every check passed; 1 at least one finding; 2 the check itself could not run.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatViolations, scanBoundaries } from "../tests/helpers/boundaries.ts";

export type Finding = { check: string; where: string; detail: string };

// ------------------------------------------------------------------------------------------------ 1. Stripe keys in the environment

const STRIPE_VARS = ["STRIPE_SECRET_KEY", "EVAL_STRIPE_KEY"] as const;
const STRIPE_TEST_OK = /^(sk|rk)_test_/;

/** The class of a refused Stripe key value, never the value itself. */
export function stripeKeyClass(v: string): string {
  if (/^(sk|rk)_live_/.test(v)) return "LIVE-mode key (sk_live_ or rk_live_)";
  if (/^pk_live_/.test(v)) return "LIVE-mode publishable key (pk_live_)";
  if (/^pk_test_/.test(v)) return "test-mode publishable key (pk_test_), not a secret or restricted key";
  if (/^(sk|rk)_/.test(v)) return "key with an unrecognised sk_ or rk_ prefix";
  return "value that is not a Stripe key at all";
}

/** Parses KEY=value lines of a dotenv file (no expansion). Values lose surrounding quotes and a trailing ` # comment`. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2]!.trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, "");
    out.set(m[1]!, v);
  }
  return out;
}

export function checkStripeEnv(root: string, env: NodeJS.ProcessEnv): Finding[] {
  const findings: Finding[] = [];
  const sources: { label: string; get: (name: string) => string | undefined }[] = [{ label: "environment", get: (n) => env[n] }];
  for (const rel of [".env", "evaluator/.env"]) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    let vars: Map<string, string>;
    try {
      vars = parseDotenv(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    sources.push({ label: rel, get: (n) => vars.get(n) });
  }
  for (const s of sources) {
    for (const name of STRIPE_VARS) {
      const v = s.get(name);
      if (v === undefined || v === "") continue; // unset is fine: Stripe is optional offline (NT_STRIPE_ENABLED=false)
      if (!STRIPE_TEST_OK.test(v)) {
        findings.push({ check: "stripe-key", where: `${name} in ${s.label}`, detail: `refused: a ${stripeKeyClass(v)}; only keys matching ^(sk|rk)_test_ are allowed` });
      }
    }
  }
  return findings;
}

// ------------------------------------------------------------------------------------------------ 2. key-shaped strings in tracked files

const PLACEHOLDER_BODY = /^(.)\1+$|x{6,}|placeholder|example|dummy|fake|redacted|0{8,}/i;

type KeyPattern = { cls: string; re: RegExp; accept?: (body: string, match: RegExpExecArray) => boolean };

// Each pattern needs a long random-looking body (real Stripe keys carry 24 or more characters after the prefix), so the short
// placeholders that tests use to prove a key is refused (for example a word after the prefix) are not flagged, and so that
// this file's own pattern sources do not match themselves.
export const KEY_PATTERNS: KeyPattern[] = [
  { cls: "Stripe LIVE key shape (sk_live_, rk_live_ or pk_live_)", re: /\b(?:sk|rk|pk)_live_([A-Za-z0-9]{20,})/g, accept: (b) => !PLACEHOLDER_BODY.test(b) },
  { cls: "Stripe test key shape (sk_test_ or rk_test_)", re: /\b(?:sk|rk)_test_([A-Za-z0-9]{20,})/g, accept: (b) => !PLACEHOLDER_BODY.test(b) },
  { cls: "Anthropic API key shape (sk-ant-)", re: /\bsk-ant-([A-Za-z0-9_-]{20,})/g, accept: (b) => !PLACEHOLDER_BODY.test(b) },
  { cls: "Voyage AI key shape (pa-)", re: /(?<![A-Za-z0-9_-])pa-([A-Za-z0-9_-]{30,})(?![A-Za-z0-9_-])/g, accept: (b) => /[0-9]/.test(b) && /[A-Za-z]/.test(b) && !PLACEHOLDER_BODY.test(b) },
  {
    cls: "MongoDB connection string with a password",
    re: /mongodb(?:\+srv)?:\/\/[^\s:@\/"'`<>]+:([^\s@\/"'`]+)@/g,
    accept: (pw) => !/^(<.*>|\$\{?.*|%.*|\{.*|\*+|x+|password|pass|pwd|secret|changeme|placeholder|example|redacted|\.\.\.)$/i.test(pw),
  },
];

const MAX_SCAN_BYTES = 2 * 1024 * 1024;

export function scanText(text: string): { cls: string; line: number }[] {
  const hits: { cls: string; line: number }[] = [];
  for (const p of KEY_PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      if (p.accept && !p.accept(m[1] ?? "", m)) continue;
      hits.push({ cls: p.cls, line: text.slice(0, m.index).split("\n").length });
    }
  }
  return hits;
}

export function isTrackedEnvFile(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return /^\.env(\..+)?$/.test(base) && base !== ".env.example";
}

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|URI|_URI_[A-Z]+)$/;

export function checkTracked(root: string, files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (isTrackedEnvFile(f)) findings.push({ check: "tracked-env", where: f, detail: "an environment file is tracked by git; remove it from the index and keep it git-ignored" });
    const abs = join(root, f);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binary
    const text = buf.toString("utf8");
    for (const h of scanText(text)) findings.push({ check: "key-in-tracked-file", where: `${f}:${h.line}`, detail: `${h.cls}; value not shown` });
    if (f.split("/").pop() === ".env.example") {
      for (const [name, value] of parseDotenv(text)) {
        if (SECRET_NAME.test(name) && value !== "") findings.push({ check: "env-example-value", where: `${f}`, detail: `${name} has a value; a secret-named variable in .env.example must be empty` });
      }
    }
  }
  return findings;
}

export function gitTrackedFiles(root: string): string[] {
  const r = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${root}: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout.split("\0").filter(Boolean);
}

// ------------------------------------------------------------------------------------------------ 3. boundaries

/** On the real repository the boundaries TEST runs (so its planted-violation self-tests run too); on another root the same scanner runs in process. */
export function checkBoundaries(root: string, repoRoot: string): { findings: Finding[]; note: string } {
  if (resolve(root) === resolve(repoRoot)) {
    const r = spawnSync("pnpm", ["exec", "vitest", "run", "--project", "unit", "tests/boundaries.test.ts"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" } });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.status === 0) {
      const tests = /Tests\s+(\d+ passed[^\n]*)/.exec(out)?.[1]?.trim() ?? "passed";
      return { findings: [], note: `tests/boundaries.test.ts: ${tests}` };
    }
    const direct = scanBoundaries(root);
    const detail = direct.length > 0 ? `\n${formatViolations(direct)}` : `\n${out.split("\n").slice(-30).join("\n")}`;
    return { findings: [{ check: "boundaries", where: "tests/boundaries.test.ts", detail: `failed${detail}` }], note: "" };
  }
  const v = scanBoundaries(root);
  return {
    findings: v.map((x) => ({ check: "boundaries", where: x.file, detail: `${x.rule}: ${x.detail}` })),
    note: `in-process scan of ${root}`,
  };
}

// ------------------------------------------------------------------------------------------------ main

export function runChecks(root: string, env: NodeJS.ProcessEnv, repoRoot: string): { results: { name: string; findings: Finding[]; note: string }[] } {
  const results: { name: string; findings: Finding[]; note: string }[] = [];
  results.push({ name: "Stripe keys are test-mode only (environment, .env, evaluator/.env)", findings: checkStripeEnv(root, env), note: "" });
  const tracked = gitTrackedFiles(root);
  results.push({ name: `no key-shaped string, tracked .env, or filled secret in .env.example (${tracked.length} tracked files scanned)`, findings: checkTracked(root, tracked), note: "" });
  const b = checkBoundaries(root, repoRoot);
  results.push({ name: "dependency boundaries (HANDOVER section 18)", findings: b.findings, note: b.note });
  return { results };
}

function main(argv: string[]): number {
  const repoRoot = resolve(import.meta.dirname, "..");
  let root = repoRoot;
  const i = argv.indexOf("--root");
  if (i >= 0) {
    const v = argv[i + 1];
    if (!v) {
      console.error("error: --root needs a directory");
      return 2;
    }
    root = resolve(v);
  }
  let results;
  try {
    ({ results } = runChecks(root, process.env, repoRoot));
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  let failed = 0;
  for (const r of results) {
    if (r.findings.length === 0) {
      console.log(`PASS  ${r.name}${r.note ? `  [${r.note}]` : ""}`);
      continue;
    }
    failed += r.findings.length;
    console.log(`FAIL  ${r.name}`);
    for (const f of r.findings) console.log(`        ${f.check}  ${f.where}  ${f.detail}`);
  }
  console.log(failed === 0 ? "check:safety PASS" : `check:safety FAIL (${failed} finding${failed === 1 ? "" : "s"})`);
  return failed === 0 ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = main(process.argv.slice(2));
