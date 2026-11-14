// Dependency-boundaries test (task H2; HANDOVER section 18; run by `pnpm lint:boundaries`).
//   - The real tree must have no violation (the message names the offending file and import).
//   - H2-UNIT-01: a clean mini tree passes, and each planted violation fails with the right rule and file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formatViolations, scanBoundaries, type Violation } from "./helpers/boundaries.ts";

const REPO = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------------------------- the real tree

describe("dependency boundaries of the repository (HANDOVER section 18)", () => {
  it("has no violation", () => {
    const violations = scanBoundaries(REPO);
    expect(violations, `\n${formatViolations(violations)}\n`).toEqual([]);
  });

  it("evaluator/package.json declares no dependency and no mongodb", () => {
    expect(scanBoundaries(REPO).filter((v) => v.file === "evaluator/package.json")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- H2-UNIT-01

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

type Tree = Record<string, string>;

const pkg = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: "0.0.0", type: "module", ...extra });

/** A small clean tree that obeys every rule, including the allowed edges each rule must not flag. */
function cleanTree(): Tree {
  return {
    "pnpm-workspace.yaml": "# evaluator is not a workspace package\npackages:\n  - packages/*\n  - apps/*\n",
    "packages/contracts/package.json": pkg("@nt/contracts", { dependencies: { zod: "1.0.0" } }),
    "packages/contracts/src/index.ts": 'import { z } from "zod";\nexport * from "./provider.ts";\nexport const x = z.string();\n',
    "packages/contracts/src/provider.ts": "export interface PaymentProvider { createPaymentOrRefund(req: unknown): Promise<unknown> }\n",
    "packages/db/package.json": pkg("@nt/db", { dependencies: { "@nt/contracts": "workspace:*" } }),
    "packages/db/src/index.ts": 'export * from "@nt/contracts";\n',
    "packages/providers/package.json": pkg("@nt/providers", { dependencies: { "@nt/contracts": "workspace:*" } }),
    "packages/providers/src/index.ts": 'import type { PaymentProvider } from "@nt/contracts";\nexport const p = (x: PaymentProvider) => x.createPaymentOrRefund({});\n',
    "packages/gateway/package.json": pkg("@nt/gateway", { dependencies: { "@nt/contracts": "workspace:*", "@nt/providers": "workspace:*", "@nt/recovery": "workspace:*" } }),
    "packages/gateway/src/index.ts":
      'import { p } from "@nt/providers";\nimport { match } from "@nt/recovery/pure";\nimport "@nt/contracts";\nexport const go = (provider: { createPaymentOrRefund(r: unknown): unknown }) => { p(provider as never); match(); return provider.createPaymentOrRefund({}); };\n',
    "packages/baselines/package.json": pkg("@nt/baselines", { dependencies: { "@nt/providers": "workspace:*" } }),
    "packages/baselines/src/index.ts": 'import "@nt/providers";\n',
    "packages/recovery/package.json": pkg("@nt/recovery", { dependencies: { "@nt/contracts": "workspace:*" } }),
    "packages/recovery/src/index.ts": 'export * from "./pure/index.ts";\nexport * from "./investigator/index.ts";\n',
    "packages/recovery/src/pure/index.ts": 'import "@nt/contracts";\nimport "node:crypto";\nexport * from "./matcher.ts";\n',
    "packages/recovery/src/pure/matcher.ts": 'import { z } from "@nt/contracts";\nexport const match = () => z;\n',
    "packages/recovery/src/investigator/index.ts": 'export * from "./tools.ts";\n',
    "packages/recovery/src/investigator/tools.ts": '// never imports "@nt/providers" and never calls createPaymentOrRefund\nimport "@nt/contracts";\nexport const t = 1;\n',
    "packages/recovery/test/fake.ts": "export const fake = { async createPaymentOrRefund(): Promise<never> { throw new Error('never called'); } };\n",
    "packages/agents/package.json": pkg("@nt/agents", { dependencies: { "@nt/contracts": "workspace:*" } }),
    "packages/agents/src/index.ts": 'import "@nt/contracts";\nexport * from "./backend-cli.ts";\n',
    "packages/agents/src/backend-cli.ts": 'import { spawn } from "node:child_process";\nexport const run = () => spawn("claude", ["-p"]);\n',
    "packages/agents/src/backend-sdk.ts": 'import Anthropic from "@anthropic-ai/sdk";\nexport const c = Anthropic;\n',
    "packages/agents/test/env.test.ts": 'process.env.STRIPE_SECRET_KEY = "placeholder";\n',
    "apps/provider-sim/package.json": pkg("@nt/provider-sim", { dependencies: { hono: "1.0.0" } }),
    "apps/provider-sim/src/server.ts": 'import { Hono } from "hono";\nimport { readFileSync } from "node:fs";\nimport "./ledger.ts";\nexport const a = [Hono, readFileSync];\n',
    "apps/provider-sim/src/ledger.ts": "export const l = 1;\n",
    "apps/reconciler/package.json": pkg("@nt/reconciler", { dependencies: { "@nt/gateway": "workspace:*" } }),
    "apps/reconciler/src/index.ts": 'import "@nt/gateway";\nimport "@nt/recovery";\n',
    "apps/desk-api/package.json": pkg("@nt/desk-api", { dependencies: { hono: "1.0.0" } }),
    "apps/desk-api/src/index.ts":
      '// reads evaluator/out/<run>.certificate.json and nothing else; never evaluator/hidden\nimport { readFileSync } from "node:fs";\nexport const cert = (r: string) => readFileSync(`evaluator/out/${r}.certificate.json`, "utf8");\n',
    "evaluator/package.json": JSON.stringify({ name: "never-twice-evaluator", version: "0.1.0", type: "module" }),
    "evaluator/src/cli.ts": 'import { readFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nimport "./checker.ts";\nexport const f = [readFileSync, writeFileSync, join("evaluator", "out"), "evaluator/hidden"];\n',
    "evaluator/src/checker.ts": 'import assert from "node:assert/strict";\nexport const c = assert;\n',
    "scripts/seed.ts": 'import "../packages/providers/src/index.ts";\nimport "../packages/contracts/src/index.ts";\n',
    "tests/e2e/a.test.ts": 'import { test } from "vitest";\ntest("x", () => {});\n',
  };
}

function materialise(tree: Tree): string {
  const root = mkdtempSync(join(tmpdir(), "nt-boundaries-"));
  tmpDirs.push(root);
  for (const [rel, text] of Object.entries(tree)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

function scan(overrides: Tree): Violation[] {
  return scanBoundaries(materialise({ ...cleanTree(), ...overrides }));
}

type Plant = { name: string; files: Tree; rule: string; file: string };

const PLANTS: Plant[] = [
  { name: "contracts imports another workspace package", files: { "packages/contracts/src/index.ts": 'import "@nt/db";\n' }, rule: "R1", file: "packages/contracts/src/index.ts" },
  { name: "contracts imports a relative path outside itself", files: { "packages/contracts/src/index.ts": 'import "../../db/src/index.ts";\n' }, rule: "R1", file: "packages/contracts/src/index.ts" },
  { name: "contracts declares a workspace dependency", files: { "packages/contracts/package.json": pkg("@nt/contracts", { dependencies: { "@nt/db": "workspace:*" } }) }, rule: "R1", file: "packages/contracts/package.json" },
  { name: "recovery imports providers (outside the investigator)", files: { "packages/recovery/src/index.ts": 'import "@nt/providers";\n' }, rule: "R2", file: "packages/recovery/src/index.ts" },
  { name: "the desk API imports providers by relative path", files: { "apps/desk-api/src/index.ts": 'import "../../../packages/providers/src/index.ts";\n' }, rule: "R2", file: "apps/desk-api/src/index.ts" },
  { name: "the runner declares a providers dependency", files: { "apps/runner/package.json": pkg("@nt/runner", { dependencies: { "@nt/providers": "workspace:*" } }), "apps/runner/src/index.ts": "export {};\n" }, rule: "R2", file: "apps/runner/package.json" },
  { name: "agents imports providers", files: { "packages/agents/src/index.ts": 'import "@nt/providers";\n' }, rule: "R3", file: "packages/agents/src/index.ts" },
  { name: "the investigator tool code imports providers", files: { "packages/recovery/src/investigator/tools.ts": 'import { p } from "@nt/providers";\nexport const t = p;\n' }, rule: "R3", file: "packages/recovery/src/investigator/tools.ts" },
  { name: "the investigator imports providers by a dynamic import", files: { "packages/recovery/src/investigator/tools.ts": 'export const t = () => import("@nt/providers");\n' }, rule: "R3", file: "packages/recovery/src/investigator/tools.ts" },
  { name: "agents calls createPaymentOrRefund", files: { "packages/agents/src/index.ts": "export const pay = (p: any) => p.createPaymentOrRefund({});\n" }, rule: "R7", file: "packages/agents/src/index.ts" },
  { name: "the investigator mentions createPaymentOrRefund", files: { "packages/recovery/src/investigator/tools.ts": "export const t = (p: any) => p.createPaymentOrRefund;\n" }, rule: "R3", file: "packages/recovery/src/investigator/tools.ts" },
  { name: "the reconciler calls createPaymentOrRefund", files: { "apps/reconciler/src/index.ts": "export const pay = (p: any) => p.createPaymentOrRefund({});\n" }, rule: "R7", file: "apps/reconciler/src/index.ts" },
  { name: "provider-sim imports a workspace package", files: { "apps/provider-sim/src/server.ts": 'import "@nt/contracts";\n' }, rule: "R4", file: "apps/provider-sim/src/server.ts" },
  { name: "provider-sim imports a sibling app by relative path", files: { "apps/provider-sim/src/server.ts": 'import "../../desk-api/src/index.ts";\n' }, rule: "R4", file: "apps/provider-sim/src/server.ts" },
  { name: "provider-sim declares a workspace dependency", files: { "apps/provider-sim/package.json": pkg("@nt/provider-sim", { dependencies: { "@nt/contracts": "workspace:*" } }) }, rule: "R4", file: "apps/provider-sim/package.json" },
  { name: "the evaluator imports from packages/", files: { "evaluator/src/checker.ts": 'import "../../packages/contracts/src/index.ts";\n' }, rule: "R5", file: "evaluator/src/checker.ts" },
  { name: "the evaluator imports a workspace package by name", files: { "evaluator/src/checker.ts": 'import "@nt/contracts";\n' }, rule: "R5", file: "evaluator/src/checker.ts" },
  { name: "the evaluator imports a bare third-party specifier", files: { "evaluator/src/checker.ts": 'import { z } from "zod";\nexport const c = z;\n' }, rule: "R5", file: "evaluator/src/checker.ts" },
  { name: "the evaluator declares a dependency", files: { "evaluator/package.json": JSON.stringify({ name: "e", dependencies: { zod: "1.0.0" } }) }, rule: "R5", file: "evaluator/package.json" },
  { name: "the evaluator package mentions mongodb", files: { "evaluator/package.json": JSON.stringify({ name: "e", description: "reads mongodb" }) }, rule: "R5", file: "evaluator/package.json" },
  { name: "the evaluator is listed in pnpm-workspace.yaml", files: { "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - evaluator\n" }, rule: "R5", file: "pnpm-workspace.yaml" },
  { name: "a file outside evaluator/ reads evaluator/hidden", files: { "scripts/seed.ts": 'import { readFileSync } from "node:fs";\nexport const t = readFileSync("evaluator/hidden/S0/claim-truth.json", "utf8");\n' }, rule: "R6", file: "scripts/seed.ts" },
  { name: "a file outside evaluator/ builds the hidden path from segments", files: { "apps/desk-api/src/index.ts": 'import { join } from "node:path";\nexport const p = join("evaluator", "hidden", "S1");\n' }, rule: "R6", file: "apps/desk-api/src/index.ts" },
  { name: "a file outside evaluator/ writes under evaluator/out", files: { "scripts/seed.ts": 'import { writeFileSync } from "node:fs";\nwriteFileSync("evaluator/out/g1.certificate.json", "{}");\n' }, rule: "R6", file: "scripts/seed.ts" },
  { name: "a file outside evaluator/ reads a manifest under evaluator/out", files: { "apps/desk-api/src/index.ts": 'import { readFileSync } from "node:fs";\nexport const m = readFileSync("evaluator/out/g1.manifest.json");\n' }, rule: "R6", file: "apps/desk-api/src/index.ts" },
  { name: "the Anthropic SDK is imported outside backend-sdk.ts", files: { "packages/agents/src/index.ts": 'import Anthropic from "@anthropic-ai/sdk";\nexport const a = Anthropic;\n' }, rule: "R7", file: "packages/agents/src/index.ts" },
  { name: "a claude child process is spawned outside backend-cli.ts", files: { "packages/recovery/src/index.ts": 'import { execFile } from "node:child_process";\nexecFile("claude", ["-p"]);\n' }, rule: "R7", file: "packages/recovery/src/index.ts" },
  { name: "the gateway references ANTHROPIC_API_KEY", files: { "packages/gateway/src/index.ts": "export const k = process.env.ANTHROPIC_API_KEY;\n" }, rule: "R7", file: "packages/gateway/src/index.ts" },
  { name: "agents reference STRIPE_SECRET_KEY", files: { "packages/agents/src/index.ts": "export const k = process.env.STRIPE_SECRET_KEY;\n" }, rule: "R7", file: "packages/agents/src/index.ts" },
  { name: "the desk API references NT_SIM_WRITE_KEY", files: { "apps/desk-api/src/index.ts": "export const k = process.env.NT_SIM_WRITE_KEY;\n" }, rule: "R7", file: "apps/desk-api/src/index.ts" },
  { name: "the gateway imports the recovery root instead of the pure sub-path", files: { "packages/gateway/src/index.ts": 'import "@nt/recovery";\n' }, rule: "R8", file: "packages/gateway/src/index.ts" },
  { name: "the gateway imports recovery by relative path", files: { "packages/gateway/src/index.ts": 'import "../../recovery/src/investigator/index.ts";\n' }, rule: "R8", file: "packages/gateway/src/index.ts" },
  { name: "a module reachable from recovery/pure imports another workspace package", files: { "packages/recovery/src/pure/matcher.ts": 'import "@nt/db";\nexport const match = () => 1;\n' }, rule: "R8", file: "packages/recovery/src/pure/matcher.ts" },
  { name: "recovery/pure reaches into the investigator", files: { "packages/recovery/src/pure/matcher.ts": 'import "../investigator/tools.ts";\nexport const match = () => 1;\n' }, rule: "R8", file: "packages/recovery/src/pure/matcher.ts" },
  { name: "recovery/pure imports a third-party package", files: { "packages/recovery/src/pure/matcher.ts": 'import "zod";\nexport const match = () => 1;\n' }, rule: "R8", file: "packages/recovery/src/pure/matcher.ts" },
];

describe("H2-UNIT-01 the boundaries scan on planted violations", () => {
  it("passes on the clean mini tree, which uses every allowed edge", () => {
    const v = scanBoundaries(materialise(cleanTree()));
    expect(v, `\n${formatViolations(v)}\n`).toEqual([]);
  });

  it.each(PLANTS)("fails and names the file: $name", ({ files, rule, file }) => {
    const v = scan(files);
    const hit = v.find((x) => x.rule.startsWith(`${rule} `) && x.file === file);
    expect(hit, `expected a ${rule} violation in ${file}; got:\n${formatViolations(v) || "(none)"}`).toBeDefined();
    expect(hit!.detail.length).toBeGreaterThan(0);
  });

  it("ignores rule text in comments", () => {
    const v = scan({
      "scripts/seed.ts": '// never reads evaluator/hidden, never writes evaluator/out, no import "@nt/db" here\n/* import "@anthropic-ai/sdk"; STRIPE_SECRET_KEY */\nexport {};\n',
      "packages/agents/src/index.ts": '// import "@nt/providers"; p.createPaymentOrRefund({})\nexport {};\n',
    });
    expect(v, `\n${formatViolations(v)}\n`).toEqual([]);
  });

  it("scans multi-line imports, re-exports, side-effect and dynamic imports", () => {
    const v = scan({
      "packages/agents/src/index.ts": 'import {\n  a,\n  b,\n} from\n  "@nt/providers";\n',
      "packages/recovery/src/index.ts": 'export { x } from "@nt/providers";\n',
      "apps/desk-api/src/index.ts": 'const m = require("@nt/providers");\n',
    });
    for (const f of ["packages/agents/src/index.ts", "packages/recovery/src/index.ts", "apps/desk-api/src/index.ts"]) {
      expect(v.some((x) => x.file === f && /^R[23] /.test(x.rule)), f).toBe(true);
    }
  });
});
