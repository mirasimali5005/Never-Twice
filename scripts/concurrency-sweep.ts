// pnpm sweep:concurrency: the goodwill-cap concurrency sweep, TEST_PLAN.md section 4.2 (task H3, Tier 2). Property P2 under contention.
//
// World (synthetic, test-only): 50 goodwill obligations with distinct effect keys, status OWED: 25 of 15000 (OVERNIGHT_STRANDED) and 25 of 20000
// (MOBILITY_ASSIST), demand 875000, one grant document of 525000 (60% of demand). N workers drain one shared queue of the 50 proposals, shuffled with a
// recorded seed, each calling the real gateway `propose()` on its own database connection. N = 1 is the sequential control. Every repetition gets a
// fresh in-memory replica set. The workers are concurrent async callers in one Node process (not separate OS processes); each has its own MongoClient.
//
// Conditions checked in every run (numbering of TEST_PLAN 4.2):
//   1. held + settled <= grant at the end, and in every sample taken by a poller that reads the grant document throughout the run;
//   2. replaying INTENT_RESERVED events in _id order, the running total of reserved amounts never exceeds the grant;
//   3. held_minor equals the sum of amount_minor over the goodwill intents (counter recomputed from the intents);
//   4. one intent per effect key; every proposal returned RESERVED or AWAITING_BUDGET, and the two counts add up to 50;
//   5. no held amount exists without its intent (condition 3 read the other way: the intents are the only thing held_minor can be made of, and there is no
//      goodwill intent without a counted amount; checked as: number of intents == held / amounts, and the counter equals the recomputation);
//   6. no proposal left awaiting budget would still fit: every such amount > grant - held - settled at the end.
// Plus the gateway's own invariant scan (scanInvariants: P1, P2, P3, P9) on the final state.
//
// Negative control: with --negative (or when NT_MUTATION=M1 is already set) one run per N is made with the goodwill guard removed (mutation M1, read by
// the gateway from process.env); it must break condition 1 or 2, otherwise the sweep is not measuring the guard.
//
// Usage: pnpm sweep:concurrency [-- --runs 20] [--ns 1,5,10,25,50] [--seed 20261114] [--negative-runs 1] [--out-name concurrency-sweep]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { newRunId, type Obligation, type PaymentProvider, type ProposedPayment, type ProviderId } from "../packages/contracts/src/index.ts";
import { openNtDb, type NtDb } from "../packages/db/src/index.ts";
import { startTestReplSet } from "../packages/db/src/testing.ts";
import { createGateway, goodwillGrantId, propose, type GatewayDeps } from "../packages/gateway/src/index.ts";
import { parseArgs, runMain } from "./lib/args.ts";

const REPO = resolve(import.meta.dirname, "..");
const OUT_DIR = join(REPO, "out", "sweeps");

const GRANT = 525_000;
const DEMAND_COUNT = 50;
const TARIFF = [
  { n: 25, amount: 15_000, kind: "OVERNIGHT_STRANDED" },
  { n: 25, amount: 20_000, kind: "MOBILITY_ASSIST" },
] as const;

// ------------------------------------------------------------------------------------------------ small deterministic helpers

/** mulberry32: a seeded PRNG so the shuffle of a repetition can be reproduced from the recorded seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ------------------------------------------------------------------------------------------------ world

/** A provider that is never contacted to send; listOperations is empty (the scan lists the provider; the sweep only proposes). */
function quietProvider(id: ProviderId): PaymentProvider {
  const contact = () => {
    throw new Error(`provider ${id} contacted during the concurrency sweep (it only proposes)`);
  };
  return {
    id,
    capabilities: { dedupesOnIdempotencyKey: id !== "sim_keyless", keyRetentionMs: id !== "sim_keyless" ? 86_400_000 : null, declaredMaxInFlightMs: null, stronglyConsistentList: true },
    createPaymentOrRefund: contact,
    getOperation: contact,
    findOperationEvidence: contact,
    // eslint-disable-next-line require-yield
    async *listOperations() {},
  } as PaymentProvider;
}

function depsFor(db: NtDb, runId: string, workerId: string): GatewayDeps {
  return {
    db,
    runId,
    workerId,
    providers: { sim_payout: quietProvider("sim_payout"), sim_keyless: quietProvider("sim_keyless"), stripe_refund: quietProvider("stripe_refund") },
    config: { leaseMs: 8000, dispatchTimeoutMs: 3000, keyMarginMs: 60000, stripeEnabled: false },
    // no hooks: the gateway reads NT_MUTATION from process.env at call time (withDefaultHooks is applied by createGateway; propose() below is called
    // through a gateway object so the mutation switch is the production one)
  };
}

type Proposal = { ob: Obligation; kind: string };

function buildWorld(runId: string): Proposal[] {
  const out: Proposal[] = [];
  let i = 0;
  for (const t of TARIFF) {
    for (let k = 0; k < t.n; k++) {
      const passenger_id = `G${String(++i).padStart(2, "0")}`;
      const effect_key = `ZT4H9X.${passenger_id}.NT101-20261110.GOODWILL`;
      out.push({
        kind: t.kind,
        ob: {
          _id: `${runId}:${effect_key}`,
          run_id: runId,
          effect_key,
          booking_ref: "ZT4H9X",
          passenger_id,
          disruption_id: "NT101-20261110",
          entitlement_type: "GOODWILL",
          status: "OWED",
          amount_minor: t.amount,
          currency: "CAD",
          payee_ref: `payee_${passenger_id}`,
          rail: "instant",
          reason_code: null,
          rule_citation: `NT-GOODWILL@1 ${t.kind}`,
          policy_version: "NT-GOODWILL@1",
          due_by: null,
          claim_ids: ["C01"],
          decided_at: new Date(),
        } as Obligation,
      });
    }
  }
  return out;
}

const proposalFor = (ob: Obligation): ProposedPayment => ({
  run_id: ob.run_id,
  effect_key: ob.effect_key,
  amount_minor: ob.amount_minor,
  currency: "CAD",
  payee_ref: ob.payee_ref,
  claim_ids: ob.claim_ids,
  proposed_by: { kind: "orchestrator", id: "concurrency-sweep" },
});

// ------------------------------------------------------------------------------------------------ one repetition

type RunRecord = {
  n_workers: number;
  rep: number;
  seed: number;
  mutation: string | null;
  proposals: number;
  reserved: number;
  awaiting_budget: number;
  other_results: number;
  final_held: number;
  final_settled: number;
  reserved_sum: number;
  poller_samples: number;
  poller_max_total: number;
  replay_max_running_total: number;
  violations: Record<string, number>; // condition name -> count (0 or 1 per run, except samples over the cap)
  violation_detail: string[];
  scan_ok: boolean;
  scan_findings: string[];
  wall_ms: number;
  error: string | null;
};

const CONDITIONS = ["C1_final_cap", "C1_poller_sample_over_cap", "C2_replay_over_cap", "C3_counter_vs_intents", "C4_one_intent_per_key_and_all_answered", "C5_no_held_without_intent", "C6_stranded_budget", "SCAN_invariants"] as const;

async function oneRun(n: number, rep: number, seed: number, mutation: string | null): Promise<RunRecord> {
  const t0 = Date.now();
  const viol = Object.fromEntries(CONDITIONS.map((c) => [c, 0])) as Record<string, number>;
  const detail: string[] = [];
  const bad = (c: (typeof CONDITIONS)[number], why: string) => {
    viol[c] = (viol[c] ?? 0) + 1;
    if (detail.length < 12) detail.push(`${c}: ${why}`);
  };
  const rec: RunRecord = {
    n_workers: n, rep, seed, mutation, proposals: DEMAND_COUNT, reserved: 0, awaiting_budget: 0, other_results: 0, final_held: 0, final_settled: 0, reserved_sum: 0, poller_samples: 0,
    poller_max_total: 0, replay_max_running_total: 0, violations: viol, violation_detail: detail, scan_ok: true, scan_findings: [], wall_ms: 0, error: null,
  };
  const rs = await startTestReplSet();
  const dbs: NtDb[] = [];
  try {
    const runId = newRunId();
    const admin = await openNtDb({ uri: rs.uri, dbName: rs.dbName, role: "gateway" });
    dbs.push(admin);
    const world = buildWorld(runId);
    await admin.obligations.insertMany(world.map((w) => w.ob));
    await admin.grants.insertOne({ _id: goodwillGrantId(runId), run_id: runId, kind: "GOODWILL_POOL", grant_minor: GRANT, held_minor: 0, settled_minor: 0, frozen: false, currency: "CAD", policy_version: "NT-GOODWILL@1" });
    const queue = shuffled(world, seed);

    const workers: { db: NtDb; gw: ReturnType<typeof createGateway> }[] = [];
    for (let w = 0; w < n; w++) {
      const db = await openNtDb({ uri: rs.uri, dbName: rs.dbName, role: "gateway" });
      dbs.push(db);
      workers.push({ db, gw: createGateway(depsFor(db, runId, `sweep-w${w}`)) });
    }

    // The poller: reads the grant document throughout the run (its own connection).
    let polling = true;
    let samples = 0;
    let maxTotal = 0;
    const pollDb = await openNtDb({ uri: rs.uri, dbName: rs.dbName, role: "gateway" });
    dbs.push(pollDb);
    const poller = (async () => {
      while (polling) {
        const g = await pollDb.grants.findOne({ _id: goodwillGrantId(runId) });
        if (g) {
          samples++;
          const total = g.held_minor + g.settled_minor;
          if (total > maxTotal) maxTotal = total;
          if (total > GRANT) bad("C1_poller_sample_over_cap", `held ${g.held_minor} + settled ${g.settled_minor} = ${total} > ${GRANT}`);
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    })();

    const results = new Map<string, string>();
    let next = 0;
    await Promise.all(
      workers.map(async (wk) => {
        for (;;) {
          const i = next++; // single-threaded JS: the shared cursor is atomic between awaits
          if (i >= queue.length) return;
          const item = queue[i]!;
          const r = await wk.gw.propose(proposalFor(item.ob));
          results.set(item.ob.effect_key, r.kind === "REFUSED" ? `REFUSED:${r.reason}` : r.kind);
        }
      }),
    );
    polling = false;
    await poller;
    rec.poller_samples = samples;
    rec.poller_max_total = maxTotal;

    // Final state.
    const g = (await admin.grants.findOne({ _id: goodwillGrantId(runId) }))!;
    rec.final_held = g.held_minor;
    rec.final_settled = g.settled_minor;
    const intents = await admin.intents.find({ run_id: runId }).toArray();
    const goodwill = intents.filter((i) => i.draws_on !== null);
    const sum = goodwill.reduce((s, i) => s + i.amount_minor, 0);
    rec.reserved_sum = sum;

    // 1
    if (g.held_minor + g.settled_minor > GRANT) bad("C1_final_cap", `held ${g.held_minor} + settled ${g.settled_minor} > ${GRANT}`);
    // 2: replay INTENT_RESERVED in _id order
    const ev = await admin.audit.find({ run_id: runId, type: "INTENT_RESERVED" }).sort({ _id: 1 }).toArray();
    const amountOf = new Map(intents.map((i) => [i._id, i.amount_minor]));
    let running = 0;
    for (const e of ev) {
      running += amountOf.get(e.intent_id ?? "") ?? 0;
      if (running > rec.replay_max_running_total) rec.replay_max_running_total = running;
      if (running > GRANT) bad("C2_replay_over_cap", `running total ${running} > ${GRANT} after event ${String(e._id)}`);
    }
    // 3 and 5
    if (g.held_minor !== sum) bad("C3_counter_vs_intents", `held_minor ${g.held_minor} != sum of goodwill intents ${sum}`);
    if (ev.length !== goodwill.length) bad("C5_no_held_without_intent", `${ev.length} INTENT_RESERVED events vs ${goodwill.length} goodwill intents`);
    if (g.held_minor > 0 && goodwill.length === 0) bad("C5_no_held_without_intent", `held ${g.held_minor} with no intent`);
    // 4
    const keys = new Set(intents.map((i) => i.effect_key));
    if (keys.size !== intents.length) bad("C4_one_intent_per_key_and_all_answered", `${intents.length} intents for ${keys.size} effect keys`);
    for (const v of results.values()) {
      if (v === "RESERVED") rec.reserved++;
      else if (v === "REFUSED:AWAITING_BUDGET") rec.awaiting_budget++;
      else rec.other_results++;
    }
    if (rec.other_results > 0 || rec.reserved + rec.awaiting_budget !== DEMAND_COUNT || results.size !== DEMAND_COUNT) {
      bad("C4_one_intent_per_key_and_all_answered", `results: reserved ${rec.reserved}, awaiting ${rec.awaiting_budget}, other ${rec.other_results}, answered ${results.size}/${DEMAND_COUNT}`);
    }
    if (rec.reserved !== goodwill.length) bad("C4_one_intent_per_key_and_all_answered", `${rec.reserved} proposals answered RESERVED but ${goodwill.length} goodwill intents exist`);
    // 6
    const room = GRANT - g.held_minor - g.settled_minor;
    for (const item of world) {
      if (results.get(item.ob.effect_key) === "REFUSED:AWAITING_BUDGET" && item.ob.amount_minor <= room) bad("C6_stranded_budget", `${item.ob.effect_key} (${item.ob.amount_minor}) awaiting budget but ${room} is free`);
    }
    // The gateway's own scan.
    const scan = await createGateway(depsFor(admin, runId, "sweep-scan")).scanInvariants(runId);
    rec.scan_ok = scan.ok;
    for (const v of scan.violations) {
      rec.scan_findings.push(`${v.code} ${v.detail}`.slice(0, 200));
      bad("SCAN_invariants", `${v.code} ${v.detail}`.slice(0, 160));
    }
  } catch (e) {
    rec.error = String((e as Error).message ?? e).slice(0, 400);
  } finally {
    await Promise.all(dbs.map((d) => d.close().catch(() => {})));
    await rs.stop().catch(() => {});
    rec.wall_ms = Date.now() - t0;
  }
  return rec;
}

// ------------------------------------------------------------------------------------------------ report

type Group = { n: number; label: string; records: RunRecord[] };

const total = (r: RunRecord) => Object.entries(r.violations).reduce((s, [k, v]) => s + (k === "SCAN_invariants" ? 0 : v), 0);
const violated = (r: RunRecord) => r.error !== null || Object.values(r.violations).some((v) => v > 0);

function perCondition(records: RunRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of CONDITIONS) out[c] = records.filter((r) => (r.violations[c] ?? 0) > 0).length;
  return out;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function markdown(groups: Group[], negatives: Group[], meta: Record<string, unknown>): string {
  const L: string[] = [];
  L.push("# Concurrency sweep: the goodwill cap under N concurrent proposers (task H3, Tier 2)", "");
  L.push(`Generated by \`pnpm sweep:concurrency\` at ${String(meta.finished_at)}; commit \`${String(meta.commit)}\`${meta.dirty ? " (working tree had uncommitted changes)" : ""}.`, "");
  L.push(
    `World: 50 goodwill obligations (25 of 15000 OVERNIGHT_STRANDED, 25 of 20000 MOBILITY_ASSIST; demand 875000), one grant of ${GRANT} (60% of demand). N workers drain one shared queue of the 50 proposals, shuffled with a per-repetition seed (recorded in the JSON), each calling the gateway's \`propose()\` on its own database connection. N = 1 is the sequential control. Every repetition has a fresh in-memory replica set. The workers are concurrent async callers inside one Node process, not separate OS processes.`,
    "",
  );
  L.push("Conditions checked per run: (1) held + settled <= grant at the end and in every sample of a poller reading the grant document throughout; (2) replaying INTENT_RESERVED events in `_id` order the running total never exceeds the grant; (3) `held_minor` equals the sum of the goodwill intents; (4) one intent per effect key, and all 50 proposals answered RESERVED or AWAITING_BUDGET; (5) no held amount without its intent; (6) no proposal left awaiting budget would still fit; plus the gateway's invariant scan (P1, P2, P3, P9).", "");
  L.push("## Unmutated gateway", "");
  L.push("| N workers | Runs executed | Runs with a violation | Violations by condition (runs) | Reserved per run (min-max) | Awaiting budget per run (min-max) | Poller samples (total) | Max held+settled seen by the poller | Wall time per run (median ms) | Run errors |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const g of groups) {
    const rs = g.records;
    const pc = perCondition(rs);
    const parts = Object.entries(pc).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`);
    const minmax = (f: (r: RunRecord) => number) => `${Math.min(...rs.map(f))}-${Math.max(...rs.map(f))}`;
    const med = [...rs.map((r) => r.wall_ms)].sort((a, b) => a - b)[Math.floor(rs.length / 2)] ?? 0;
    L.push(`| ${g.n}${g.n === 1 ? " (sequential control)" : ""} | ${rs.length} | ${rs.filter(violated).length} | ${parts.join(", ") || "none"} | ${minmax((r) => r.reserved)} | ${minmax((r) => r.awaiting_budget)} | ${rs.reduce((s, r) => s + r.poller_samples, 0)} | ${Math.max(...rs.map((r) => r.poller_max_total))} | ${med} | ${rs.filter((r) => r.error).length} |`);
  }
  L.push("");
  L.push("Reading the table (TEST_PLAN 4.3): zero violations in n independent runs supports only an approximate 95% upper bound of 3/n on the per-run failure rate, stated per N and not pooled across N. This is sampled evidence that the implementation matches the guarded-update argument for P2, not a proof.", "");
  for (const g of groups) {
    const n = g.records.length;
    const viol = g.records.filter(violated).length;
    L.push(`- N = ${g.n}: ${viol} violations in ${n} runs${viol === 0 ? ` (approximate 95% upper bound on the per-run failure rate: 3/${n} = ${((3 / n) * 100).toFixed(1)}%)` : ""}.`);
  }
  L.push("");
  L.push("## Negative control: the same sweep with `NT_MUTATION=M1` (the goodwill guard removed from the reserve transaction)", "");
  L.push("| N workers | Runs | Runs that broke the cap (condition 1 final, poller sample, or condition 2 replay) | Runs flagged by the invariant scan | Final held in these runs (min-max) | Replay running total (max) |", "|---|---|---|---|---|---|");
  for (const g of negatives) {
    const rs = g.records;
    const broke = rs.filter((r) => (r.violations["C1_final_cap"] ?? 0) + (r.violations["C1_poller_sample_over_cap"] ?? 0) + (r.violations["C2_replay_over_cap"] ?? 0) > 0).length;
    L.push(`| ${g.n} | ${rs.length} | ${broke} | ${rs.filter((r) => (r.violations["SCAN_invariants"] ?? 0) > 0).length} | ${Math.min(...rs.map((r) => r.final_held))}-${Math.max(...rs.map((r) => r.final_held))} | ${Math.max(...rs.map((r) => r.replay_max_running_total))} |`);
  }
  L.push("");
  const anyOk = negatives.length > 0;
  const allBroke = negatives.every((g) => g.records.every((r) => total(r) > 0));
  L.push(
    anyOk
      ? allBroke
        ? "With the guard removed every negative-control run broke the cap, so the sweep does measure the guard. (With one proposer (N = 1) a removed guard still lets all 50 reservations through one after another: the sweep catches the mutant at every N because the pool is 60% of demand, not because of the concurrency alone.)"
        : "Not every negative-control run broke the cap: see the table above; the unmutated results are only as informative as this control."
      : "No negative control was run in this invocation.",
    "",
  );
  L.push(`Environment: ${String(meta.environment)}. Wall time ${(Number(meta.wall_ms) / 60000).toFixed(1)} min.`, "");
  return L.join("\n");
}

// ------------------------------------------------------------------------------------------------ main

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2), ["runs", "ns", "seed", "negative-runs", "out-name", "parallel"]);
  const runs = Number(a.values.get("runs") ?? 20);
  const ns = (a.values.get("ns") ?? "1,5,10,25,50").split(",").map(Number);
  const baseSeed = Number(a.values.get("seed") ?? 20261114);
  const negRuns = Number(a.values.get("negative-runs") ?? 1);
  const outName = a.values.get("out-name") ?? "concurrency-sweep";
  const t0 = Date.now();
  if (process.env.NT_MUTATION) console.error(`note: NT_MUTATION=${process.env.NT_MUTATION} is set in the environment; it applies to every run of this invocation`);
  const preset = process.env.NT_MUTATION ?? null;

  const groups: Group[] = [];
  const negatives: Group[] = [];
  // Unmutated runs: NT_MUTATION must not be set.
  delete process.env.NT_MUTATION;
  for (const n of ns) {
    const g: Group = { n, label: `N=${n}`, records: [] };
    for (let rep = 0; rep < runs; rep++) {
      const r = await oneRun(n, rep, baseSeed + n * 1000 + rep, null);
      g.records.push(r);
      console.error(`N=${n} rep ${rep + 1}/${runs}: reserved ${r.reserved}, awaiting ${r.awaiting_budget}, held ${r.final_held}, ${violated(r) ? `VIOLATION ${r.error ?? r.violation_detail.join(" | ")}` : "ok"} (${r.wall_ms} ms)`);
    }
    groups.push(g);
  }
  // Negative control: the guard removed.
  if (negRuns > 0) {
    process.env.NT_MUTATION = "M1";
    for (const n of ns) {
      const g: Group = { n, label: `N=${n} M1`, records: [] };
      for (let rep = 0; rep < negRuns; rep++) {
        const r = await oneRun(n, rep, baseSeed + 500_000 + n * 1000 + rep, "M1");
        g.records.push(r);
        console.error(`M1 N=${n} rep ${rep + 1}/${negRuns}: held ${r.final_held}, ${violated(r) ? `RED ${r.violation_detail.slice(0, 2).join(" | ")}` : "STAYED GREEN"} (${r.wall_ms} ms)`);
      }
      negatives.push(g);
    }
    delete process.env.NT_MUTATION;
  }
  void preset;
  const meta = {
    finished_at: new Date().toISOString(),
    commit: git(["rev-parse", "--short", "HEAD"]),
    dirty: git(["status", "--porcelain", "--", "packages", "apps", "scripts/concurrency-sweep.ts"]) !== "",
    environment: `node ${process.version}, ${process.platform}/${process.arch}, mongodb-memory-server single-node replica set per repetition`,
    wall_ms: Date.now() - t0,
    base_seed: baseSeed,
    runs_per_n: runs,
    grant_minor: GRANT,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${outName}.json`);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify({ meta, groups, negatives }, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, `${outName}.md`), markdown(groups, negatives, meta));
  const summary = groups.map((g) => `N=${g.n}: ${g.records.filter(violated).length} violations in ${g.records.length} runs`).join("; ");
  const negSummary = negatives.map((g) => `N=${g.n}: ${g.records.filter((r) => total(r) > 0).length}/${g.records.length} red`).join("; ");
  console.log(`concurrency sweep: ${summary}`);
  if (negatives.length > 0) console.log(`negative control (NT_MUTATION=M1): ${negSummary}`);
  console.log(`wrote out/sweeps/${outName}.md and .json`);
  const anyViolation = groups.some((g) => g.records.some(violated));
  const negFail = negatives.some((g) => g.records.some((r) => total(r) === 0));
  return anyViolation || negFail ? 1 : 0;
}

await runMain(main);
