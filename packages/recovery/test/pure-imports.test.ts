// D1-UNIT-04: every module reachable from src/pure/index.ts imports nothing but @nt/contracts (and sibling pure modules),
// and reads no clock, random value, environment or network.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PURE = resolve(dirname(fileURLToPath(import.meta.url)), "../src/pure");
const IMPORT_RE = /(?:^|\s)(?:import|export)\b[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

function reachable(): Map<string, string> {
  const seen = new Map<string, string>();
  const stack = [join(PURE, "index.ts")];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    const src = readFileSync(f, "utf8");
    seen.set(f, src);
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3]!;
      if (spec.startsWith(".")) stack.push(resolve(dirname(f), spec));
    }
  }
  return seen;
}

describe("@nt/recovery/pure import boundary", () => {
  const files = reachable();

  it("reaches every file in src/pure and nothing outside it", () => {
    const inDir = readdirSync(PURE).filter((f) => f.endsWith(".ts")).map((f) => join(PURE, f)).sort();
    expect([...files.keys()].sort()).toEqual(inDir);
  });

  it("imports only @nt/contracts and sibling modules", () => {
    for (const [f, src] of files) {
      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3]!;
        const ok = spec === "@nt/contracts" || (spec.startsWith("./") && !spec.includes("..") && resolve(dirname(f), spec).startsWith(PURE));
        expect(ok, `${f} imports ${spec}`).toBe(true);
      }
    }
  });

  it("contains no clock read, random value, environment read, network or timer", () => {
    const banned = [/Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /Math\.random/, /process\./, /\bfetch\s*\(/, /performance\.now/, /crypto\./, /setTimeout|setInterval/, /\brequire\s*\(/];
    for (const [f, src] of files) {
      const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const re of banned) expect(re.test(code), `${f} matches ${re}`).toBe(false);
    }
  });

  it("package.json exposes ./pure", async () => {
    const pkg = JSON.parse(readFileSync(resolve(PURE, "../../package.json"), "utf8"));
    expect(pkg.exports["./pure"]).toBe("./src/pure/index.ts");
    const mod = await import("@nt/recovery/pure");
    expect(typeof mod.matchEvidence).toBe("function");
    expect(typeof mod.decideRecovery).toBe("function");
  });
});
