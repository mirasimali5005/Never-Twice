// Dependency-boundaries scanner (task H2; HANDOVER section 18 import rules, AGENT_TASKS H field 12).
// A static source scan: no TypeScript compiler, no execution. Used by tests/boundaries.test.ts and scripts/check-safety.ts.
// Erasable TypeScript only (it runs under plain `node` as well as vitest).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type Violation = { rule: string; file: string; detail: string };

export const SCAN_ROOTS = ["packages", "apps", "evaluator", "scripts", "tests"] as const;
/** Files that describe the rules and plant violations on purpose; they are never scanned. */
export const SELF_EXEMPT = new Set(["tests/boundaries.test.ts", "tests/helpers/boundaries.ts"]);

const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".nt", ".git", "coverage", "data"]);
const SOURCE_RE = /\.(ts|tsx|mts|cts)$/;

// ------------------------------------------------------------------------------------------------ file walking

export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (SOURCE_RE.test(name) && !name.endsWith(".d.ts")) out.push(p);
    }
  };
  for (const r of SCAN_ROOTS) {
    const d = join(root, r);
    if (existsSync(d)) walk(d);
  }
  return out;
}

export function repoRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

// ------------------------------------------------------------------------------------------------ import extraction

/** Removes // and block comments, keeping string and template literal text. Single and double quoted strings end at a newline. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        const ch = src[i]!;
        if (ch === "\\") {
          out += ch + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (ch === "\n" && q !== "`") break;
        out += ch;
        i++;
        if (ch === q) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const STATIC_FROM_RE = /^[ \t]*(?:import|export)\b[^'";]*?\bfrom\s*["']([^"'\n]+)["']/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s*["']([^"'\n]+)["']/gm;
const DYNAMIC_RE = /\b(?:import|require)\s*\(\s*["'`]([^"'`\n]+)["'`]/g;

/** Every module specifier a file imports (static, re-export, side-effect, dynamic import(), require()). */
export function extractSpecifiers(src: string): string[] {
  const code = stripComments(src);
  const found = new Set<string>();
  for (const re of [STATIC_FROM_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) found.add(m[1]!);
  }
  return [...found];
}

// ------------------------------------------------------------------------------------------------ workspace model

type Workspace = {
  root: string;
  /** package name -> repo-relative directory, from every package.json under packages/ and apps/ */
  names: Map<string, string>;
  /** repo-relative directory -> parsed package.json */
  manifests: Map<string, Record<string, unknown>>;
};

function loadWorkspace(root: string): Workspace {
  const names = new Map<string, string>();
  const manifests = new Map<string, Record<string, unknown>>();
  for (const base of ["packages", "apps"]) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const pj = join(dir, name, "package.json");
      if (!existsSync(pj)) continue;
      try {
        const json = JSON.parse(readFileSync(pj, "utf8")) as Record<string, unknown>;
        manifests.set(`${base}/${name}`, json);
        if (typeof json.name === "string") names.set(json.name, `${base}/${name}`);
      } catch {
        /* a malformed package.json is reported by other tools */
      }
    }
  }
  return { root, names, manifests };
}

/** The unit a repo-relative path belongs to: `packages/x`, `apps/y`, `evaluator`, `scripts`, `tests`, `fixtures`, or `.` */
export function unitOf(rel: string): string {
  const p = rel.split("/");
  if ((p[0] === "packages" || p[0] === "apps") && p[1]) return `${p[0]}/${p[1]}`;
  return p[0] ?? ".";
}

export type Target =
  | { kind: "builtin"; name: string }
  | { kind: "external"; name: string }
  | { kind: "file"; rel: string; unit: string }
  | { kind: "workspace"; pkg: string; unit: string; sub: string };

export function resolveSpecifier(ws: Workspace, fromRel: string, spec: string): Target {
  if (spec.startsWith("node:")) return { kind: "builtin", name: spec };
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const abs = resolve(ws.root, dirname(fromRel), spec);
    const rel = repoRel(ws.root, abs);
    return { kind: "file", rel, unit: rel.startsWith("..") ? "<outside repository>" : unitOf(rel) };
  }
  const scoped = spec.startsWith("@");
  const parts = spec.split("/");
  const pkg = scoped ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
  const sub = parts.slice(scoped ? 2 : 1).join("/");
  const unit = ws.names.get(pkg);
  if (unit) return { kind: "workspace", pkg, unit, sub };
  if (pkg.startsWith("@nt/")) {
    // A workspace-looking name that is not (yet) a package: still treat it as a workspace reference by its directory name.
    const guess = `packages/${pkg.slice(4)}`;
    return { kind: "workspace", pkg, unit: guess, sub };
  }
  if (/^(fs|path|os|url|util|crypto|http|https|net|child_process|assert|events|stream|zlib|readline|timers|tty|dns|vm|worker_threads|buffer|module|process|test)(\/.*)?$/.test(spec)) {
    return { kind: "builtin", name: spec };
  }
  return { kind: "external", name: pkg };
}

/** The workspace unit a specifier points into, or null for builtins and third-party packages. */
function targetUnit(t: Target): string | null {
  if (t.kind === "workspace" || t.kind === "file") return t.unit;
  return null;
}

// ------------------------------------------------------------------------------------------------ rules

const PROVIDERS = "packages/providers";
const PROVIDERS_ALLOWED = new Set(["packages/gateway", "packages/baselines", "scripts", PROVIDERS]);
const CREATE_CALL_ALLOWED = new Set(["packages/gateway", "packages/baselines", "packages/providers"]);

const WRITE_CALL_RE = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rmSync|rm|unlink|unlinkSync|mkdir|mkdirSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|truncate|truncateSync|rmdir|rmdirSync)\s*\(/;
const EVAL_OUT_RE = /evaluator[\\/]out\b|["']evaluator["']\s*,\s*["']out["']|\bEVALUATOR_OUT\b/;
const EVAL_HIDDEN_RE = /evaluator[\\/]hidden\b|["']evaluator["']\s*,\s*["']hidden["']|\bEVALUATOR_HIDDEN\b/;

function dependencyNames(pkg: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const v = pkg[k];
    if (v && typeof v === "object") names.push(...Object.keys(v as Record<string, unknown>));
  }
  return names;
}

export function scanBoundaries(root: string): Violation[] {
  const ws = loadWorkspace(root);
  const violations: Violation[] = [];
  const add = (rule: string, file: string, detail: string) => violations.push({ rule, file, detail });

  const files = listSourceFiles(root)
    .map((abs) => ({ abs, rel: repoRel(root, abs) }))
    .filter((f) => !SELF_EXEMPT.has(f.rel));

  const sources = new Map<string, string>();
  const specsByFile = new Map<string, { spec: string; target: Target }[]>();
  for (const f of files) {
    const src = readFileSync(f.abs, "utf8");
    sources.set(f.rel, src);
    specsByFile.set(
      f.rel,
      extractSpecifiers(src).map((spec) => ({ spec, target: resolveSpecifier(ws, f.rel, spec) })),
    );
  }

  for (const f of files) {
    const unit = unitOf(f.rel);
    const imports = specsByFile.get(f.rel) ?? [];
    const code = stripComments(sources.get(f.rel) ?? "");

    for (const { spec, target } of imports) {
      const tu = targetUnit(target);
      const where = `imports "${spec}"`;

      // Rule 1: contracts imports nothing internal.
      if (unit === "packages/contracts" && tu !== null && tu !== "packages/contracts") {
        add("R1 contracts-imports-nothing-internal", f.rel, `${where} (${tu})`);
      }

      // Rules 2 and 3: providers is imported only by gateway, baselines and scripts; agents and the investigator never import it.
      if (tu === PROVIDERS && !PROVIDERS_ALLOWED.has(unit)) {
        const modelSide = unit === "packages/agents" || f.rel.startsWith("packages/recovery/src/investigator/");
        const rule = modelSide ? "R3 agents-and-investigator-never-import-providers" : "R2 providers-imported-only-by-gateway-baselines-scripts";
        add(rule, f.rel, `${where}; only packages/gateway, packages/baselines and scripts/ may import packages/providers`);
      }

      // Rule 4: provider-sim imports nothing from the workspace.
      if (unit === "apps/provider-sim" && tu !== null && tu !== "apps/provider-sim") {
        add("R4 provider-sim-imports-nothing-from-workspace", f.rel, `${where} (${tu})`);
      }

      // Rule 5: the evaluator imports only node: built-ins and its own files.
      if (unit === "evaluator") {
        if (target.kind === "external" || target.kind === "workspace") {
          add("R5 evaluator-imports-only-node-builtins", f.rel, `${where}: bare specifiers other than node: built-ins are forbidden`);
        } else if (target.kind === "builtin" && !spec.startsWith("node:")) {
          add("R5 evaluator-imports-only-node-builtins", f.rel, `${where}: write built-ins with the node: prefix`);
        } else if (target.kind === "file" && target.unit !== "evaluator") {
          add("R5 evaluator-imports-only-node-builtins", f.rel, `${where} reaches outside evaluator/ (${target.unit})`);
        }
      }

      // Rule 7: credential scope by import.
      if (spec === "@anthropic-ai/sdk" || spec.startsWith("@anthropic-ai/sdk/")) {
        if (f.rel !== "packages/agents/src/backend-sdk.ts") add("R7 anthropic-sdk-only-in-backend-sdk", f.rel, where);
      }

      // Rule 8: gateway reaches recovery only through the pure sub-path; reconciler never imports providers (covered by R2).
      if (unit === "packages/gateway" && tu === "packages/recovery") {
        const viaName = target.kind === "workspace";
        if (!(viaName && target.sub === "pure")) add("R8 gateway-imports-recovery-only-through-pure", f.rel, where);
      }
    }

    // Rule 6: hidden truth and evaluator output.
    if (unit !== "evaluator") {
      if (EVAL_HIDDEN_RE.test(code)) add("R6 evaluator-hidden-is-private", f.rel, "references evaluator/hidden outside evaluator/");
      if (EVAL_OUT_RE.test(code)) {
        if (WRITE_CALL_RE.test(code)) add("R6 evaluator-out-is-read-only", f.rel, "references evaluator/out and calls a filesystem write function; only the evaluator writes there");
        if (/\.manifest\.json/.test(code)) add("R6 evaluator-out-reads-certificates-and-commitments-only", f.rel, "references a manifest file under evaluator/out; only *.commitment.json and *.certificate.json may be read");
      }
    }

    // Rule 7: credential scope by source scan.
    if (/\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(\s*["'`]claude["'`]/.test(code)) {
      if (f.rel !== "packages/agents/src/backend-cli.ts") add("R7 claude-child-process-only-in-backend-cli", f.rel, "spawns the claude command");
    }
    // The two name-reference rules are about code that could read a secret; a test that sets the variable to prove a child process
    // does not receive it (SEC-11) is not such code, so files under a test/ directory are exempt from them.
    const isTestFile = /(^|\/)test\//.test(f.rel);
    if (!isTestFile && /\bANTHROPIC_API_KEY\b/.test(code) && ["packages/gateway", "apps/provider-sim", "evaluator", "apps/desk-ui"].includes(unit)) {
      add("R7 anthropic-key-scope", f.rel, "references ANTHROPIC_API_KEY (forbidden in gateway, provider-sim, evaluator, desk-ui)");
    }
    if (!isTestFile && /\b(?:NT_SIM_WRITE_KEY|STRIPE_SECRET_KEY)\b/.test(code) && ["packages/agents", "apps/desk-api", "apps/desk-ui", "evaluator"].includes(unit)) {
      add("R7 write-credential-scope", f.rel, "references NT_SIM_WRITE_KEY or STRIPE_SECRET_KEY (forbidden in agents, desk-api, desk-ui, evaluator)");
    }
    // Only gateway, baselines and providers may CALL createPaymentOrRefund (a member call). A fake that merely declares the method is not a call.
    if (/\.\s*createPaymentOrRefund\s*(?:\?\.)?\(/.test(code) && !CREATE_CALL_ALLOWED.has(unit)) {
      add("R7 createPaymentOrRefund-callers", f.rel, "calls createPaymentOrRefund outside gateway, baselines and providers");
    }
    // Agent and investigator source never mention it at all.
    if (!isTestFile && /\bcreatePaymentOrRefund\b/.test(code) && (f.rel.startsWith("packages/agents/") || f.rel.startsWith("packages/recovery/src/investigator/"))) {
      add("R3 agents-and-investigator-never-pay", f.rel, "mentions createPaymentOrRefund");
    }
  }

  // Rule 8 (second half): everything reachable from @nt/recovery/pure imports only @nt/contracts and files inside that closure.
  const pureIndex = "packages/recovery/src/pure/index.ts";
  if (sources.has(pureIndex)) {
    const seen = new Set<string>();
    const queue = [pureIndex];
    while (queue.length) {
      const cur = queue.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const { spec, target } of specsByFile.get(cur) ?? []) {
        if (target.kind === "builtin") continue;
        if (target.kind === "workspace") {
          if (target.pkg !== "@nt/contracts") add("R8 recovery-pure-imports-only-contracts", cur, `imports "${spec}"`);
        } else if (target.kind === "file") {
          const cand = [target.rel, target.rel.replace(/\.js$/, ".ts"), `${target.rel}.ts`, `${target.rel}/index.ts`].find((c) => sources.has(c));
          if (!cand) {
            if (target.unit !== "packages/recovery") add("R8 recovery-pure-imports-only-contracts", cur, `imports "${spec}" outside packages/recovery`);
            continue;
          }
          if (!cand.startsWith("packages/recovery/src/pure/") && !cand.startsWith("packages/recovery/src/pure.")) {
            add("R8 recovery-pure-imports-only-contracts", cur, `imports "${spec}" which lies outside packages/recovery/src/pure/`);
          }
          queue.push(cand);
        } else {
          add("R8 recovery-pure-imports-only-contracts", cur, `imports third-party package "${spec}"`);
        }
      }
    }
  }

  // Manifests: declared dependencies obey the same rules as imports.
  for (const [unit, pkg] of ws.manifests) {
    const deps = dependencyNames(pkg);
    const file = `${unit}/package.json`;
    if (unit === "packages/contracts") for (const d of deps) if (d.startsWith("@nt/")) add("R1 contracts-imports-nothing-internal", file, `declares dependency ${d}`);
    if (unit === "apps/provider-sim") for (const d of deps) if (d.startsWith("@nt/")) add("R4 provider-sim-imports-nothing-from-workspace", file, `declares dependency ${d}`);
    if (!PROVIDERS_ALLOWED.has(unit) && deps.includes("@nt/providers")) add("R2 providers-imported-only-by-gateway-baselines-scripts", file, "declares dependency @nt/providers");
    if (unit === "packages/agents" && deps.includes("@nt/providers")) add("R3 agents-never-import-providers", file, "declares dependency @nt/providers");
  }

  // Rule 5: the evaluator package.
  const evalPj = join(root, "evaluator", "package.json");
  if (existsSync(evalPj)) {
    const raw = readFileSync(evalPj, "utf8");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      add("R5 evaluator-package-has-no-dependencies", "evaluator/package.json", "is not valid JSON");
    }
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const v = parsed[k];
      if (v && typeof v === "object" && Object.keys(v as object).length > 0) {
        add("R5 evaluator-package-has-no-dependencies", "evaluator/package.json", `declares ${k}: ${Object.keys(v as object).join(", ")}`);
      }
    }
    if (/mongodb/i.test(raw)) add("R5 evaluator-has-no-mongodb", "evaluator/package.json", 'the string "mongodb" appears');
  }
  const wsYaml = join(root, "pnpm-workspace.yaml");
  if (existsSync(wsYaml)) {
    const yaml = readFileSync(wsYaml, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    if (/^\s*-\s*["']?(?:\.\/)?evaluator\b/m.test(yaml)) add("R5 evaluator-is-not-a-workspace-package", "pnpm-workspace.yaml", "lists evaluator");
  }

  return violations.sort((a, b) => (a.rule + a.file + a.detail).localeCompare(b.rule + b.file + b.detail));
}

export function formatViolations(vs: Violation[]): string {
  return vs.map((v) => `[${v.rule}] ${v.file}: ${v.detail}`).join("\n");
}
