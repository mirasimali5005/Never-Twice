// Task F4 / EVL-17: the auditor's Stripe refund reader.
//   F4-UNIT-01 key guard (^rk_test_ only; refused before any request, exit 2 through the CLI).
//   F4-UNIT-02 mapping and status filter from recorded-shape refund objects written by hand.
//   Pagination and Basic auth against a stub node:http server that speaks the refund-list shape.
//   EVL-17 through the real CLI: one refund of 41260 carrying K03R's marker → PASS; two such refunds → FAIL(C1).
//   F4-INT-01 (live, gated on EVAL_STRIPE_KEY): one read-only GET of the real refund list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStripeKey, listRefundsPage, refundToLedgerObject, resolveApiBase, stripeLedgerSource } from "../src/ledger-stripe.ts";
import { LedgerError, isPayment } from "../src/ledger.ts";
import { stubSim, simObj } from "./fixtures/stub-sim.ts";
import { EVAL_DIR, K, opsRecordPath } from "./fixtures/synthetic.ts";

const RUN = "r7k2m9qa";
const KEY = "rk_test_auditorstub0001";

/** A refund object in the shape Stripe's list returns (recorded shape, written by hand). */
function refund(id: string, opts: { run?: string | null; key?: string | null; amount?: number; status?: string; payee?: string | null; pi?: unknown } = {}): Record<string, unknown> {
  const run = opts.run === undefined ? RUN : opts.run;
  const key = opts.key === undefined ? K.P03R : opts.key;
  const metadata: Record<string, string> = {};
  if (run !== null) metadata.nt_run_id = run;
  if (key !== null) { metadata.nt_effect_key = key; metadata.nt_marker = `${run}:${key}`; }
  if (opts.payee !== null) metadata.nt_payee_ref = opts.payee ?? "payee_P03";
  return {
    id, object: "refund", amount: opts.amount ?? 41260, balance_transaction: "txn_x", charge: "ch_x", created: 1794679200, currency: "cad",
    destination_details: { card: { type: "refund" }, type: "card" }, metadata, payment_intent: opts.pi === undefined ? "pi_3K03R" : opts.pi,
    reason: "requested_by_customer", receipt_number: null, source_transfer_reversal: null, status: opts.status ?? "succeeded", transfer_reversal: null,
  };
}

/** Stub Stripe API: GET /v1/refunds only, Basic auth, newest-first list paged by starting_after, at most `pageSize` per page. */
function stubStripe(refunds: Record<string, unknown>[], key: string, pageSize = 2) {
  const seen: { url: string; auth: string | undefined; method: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization, method: req.method ?? "" });
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Basic ${Buffer.from(`${key}:`).toString("base64")}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid API Key provided: rk_test_****0001" } }));
      return;
    }
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method !== "GET" || u.pathname !== "/v1/refunds") { res.statusCode = 404; res.end("{}"); return; }
    const limit = Math.min(Number(u.searchParams.get("limit") ?? "10"), pageSize);
    const after = u.searchParams.get("starting_after");
    const start = after ? refunds.findIndex((r) => r.id === after) + 1 : 0;
    const page = refunds.slice(start, start + limit);
    res.end(JSON.stringify({ object: "list", data: page, has_more: start + limit < refunds.length, url: "/v1/refunds" }));
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// F4-UNIT-01 key guard
// ---------------------------------------------------------------------------------------------

test("F4-UNIT-01 key guard: only rk_test_ is accepted; sk_ and live keys are refused and never echoed", () => {
  assert.doesNotThrow(() => assertStripeKey("rk_test_abc123"));
  const refused = ["sk_test_secret987", "sk_live_secret987", "rk_live_secret987", "pk_test_pub987", "pk_live_pub987", "whatever987", "", undefined];
  for (const k of refused) {
    assert.throws(() => assertStripeKey(k), (e: unknown) => e instanceof LedgerError && (k === undefined || k === "" || !e.message.includes(k)), String(k));
    assert.throws(() => stripeLedgerSource({ key: k }), LedgerError);
  }
  assert.throws(() => assertStripeKey("sk_live_x1"), /LIVE key/);
  assert.throws(() => assertStripeKey("sk_test_x1"), /secret \(sk_test_\) key/);
});

test("F4-UNIT-01 a refused key makes no request at all", async () => {
  const s = await stubStripe([refund("re_1")], KEY);
  try {
    await assert.rejects(listRefundsPage({ key: "sk_test_nope", apiBase: s.url }, { limit: 1 }), LedgerError);
    assert.throws(() => stripeLedgerSource({ key: "rk_live_nope", apiBase: s.url }), LedgerError);
    assert.equal(s.seen.length, 0);
  } finally { await s.close(); }
});

test("the API base override accepts only loopback hosts", () => {
  assert.equal(resolveApiBase(undefined), "https://api.stripe.com");
  assert.equal(resolveApiBase("http://127.0.0.1:4242/"), "http://127.0.0.1:4242");
  assert.throws(() => resolveApiBase("https://evil.example.com"), LedgerError);
  assert.throws(() => resolveApiBase("not a url"), LedgerError);
});

// ---------------------------------------------------------------------------------------------
// F4-UNIT-02 mapping and status filter
// ---------------------------------------------------------------------------------------------

test("F4-UNIT-02 maps a refund to the evaluator's LedgerObject", () => {
  const o = refundToLedgerObject(refund("re_3K03R"), "r");
  assert.deepEqual(o, {
    source: "stripe", id: "re_3K03R", kind: "refund", status: "succeeded", amount_minor: 41260, currency: "CAD",
    payee_ref: "payee_P03", parent_ref: "pi_3K03R",
    metadata: { nt_run_id: RUN, nt_effect_key: K.P03R, nt_marker: `${RUN}:${K.P03R}`, nt_payee_ref: "payee_P03" },
    created_at: new Date(1794679200 * 1000).toISOString(),
  });
  assert.equal(refundToLedgerObject(refund("re_a", { pi: { id: "pi_expanded", object: "payment_intent" } }), "r").parent_ref, "pi_expanded");
  assert.equal(refundToLedgerObject(refund("re_b", { pi: null }), "r").parent_ref, null);
  assert.equal(refundToLedgerObject(refund("re_c", { payee: null }), "r").payee_ref, null, "no nt_payee_ref → null (a C9 finding)");
  assert.throws(() => refundToLedgerObject({ ...refund("re_d"), object: "charge" }, "r"), LedgerError);
  assert.throws(() => refundToLedgerObject({ ...refund("re_e"), amount: "41260" }, "r"), LedgerError);
  assert.throws(() => refundToLedgerObject({ ...refund("re_f"), metadata: [] }, "r"), LedgerError);
});

test("F4-UNIT-02 status filter: succeeded and pending count as payments; failed, canceled, requires_action do not", () => {
  const counts = (status: string) => isPayment(refundToLedgerObject(refund("re_s", { status }), "r"));
  assert.equal(counts("succeeded"), true);
  assert.equal(counts("pending"), true);
  assert.equal(counts("failed"), false);
  assert.equal(counts("canceled"), false);
  assert.equal(counts("requires_action"), false);
});

// ---------------------------------------------------------------------------------------------
// Pagination and authentication against a stub server
// ---------------------------------------------------------------------------------------------

test("reads every page with Basic auth, GET only, keeps only the run's refunds", async () => {
  const all = [
    refund("re_1"),
    refund("re_2", { run: "rother01" }),
    refund("re_3", { key: K.P02, amount: 70000, payee: "payee_P02" }),
    { ...refund("re_4", { run: null, key: null, payee: null }) },
    refund("re_5", { status: "failed" }),
  ];
  const s = await stubStripe(all, KEY, 2);
  try {
    const got = await stripeLedgerSource({ key: KEY, apiBase: s.url }).readAll(RUN);
    assert.deepEqual(got.map((o) => o.id), ["re_1", "re_3", "re_5"]);
    assert.equal(s.seen.length, 3);
    assert.ok(s.seen.every((r) => r.method === "GET" && r.auth === `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`));
    assert.ok(s.seen.every((r) => r.url.startsWith("/v1/refunds?") && r.url.includes("limit=100")));
    assert.ok(!s.seen[0].url.includes("starting_after"));
    assert.ok(s.seen[1].url.includes("starting_after=re_2"), "cursor is the last object of the page, kept or not");
    assert.ok(s.seen[2].url.includes("starting_after=re_4"));
    assert.ok(got.every((o) => o.source === "stripe" && o.kind === "refund" && o.currency === "CAD"));
  } finally { await s.close(); }
});

test("a rejected key, a malformed body and a stuck cursor are LedgerErrors; the key and Stripe's message are not echoed", async () => {
  const s = await stubStripe([refund("re_1")], KEY);
  try {
    const wrong = "rk_test_wrongkey42";
    await assert.rejects(stripeLedgerSource({ key: wrong, apiBase: s.url }).readAll(RUN), (e: unknown) =>
      e instanceof LedgerError && /HTTP 401 \(key rejected\)/.test(e.message) && !e.message.includes(wrong) && !e.message.includes("****"));
  } finally { await s.close(); }

  const fake = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  await assert.rejects(stripeLedgerSource({ key: KEY, fetchImpl: fake({ data: [] }) }).readAll(RUN), LedgerError);
  await assert.rejects(stripeLedgerSource({ key: KEY, fetchImpl: fake({ object: "list", data: [], has_more: true }) }).readAll(RUN), /has_more/);
  await assert.rejects(stripeLedgerSource({ key: KEY, fetchImpl: fake({ object: "list", data: [refund("re_1"), refund("re_1")], has_more: false }) }).readAll(RUN), /twice/);
  await assert.rejects(stripeLedgerSource({ key: KEY, apiBase: "http://127.0.0.1:9", timeoutMs: 2000 }).readAll(RUN), /unreachable/);
});

// ---------------------------------------------------------------------------------------------
// EVL-17 through the real CLI
// ---------------------------------------------------------------------------------------------

const CLI = join(EVAL_DIR, "src", "cli.ts");
const GROUP = "gstrip01";
const ACCT = `acct_${RUN}`;

function cli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? (err as { code?: number }).code ?? -1 : 0, stdout, stderr });
    });
  });
}

test("EVL-17 check with the Stripe reader: one refund → PASS; two refunds for K03R → FAIL(C1); bad key → exit 2 with no request", async () => {
  const simLedger = [
    simObj(ACCT, "po_11", K.P11, 90000, "payee_P11"),
    simObj(ACCT, "po_13", K.P13, 70000, "payee_P13"),
    simObj(ACCT, "po_02", K.P02, 70000, "payee_P02"),
    simObj(ACCT, "po_03", K.P03C, 40000, "payee_P03"),
  ];
  const sim = await stubSim(simLedger, "evalread", 2);
  const out = mkdtempSync(join(tmpdir(), "nt-eval-stripe-"));
  const common = ["--out-dir", out, "--ops-record", opsRecordPath("S0")];
  const report = () => {
    const paid = simLedger.map((o) => {
      const key = (o.metadata as Record<string, string>).nt_effect_key;
      return { effect_key: key, marker: `${RUN}:${key}`, amount_minor: o.amount_minor, currency: "CAD", payee_ref: o.payee_ref,
        provider: key === K.P11 ? "sim_keyless" : "sim_payout", provider_object_id: o.id };
    });
    paid.push({ effect_key: K.P03R, marker: `${RUN}:${K.P03R}`, amount_minor: 41260, currency: "CAD", payee_ref: "payee_P03", provider: "stripe_refund", provider_object_id: "re_3K03R" });
    const p = join(out, `report-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify({ run_id: RUN, group_id: GROUP, arm: "nt", scenario: "S0", generated_at: "2026-11-14T18:02:20.511Z", complete: true, paid,
      refused: [{ effect_key: K.P04, reason_code: "DELAY_UNDER_3H", rule_citation: "s. 19(1)" }], parked: [], awaiting_budget: [], failed_no_effect: [], unresolved: [] }));
    return p;
  };
  const one = await stubStripe([refund("re_other", { run: "rother01" }), refund("re_3K03R"), refund("re_old", { run: "rother02" })], KEY, 2);
  const two = await stubStripe([refund("re_3K03R"), refund("re_3K03Rdup")], KEY, 2);
  try {
    const m = await cli(["manifest", "--scenario", "S0", "--group", GROUP, ...common], {});
    assert.equal(m.code, 0, m.stderr);
    const env = (s: { url: string }, key = KEY) => ({ EVAL_SIM_URL: sim.url, EVAL_SIM_READ_KEY: "evalread", EVAL_STRIPE_KEY: key, EVAL_STRIPE_API_BASE: s.url });

    const a = await cli(["check", "--run", RUN, "--report", report(), ...common], env(one));
    assert.equal(a.code, 0, a.stderr + a.stdout);
    assert.match(a.stdout, /SAFETY: PASS/);
    assert.match(a.stdout, /Stripe test mode: 1 refund\(s\)/);
    assert.match(a.stdout, /Note: Stripe test mode: 1 refund object\(s\) with metadata\.nt_run_id r7k2m9qa read from the top-level refund list/);
    const cert = JSON.parse(readFileSync(join(out, `${RUN}.certificate.json`), "utf8"));
    assert.equal(cert.ledger.stripe_objects, 1);
    assert.equal(cert.ledger.sim_objects, 4);
    assert.deepEqual(cert.completion.owed_paid, [5, 5]);
    assert.ok(one.seen.every((r) => r.method === "GET"));

    const b = await cli(["check", "--run", RUN, "--report", report(), ...common], env(two));
    assert.equal(b.code, 1, b.stderr + b.stdout);
    const certB = JSON.parse(readFileSync(join(out, `${RUN}.certificate.json`), "utf8"));
    assert.equal(certB.checks.C1.status, "FAIL");
    assert.deepEqual(certB.findings.filter((f: { check: string }) => f.check === "C1").map((f: { provider_object_ids: string[] }) => f.provider_object_ids), [["re_3K03R", "re_3K03Rdup"]]);

    const before = one.seen.length;
    for (const bad of ["sk_test_notallowed1", "sk_live_notallowed2", "rk_live_notallowed3"]) {
      const c = await cli(["check", "--run", RUN, "--report", report(), ...common], env(one, bad));
      assert.equal(c.code, 2, bad);
      assert.match(c.stdout, /not graded/);
      assert.ok(!c.stderr.includes(bad) && !c.stdout.includes(bad), "key never echoed");
      assert.equal(existsSync(join(out, `${RUN}.certificate.json`)), false);
    }
    assert.equal(one.seen.length, before, "no request with a refused key");
    assert.equal(sim.seen.length > 0, true);

    const d = await cli(["check", "--run", RUN, "--report", report(), ...common], { ...env(one), EVAL_STRIPE_API_BASE: "https://example.com" });
    assert.equal(d.code, 2);
  } finally {
    await one.close(); await two.close(); await sim.close();
  }
});

// ---------------------------------------------------------------------------------------------
// F4-INT-01 live, read-only (gated on EVAL_STRIPE_KEY; reported as skipped when unset)
// ---------------------------------------------------------------------------------------------

const LIVE_KEY = process.env.EVAL_STRIPE_KEY;

test("F4-INT-01 live: GET /v1/refunds?limit=1 on Stripe test mode returns 200 (may be empty)", { skip: LIVE_KEY ? false : "EVAL_STRIPE_KEY not set: NOT RUN", timeout: 60_000 }, async () => {
  const { status, body } = await listRefundsPage({ key: LIVE_KEY! }, { limit: 1 });
  assert.equal(status, 200, `HTTP ${status}: ${JSON.stringify((body as { error?: { type?: string; code?: string } })?.error?.type ?? null)}`);
  const b = body as { object: string; data: unknown[]; has_more: boolean };
  assert.equal(b.object, "list");
  assert.ok(Array.isArray(b.data) && b.data.length <= 1);
  for (const r of b.data) refundToLedgerObject(r, "live data[0]");   // the real shape maps
});
