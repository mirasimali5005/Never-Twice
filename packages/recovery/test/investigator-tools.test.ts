// D3: the read-only evidence tools and the collector (HANDOVER.md §11.2; SEC-11: the tool layer holds no write path).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INVESTIGATION_TOOLS } from "@nt/contracts";
import { describe, expect, it } from "vitest";
import { EvidenceCollector, TOOL_CATALOGUE, createReadOnlyEvidenceTools, defaultListSince } from "../src/investigator/index.ts";
import { FakeProvider, payout } from "./investigator-fakes.ts";
import { T0, makeIntent, objectFor } from "./support/fixtures.ts";

function setup(n = 25) {
  const it = makeIntent("sim_payout");
  const p = new FakeProvider("acct_test");
  p.objects = Array.from({ length: n }, (_, i) => payout(i + 1));
  return { it, p, tools: createReadOnlyEvidenceTools(it, p) };
}

describe("read-only evidence tools", () => {
  it("expose exactly the four read tools and no write method", () => {
    const { tools, p } = setup();
    expect(Object.keys(tools).sort()).toEqual([...INVESTIGATION_TOOLS].sort());
    expect(Object.isFrozen(tools)).toBe(true);
    for (const k of Object.keys(tools)) expect(k).not.toMatch(/create|post|send|write|refund|dispatch/i);
    expect((tools as unknown as Record<string, unknown>).createPaymentOrRefund).toBeUndefined();
    // Nothing reachable from the tools object is the provider itself.
    for (const v of Object.values(tools)) expect(v).not.toBe(p);
    expect(TOOL_CATALOGUE.map((t) => t.name).sort()).toEqual([...INVESTIGATION_TOOLS].sort());
  });

  it("get_intent_summary carries no credential and no frozen body", async () => {
    const { tools, it: intent } = setup();
    const s = await tools.get_intent_summary();
    expect(s).toMatchObject({ _id: intent._id, provider: "sim_payout", rail: "instant", amount_minor: 70000, currency: "CAD", payee_ref: "payee_P13" });
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/frozen_request|idempotency_key|key|secret|sk_test|mongodb/i);
  });

  it("list by payee pages with a cursor, is bound to the intent's payee and account", async () => {
    const { tools, p } = setup(25);
    p.objects.push(payout(90, { payee_ref: "payee_OTHER" }));
    const first = await tools.list_provider_payments_by_payee({ limit: 10 });
    expect(first.records).toHaveLength(10);
    expect(first.has_more).toBe(true);
    const third = await tools.list_provider_payments_by_payee({ limit: 10, starting_after: "po_0020" });
    expect(third.records.map((r) => r.id)).toEqual(["po_0021", "po_0022", "po_0023", "po_0024", "po_0025"]);
    expect(third.has_more).toBe(false);
    expect(third.next_cursor).toBeNull();
    const all = await tools.list_provider_payments_by_payee({});
    expect(all.records.every((r) => r.payee_ref === "payee_P13")).toBe(true);
    await expect(tools.list_provider_payments_by_payee({ starting_after: "po_nope" })).rejects.toThrow(/cursor/);
  });

  it("the default window is first_dispatch_at minus 60 s", () => {
    expect(defaultListSince(makeIntent()).toISOString()).toBe(new Date(T0.getTime() - 60_000).toISOString());
  });

  it("search lags: a recent object is missing from search and present in the list", async () => {
    const { it: intent, p, tools } = setup(3);
    p.objects.push(objectFor(intent, { created_at: new Date(p.now.getTime() - 1000).toISOString() }));
    expect((await tools.search_provider_payments()).records).toHaveLength(0);
    expect((await tools.list_provider_payments_by_payee({})).records.some((r) => r.metadata.nt_marker === intent._id)).toBe(true);
  });

  it("events return [] when the provider has no event log", async () => {
    const intent = makeIntent();
    const fp = new FakeProvider();
    // Only the three PaymentProvider read methods: no search, no event log.
    const view = { getOperation: fp.getOperation.bind(fp), findOperationEvidence: fp.findOperationEvidence.bind(fp), listOperations: fp.listOperations.bind(fp) };
    const tools = createReadOnlyEvidenceTools(intent, view);
    expect(await tools.list_provider_events!({})).toEqual({ events: [] });
    expect(await tools.search_provider_payments()).toEqual({ records: [] });
  });
});

describe("evidence collector", () => {
  it("de-duplicates by id, logs a step per call, and drops unknown tools and bad args", async () => {
    const { it: intent, tools } = setup(5);
    const c = new EvidenceCollector(intent);
    await c.run(tools, "list_provider_payments_by_payee", {});
    await c.run(tools, "list_provider_payments_by_payee", { all_pages: true });
    expect(c.recordCount).toBe(5);
    expect(await c.run(tools, "create_payout", {})).toMatchObject({ ok: false, error: expect.stringMatching(/unknown tool/) });
    expect(await c.run(tools, "list_provider_payments_by_payee", { payee_ref: "payee_EVIL" })).toMatchObject({ ok: false, error: expect.stringMatching(/invalid args/) });
    expect(await c.run(tools, "list_provider_payments_by_payee", { limit: 1000 })).toMatchObject({ ok: false });
    const r = c.result("llm", "h");
    expect(r.steps.map((s) => s.tool)).toEqual(["list_provider_payments_by_payee", "list_provider_payments_by_payee", "create_payout", "list_provider_payments_by_payee", "list_provider_payments_by_payee"]);
    expect(r.records).toHaveLength(5);
    expect(r.complete).toBe(true);
    // The returned records are copies; mutating them does not change the collector.
    r.records[0]!.amount_minor = 1;
    expect(c.records()[0]!.amount_minor).toBe(40000);
  });

  it("complete is false when the list window starts after first_dispatch_at minus the margin, or a page fails", async () => {
    const { it: intent, p, tools } = setup(25);
    const late = new EvidenceCollector(intent);
    await late.run(tools, "list_provider_payments_by_payee", { created_gte: new Date(T0.getTime() + 1000).toISOString(), all_pages: true });
    expect(late.result("llm", null).complete).toBe(false);
    p.failOnPage = 2;
    const failed = new EvidenceCollector(intent);
    expect((await failed.run(tools, "list_provider_payments_by_payee", { all_pages: true, limit: 10 })).ok).toBe(false);
    expect(failed.result("deterministic", null).complete).toBe(false);
  });
});

describe("investigator import boundary", () => {
  const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/investigator");
  it("never imports @nt/providers, the SDK, a database driver or child_process, and never names createPaymentOrRefund as a call", () => {
    const files = readdirSync(DIR, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(DIR, f), "utf8");
      expect(src, f).not.toMatch(/from\s+["']@nt\/providers|@anthropic-ai|["']mongodb["']|child_process|node:child_process/);
      expect(src, f).not.toMatch(/\.createPaymentOrRefund\s*\(/);
    }
  });
});
