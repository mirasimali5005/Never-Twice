// Never Twice auditor CLI. Zero dependencies; run with plain node 24.
//
//   node evaluator/src/cli.ts manifest --scenario <S0|S1> --group <group_id> [--ops-record <path>] [--out-dir <dir>] [--hidden-dir <dir>]
//   node --env-file=evaluator/.env evaluator/src/cli.ts check --run <run_id> [--report <path>] [--expect-hash <hex>] [--authority-tree <path>]
//                                                              [--ops-record <path>] [--out-dir <dir>] [--hidden-dir <dir>]
//
// Environment (check only), from evaluator/.env, never the root .env: EVAL_SIM_URL, EVAL_SIM_READ_KEY, EVAL_STRIPE_KEY (rk_test_ only; F4).
// Exit codes: 0 SAFETY: PASS; 1 SAFETY: FAIL; 2 error (no certificate; any earlier certificate for the run is removed first).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { GROUP_ID_RE, RUN_ID_RE } from "./effect-key.ts";
import { parseOpsRecord, InputError } from "./ops-record.ts";
import { computeManifest, parseClaimTruth, manifestSha256, withGroup } from "./manifest.ts";
import type { Manifest } from "./manifest.ts";
import { parseFinalReport, ReportError } from "./report.ts";
import { LedgerError, readAllSources } from "./ledger.ts";
import type { LedgerSource } from "./ledger.ts";
import { simLedgerSource } from "./ledger-sim.ts";
import { stripeLedgerSource, resolveApiBase } from "./ledger-stripe.ts";
import { check } from "./checker.ts";
import type { AuthorityTree, Commitment } from "./checker.ts";
import { buildCertificate, renderText } from "./certificate.ts";
import { gradeLetters, parseLetters, readMessages, renderLetters } from "./letters.ts";

export const EVAL_DIR = resolve(import.meta.dirname, "..");
export const REPO_ROOT = resolve(EVAL_DIR, "..");

class UsageError extends Error {}

function parseArgs(argv: string[]): { cmd: string | undefined; opts: Map<string, string> } {
  const [cmd, ...rest] = argv;
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument ${a}`);
    const eq = a.indexOf("=");
    if (eq > 0) { opts.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
    opts.set(a.slice(2), v);
    i++;
  }
  return { cmd, opts };
}

function readJson(path: string, what: string): unknown {
  if (!existsSync(path)) throw new InputError(`${what} not found: ${path}`);
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new InputError(`${what} is not valid JSON: ${path}: ${(e as Error).message}`); }
}

function dirs(opts: Map<string, string>): { outDir: string; hiddenDir: string } {
  return {
    outDir: opts.has("out-dir") ? resolve(opts.get("out-dir")!) : join(EVAL_DIR, "out"),
    hiddenDir: opts.has("hidden-dir") ? resolve(opts.get("hidden-dir")!) : join(EVAL_DIR, "hidden"),
  };
}

export function regenerateManifest(scenario: string, opts: Map<string, string>): Manifest {
  const { hiddenDir } = dirs(opts);
  const opsPath = opts.has("ops-record") ? resolve(opts.get("ops-record")!) : join(REPO_ROOT, "fixtures", "scenarios", scenario, "ops-record.json");
  const ops = parseOpsRecord(readJson(opsPath, "ops record"));
  const truth = parseClaimTruth(readJson(join(hiddenDir, scenario, "claim-truth.json"), "hidden claim truth"));
  return computeManifest(ops, truth);
}

function cmdManifest(opts: Map<string, string>): number {
  const scenario = opts.get("scenario");
  const group = opts.get("group");
  if (scenario !== "S0" && scenario !== "S1") throw new UsageError("--scenario must be S0 or S1");
  if (!group || !GROUP_ID_RE.test(group)) throw new UsageError("--group must be g + 7 lowercase base-36 characters");
  const { outDir } = dirs(opts);
  const manifestPath = join(outDir, `${group}.manifest.json`);
  const commitmentPath = join(outDir, `${group}.commitment.json`);
  if (existsSync(manifestPath) || existsSync(commitmentPath)) {
    throw new InputError(`refusing to overwrite: a manifest or commitment for group ${group} already exists in ${outDir}`);
  }
  const manifest = withGroup(regenerateManifest(scenario, opts), group);
  const sha256 = manifestSha256(manifest);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(manifestPath, canonicalJson(manifest) + "\n", { flag: "wx" });
  const commitment: Commitment = { group_id: group, sha256, committed_at: new Date().toISOString() };
  writeFileSync(commitmentPath, canonicalJson(commitment) + "\n", { flag: "wx" });
  const t = manifest.totals;
  process.stdout.write(`manifest sha256 ${sha256}\n`);
  process.stdout.write(`scenario ${scenario}  group ${group}  entries ${manifest.entries.length}  ` +
    `payments owed ${t.payments_owed_count} (${t.payments_owed_minor} minor: statutory ${t.statutory_owed_count}/${t.statutory_owed_minor}, ticket refund ${t.ticket_refund_count}/${t.ticket_refund_minor})  ` +
    `refusals ${t.refusals}  holds ${t.holds}  claim-level holds ${t.claims_without_entitlement}  goodwill eligible ${t.goodwill_eligible_minor} against grant ${t.goodwill_grant_minor}\n`);
  process.stdout.write(`wrote ${manifestPath}\nwrote ${commitmentPath}\n`);
  return 0;
}

/**
 * Ledger sources for a run. Stripe (task F4) is read whenever EVAL_STRIPE_KEY is set, and is required when the
 * report lists a stripe_refund payment. The Stripe key guard (^rk_test_) runs first, before any request.
 * EVAL_STRIPE_API_BASE is a test seam and accepts only a loopback URL.
 */
function buildLedgerSources(env: NodeJS.ProcessEnv, needStripe: boolean): { sources: LedgerSource[]; stripe: boolean } {
  const key = env.EVAL_STRIPE_KEY;
  if (needStripe && !key) throw new LedgerError("the report lists a stripe_refund payment and EVAL_STRIPE_KEY is not set: cannot grade");
  const stripe = key ? stripeLedgerSource({ key, apiBase: resolveApiBase(env.EVAL_STRIPE_API_BASE) }) : null;
  const sources: LedgerSource[] = [simLedgerSource({ baseUrl: env.EVAL_SIM_URL ?? "", readKey: env.EVAL_SIM_READ_KEY ?? "" })];
  if (stripe) sources.push(stripe);
  return { sources, stripe: stripe !== null };
}

/** Tier 3 (CP-AUTH-1): { nodes: [{ id, parent, grant_minor }] }, root "GOODWILL". */
function parseAuthorityTree(v: unknown): AuthorityTree {
  const nodes = (v as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new InputError("authority tree: nodes must be a non-empty array");
  const out = nodes.map((n, i) => {
    const x = n as Record<string, unknown>;
    if (typeof x.id !== "string" || !(x.parent === null || typeof x.parent === "string") || typeof x.grant_minor !== "number" || !Number.isSafeInteger(x.grant_minor) || x.grant_minor < 0) {
      throw new InputError(`authority tree: node ${i} must be { id: string, parent: string | null, grant_minor: integer >= 0 }`);
    }
    return { id: x.id, parent: x.parent as string | null, grant_minor: x.grant_minor };
  });
  if (!out.some((n) => n.id === "GOODWILL" && n.parent === null)) throw new InputError("authority tree: the root must be GOODWILL with parent null");
  return { nodes: out };
}

async function cmdCheck(opts: Map<string, string>, env: NodeJS.ProcessEnv): Promise<number> {
  const runId = opts.get("run");
  if (!runId || !RUN_ID_RE.test(runId)) throw new UsageError("--run must be r + 7 lowercase base-36 characters");
  const { outDir } = dirs(opts);
  const certJson = join(outDir, `${runId}.certificate.json`);
  const certTxt = join(outDir, `${runId}.certificate.txt`);
  // Remove any earlier certificate first, so a stale green can never be shown after an error.
  rmSync(certJson, { force: true });
  rmSync(certTxt, { force: true });

  const reportPath = opts.has("report") ? resolve(opts.get("report")!) : join(REPO_ROOT, "out", "reports", `${runId}.final-report.json`);
  const rawReport = readJson(reportPath, "final report");
  const report = parseFinalReport(rawReport);
  const letters = parseLetters(rawReport); // CP-LETTER-1: graded separately, never as payments
  if (report.run_id !== runId) throw new ReportError(`report run_id ${report.run_id} differs from --run ${runId}`);

  const manifestPath = join(outDir, `${report.group_id}.manifest.json`);
  const commitmentPath = join(outDir, `${report.group_id}.commitment.json`);
  if (!existsSync(manifestPath)) throw new InputError(`no manifest for group ${report.group_id} (${manifestPath}): run the manifest command before any runner`);
  const storedManifest = readJson(manifestPath, "manifest");
  let commitment: Commitment | null = null;
  if (existsSync(commitmentPath)) {
    const c = readJson(commitmentPath, "commitment") as Record<string, unknown>;
    if (typeof c !== "object" || c === null || typeof c.group_id !== "string" || typeof c.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(c.sha256) || typeof c.committed_at !== "string") {
      throw new InputError(`commitment file is malformed: ${commitmentPath}`);
    }
    commitment = { group_id: c.group_id, sha256: c.sha256, committed_at: c.committed_at };
  }
  const manifest = withGroup(regenerateManifest(report.scenario, opts), report.group_id);

  const needStripe = report.paid.some((p) => p.provider === "stripe_refund");
  const { sources, stripe } = buildLedgerSources(env, needStripe);
  const { objects, counts } = await readAllSources(sources, runId);

  const authorityTree = opts.has("authority-tree") ? parseAuthorityTree(readJson(resolve(opts.get("authority-tree")!), "authority tree")) : null;
  const result = check({ manifest, storedManifest, commitment, expectHash: opts.get("expect-hash") ?? null, ledger: objects, report, authorityTree });
  const cert = buildCertificate(report, result, { sim_objects: counts.sim ?? 0, stripe_objects: stripe ? (counts.stripe ?? 0) : null }, new Date().toISOString());
  if (stripe) {
    cert.notes.push(`Stripe test mode: ${counts.stripe ?? 0} refund object(s) with metadata.nt_run_id ${runId} read from the top-level refund list ` +
      `with the auditor's restricted read-only key (rk_test_); GET only`);
  }
  // Decision letters: read only when the report lists any (an older simulator has no /v1/messages). They never change SAFETY.
  let lettersText = "";
  if (letters.length > 0) {
    const grade = gradeLetters(runId, letters, await readMessages({ baseUrl: env.EVAL_SIM_URL ?? "", readKey: env.EVAL_SIM_READ_KEY ?? "", runId }));
    (cert as unknown as { letters: unknown }).letters = grade;
    cert.notes.push(`decision letters graded separately (not payments): ${grade.status}; ${grade.reported} reported, ${grade.messages} NotifySim message(s)`);
    lettersText = renderLetters(grade);
  }
  const text = renderText(cert) + lettersText;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(certJson, JSON.stringify(cert, null, 2) + "\n");
  writeFileSync(certTxt, text);
  process.stdout.write(text);
  return cert.safety === "PASS" ? 0 : 1;
}

const USAGE = `usage:
  node evaluator/src/cli.ts manifest --scenario <S0|S1> --group <group_id> [--ops-record <path>]
  node --env-file=evaluator/.env evaluator/src/cli.ts check --run <run_id> [--report <path>] [--expect-hash <hex>] [--authority-tree <path>]
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const isCheck = argv[0] === "check";
  try {
    const { cmd, opts } = parseArgs(argv);
    if (cmd === "manifest") return cmdManifest(opts);
    if (cmd === "check") return await cmdCheck(opts, env);
    throw new UsageError(`unknown command ${cmd ?? "(none)"}`);
  } catch (e) {
    if (e instanceof UsageError) process.stderr.write(`evaluator: ${e.message}\n${USAGE}`);
    else if (e instanceof InputError || e instanceof ReportError || e instanceof LedgerError) process.stderr.write(`evaluator: ERROR: ${e.message}\n`);
    else process.stderr.write(`evaluator: ERROR (unexpected): ${(e as Error)?.stack ?? String(e)}\n`);
    if (isCheck) process.stdout.write("SAFETY: not graded (error, exit 2; no certificate written)\n");
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
}
