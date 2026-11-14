// SEC-02 no secret in the repository (task H2; TEST_PLAN section 6): `pnpm check:safety` is clean on a clean tree and fails, naming the file,
// on a planted key-shaped string, a tracked .env, a non-test Stripe key, and a boundaries violation. Needs git, no database, no network.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "..", "..");
const SCRIPT = join(REPO, "scripts", "check-safety.ts");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Key-shaped values are assembled at run time so that this file itself holds no key-shaped literal.
const body = (n: number, ch = "Q7") => ch.repeat(Math.ceil(n / ch.length)).slice(0, n);
const stripeLive = ["sk", "live", body(32)].join("_");
const stripeRestrictedTest = ["rk", "test", body(32, "a9")].join("_");
const voyage = `pa-${body(43, "Zk3")}`;
const mongoWithPassword = `mongodb+srv://nt_user:${body(16, "Hq9")}@cluster0.example.mongodb.net/db`;

type Repo = { root: string };

function repo(files: Record<string, string>, ignored: Record<string, string> = {}): Repo {
  const root = mkdtempSync(join(tmpdir(), "nt-safety-"));
  dirs.push(root);
  const put = (rel: string, text: string) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  put(".gitignore", ".env\n.env.*\n!.env.example\nevaluator/.env\nignored-note.txt\n");
  put(".env.example", "NT_ENV=local\nNT_MONGODB_URI=\nSTRIPE_SECRET_KEY=\n");
  put("README.md", "clean\n");
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  for (const [rel, text] of Object.entries(ignored)) put(rel, text);
  const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  for (const rel of Object.keys(files)) if (/(^|\/)\.env(\..+)?$/.test(rel) && !rel.endsWith(".example")) git("add", "-f", rel); // a tracked .env, despite .gitignore
  return { root };
}

function run(r: Repo, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (!("STRIPE_SECRET_KEY" in extraEnv)) delete env.STRIPE_SECRET_KEY;
  if (!("EVAL_STRIPE_KEY" in extraEnv)) delete env.EVAL_STRIPE_KEY;
  const p = spawnSync(process.execPath, [SCRIPT, "--root", r.root], { encoding: "utf8", env });
  return { status: p.status, out: `${p.stdout}${p.stderr}` };
}

describe("SEC-02 check:safety", () => {
  it("passes on a clean tree, and ignores placeholders and untracked files", () => {
    const r = repo(
      {
        "packages/x/test/placeholders.test.ts": 'export const a = ["sk_live_placeholder", "rk_test_abc123", "mongodb+srv://agent@x/", "mongodb+srv://u:<password>@h/"];\n',
      },
      { ".env": `STRIPE_SECRET_KEY=${["sk", "test", body(32)].join("_")}\n`, "ignored-note.txt": `${stripeLive}\n` },
    );
    const x = run(r);
    expect(x.out).toContain("check:safety PASS");
    expect(x.status).toBe(0);
  });

  it.each([
    ["a Stripe live-shaped key", stripeLive, "Stripe LIVE key shape"],
    ["a Stripe restricted test-shaped key", stripeRestrictedTest, "Stripe test key shape"],
    ["a Voyage-shaped key", voyage, "Voyage AI key shape"],
    ["a MongoDB connection string with a password", mongoWithPassword, "MongoDB connection string with a password"],
  ])("fails on %s in a tracked file, naming the file and never printing the value", (_n, secret, cls) => {
    const r = repo({ "packages/x/src/config.ts": `export const k = "${secret}";\n` });
    const x = run(r);
    expect(x.status).toBe(1);
    expect(x.out).toContain("packages/x/src/config.ts:1");
    expect(x.out).toContain(cls);
    expect(x.out).not.toContain(secret);
    expect(x.out).not.toContain(body(16, "Hq9"));
    expect(x.out).toContain("check:safety FAIL");
  });

  it("fails on a tracked .env file", () => {
    const r = repo({ ".env": "NT_ENV=local\n" });
    const x = run(r);
    expect(x.status).toBe(1);
    expect(x.out).toMatch(/tracked-env\s+\.env\s/);
  });

  it("fails on a filled secret-named variable in .env.example", () => {
    const r = repo({ ".env.example": "NT_ENV=local\nNT_SIM_WRITE_KEY=abc\n" });
    const x = run(r);
    expect(x.status).toBe(1);
    expect(x.out).toContain("NT_SIM_WRITE_KEY has a value");
  });

  it.each([
    ["STRIPE_SECRET_KEY", stripeLive, "LIVE-mode key"],
    ["EVAL_STRIPE_KEY", `pk_test_${body(20)}`, "publishable key"],
    ["STRIPE_SECRET_KEY", "not-a-key", "not a Stripe key at all"],
  ])("fails on %s in the environment when it is not a test key (class only, never the value)", (name, value, cls) => {
    const x = run(repo({}), { [name]: value });
    expect(x.status).toBe(1);
    expect(x.out).toContain(`${name} in environment`);
    expect(x.out).toContain(cls);
    expect(x.out).not.toContain(value);
  });

  it("fails on a non-test Stripe key in .env and in evaluator/.env, and accepts sk_test_ and rk_test_", () => {
    const bad = repo({}, { ".env": `STRIPE_SECRET_KEY="${stripeLive}"\n`, "evaluator/.env": `EVAL_STRIPE_KEY=${stripeRestrictedTest}\n` });
    const b = run(bad);
    expect(b.status).toBe(1);
    expect(b.out).toContain("STRIPE_SECRET_KEY in .env");
    expect(b.out).not.toContain("EVAL_STRIPE_KEY in evaluator/.env");
    expect(b.out).not.toContain(stripeLive);
    const ok = run(repo({}), { STRIPE_SECRET_KEY: ["sk", "test", body(32)].join("_"), EVAL_STRIPE_KEY: stripeRestrictedTest });
    expect(ok.status).toBe(0);
  });

  it("fails on a boundaries violation", () => {
    const r = repo({
      "packages/contracts/package.json": '{"name":"@nt/contracts"}',
      "packages/contracts/src/index.ts": 'import "@nt/db";\n',
      "packages/db/package.json": '{"name":"@nt/db"}',
      "packages/db/src/index.ts": "export {};\n",
    });
    const x = run(r);
    expect(x.status).toBe(1);
    expect(x.out).toContain("R1 contracts-imports-nothing-internal");
    expect(x.out).toContain("packages/contracts/src/index.ts");
  });
});
