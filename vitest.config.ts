import { defineConfig } from "vitest/config";

// Three projects (AGENT_TASKS workstream A, A1 field 4):
//   unit -> `pnpm test`      : packages/*/test, apps/*/test, fixtures/test, scripts/test, tests/boundaries.test.ts
//   int  -> `pnpm test:int`  : **/test/**/*.int.test.ts (needs a replica set or a running simulator)
//   e2e  -> `pnpm test:e2e`  : tests/e2e/**/*.test.ts
// evaluator/test/ is never matched: it runs under node:test through `pnpm test:evaluator`.
const neverMatched = ["**/node_modules/**", "evaluator/**", "out/**", ".nt/**"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "packages/*/test/**/*.test.ts",
            "apps/*/test/**/*.test.ts",
            "fixtures/test/**/*.test.ts",
            "scripts/test/**/*.test.ts",
            "tests/boundaries.test.ts",
          ],
          exclude: [...neverMatched, "**/*.int.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "int",
          include: ["**/test/**/*.int.test.ts"],
          exclude: neverMatched,
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          exclude: neverMatched,
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
