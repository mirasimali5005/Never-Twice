// D3: the deterministic investigator and createInvestigator (HANDOVER.md §11.2).
import type { Investigator } from "@nt/contracts";
import { describe, expect, it } from "vitest";
import { matchEvidence } from "../src/pure/index.ts";
import { DETERMINISTIC_HYPOTHESIS, createDeterministicInvestigator, createInvestigator, createReadOnlyEvidenceTools } from "../src/investigator/index.ts";
import { FakeModel, FakeProvider, ok, payout } from "./investigator-fakes.ts";
import { T0, makeIntent, objectFor } from "./support/fixtures.ts";

function world(n = 25, targetAt = 23) {
  const it = makeIntent("sim_payout");
  const p = new FakeProvider("acct_test");
  p.objects = Array.from({ length: n }, (_, i) => (i + 1 === targetAt ? objectFor(it, { id: "po_target", created_at: payout(i + 1).created_at }) : payout(i + 1)));
  return { it, p };
}

describe("deterministic investigator", () => {
  it("finds the marked object on page three by following pagination to the end", async () => {
    const { it: intent, p } = world(25, 23);
    const inv = createDeterministicInvestigator({ pageSize: 10 });
    const ev = await inv.collect(intent, createReadOnlyEvidenceTools(intent, p), { timeoutMs: 45_000 });
    expect(ev.investigator).toBe("deterministic");
    expect(ev.hypothesis).toBe(DETERMINISTIC_HYPOTHESIS);
    expect(ev.records).toHaveLength(25);
    expect(ev.complete).toBe(true);
    expect(ev.steps).toHaveLength(1);
    expect(ev.steps[0]).toMatchObject({ tool: "list_provider_payments_by_payee", record_count: 25 });
    expect(ev.steps[0]!.summary).toMatch(/3 page\(s\).*reached last page/);
    expect(ev.steps[0]!.input).toMatchObject({ created_gte: new Date(T0.getTime() - 60_000).toISOString(), all_pages: true });
    const m = matchEvidence(intent, ev.records);
    expect(m).toMatchObject({ kind: "MATCH", object: { id: "po_target" } });
    expect(p.writes).toBe(0);
  });

  it("a first page alone would miss the target", async () => {
    const { it: intent, p } = world(25, 23);
    const page1 = await createReadOnlyEvidenceTools(intent, p).list_provider_payments_by_payee({ limit: 10 });
    expect(matchEvidence(intent, page1.records).kind).toBe("NO_MATCH");
  });

  it("tolerates a failed page: keeps what was read, complete is false, never throws", async () => {
    const { it: intent, p } = world(25, 5);
    p.failOnPage = 3;
    const ev = await createDeterministicInvestigator({ pageSize: 10 }).collect(intent, createReadOnlyEvidenceTools(intent, p), { timeoutMs: 1000 });
    expect(ev.complete).toBe(false);
    expect(ev.records.length).toBeGreaterThanOrEqual(10);
    expect(ev.steps[0]!.summary).toMatch(/failed/);
    expect(matchEvidence(intent, ev.records).kind).toBe("MATCH");
  });

  it("an empty list is NO_MATCH with complete true (absence is for decideRecovery to weigh, not a verdict here)", async () => {
    const it2 = makeIntent();
    const ev = await createInvestigator({ mode: "deterministic", provider: new FakeProvider() }).collectFor(it2);
    expect(ev.records).toEqual([]);
    expect(ev.complete).toBe(true);
    expect(matchEvidence(it2, ev.records).kind).toBe("NO_MATCH");
  });

  it("createInvestigator(deterministic).collectFor binds the tools to the intent and never writes", async () => {
    const { it: intent, p } = world(12, 12);
    const inv = createInvestigator({ mode: "deterministic", provider: p, pageSize: 5 });
    const asContract: Investigator = inv; // compile-time: assignable to the contracts Investigator
    expect(asContract.kind).toBe("deterministic");
    expect(inv.timeoutMs).toBe(45_000);
    const ev = await inv.collectFor(intent);
    expect(matchEvidence(intent, ev.records).kind).toBe("MATCH");
    expect(p.writes).toBe(0);
    expect(p.calls.every((c) => c === "listOperations")).toBe(true);
  });
});

const LIST_ALL = { tool: "list_provider_payments_by_payee", args: { all_pages: true, limit: 10 } };

function llm(script: ConstructorParameters<typeof FakeModel>[0], n = 25, targetAt = 23, timeoutMs = 2000) {
  const w = world(n, targetAt);
  const model = new FakeModel(script);
  const inv = createInvestigator({ mode: "llm", provider: w.p, model, timeoutMs, pageSize: 10 });
  return { ...w, model, inv };
}

describe("model-driven investigator (plan then execute)", () => {
  it("runs the model's plan through fixed code; call 2 adds a query; records come only from the tools", async () => {
    const { it: intent, p, model, inv } = llm([
      ok({ hypothesis: "response lost after apply", queries: [{ tool: "search_provider_payments", args: {} }, LIST_ALL] }),
      ok({ queries: [{ tool: "list_provider_events", args: {} }] }),
    ]);
    expect(inv.kind).toBe("llm");
    const ev = await inv.collectFor(intent);
    expect(ev.investigator).toBe("llm");
    expect(ev.hypothesis).toBe("response lost after apply");
    expect(ev.fallback_reason).toBeNull();
    expect(ev.steps.map((s) => s.tool)).toEqual(["get_intent_summary", "search_provider_payments", "list_provider_payments_by_payee", "list_provider_events"]);
    expect(ev.records).toHaveLength(25);
    expect(ev.complete).toBe(true);
    expect(matchEvidence(intent, ev.records)).toMatchObject({ kind: "MATCH", object: { id: "po_target" } });
    expect(model.requests).toHaveLength(2);
    // The prompt: intent summary and catalogue only, effort medium, no account, no key material, an explicit no-verdict rule.
    const r1 = model.requests[0]!;
    expect(r1.effort).toBe("medium");
    expect(r1.system).toMatch(/Do NOT state a verdict/);
    const text = r1.system + r1.messages.map((m) => m.content).join("\n");
    expect(text).toContain(intent._id);
    expect(text).not.toMatch(/acct_test|frozen_request|sk_test|rk_test|NT_SIM|mongodb/i);
    expect(p.writes).toBe(0);
  });

  it("drops a query naming an unknown tool or bad args, notes it, and runs the rest", async () => {
    const { it: intent, inv } = llm([
      ok({
        hypothesis: "never arrived",
        queries: [
          { tool: "create_payout", args: { amount_minor: 1 } },
          { tool: "list_provider_payments_by_payee", args: { payee_ref: "payee_EVIL" } },
          LIST_ALL,
        ],
      }),
      ok({ queries: [] }),
    ]);
    const ev = await inv.collectFor(intent);
    expect(ev.investigator).toBe("llm");
    const dropped = ev.steps.filter((s) => s.summary.startsWith("dropped"));
    expect(dropped.map((s) => s.tool)).toEqual(["create_payout", "list_provider_payments_by_payee"]);
    expect(dropped[0]!.summary).toMatch(/unknown tool/);
    expect(dropped[1]!.summary).toMatch(/invalid args/);
    expect(matchEvidence(intent, ev.records).kind).toBe("MATCH");
  });

  it("a plan with only invalid queries falls back to the deterministic investigator", async () => {
    const { it: intent, inv } = llm([ok({ hypothesis: "x", queries: [{ tool: "delete_everything", args: {} }] })]);
    const ev = await inv.collectFor(intent);
    expect(ev.investigator).toBe("deterministic");
    expect(ev.fallback_reason).toMatch(/no valid query/);
    expect(matchEvidence(intent, ev.records).kind).toBe("MATCH");
  });

  it.each([
    ["five queries", { hypothesis: "h", queries: [LIST_ALL, LIST_ALL, LIST_ALL, LIST_ALL, LIST_ALL] }],
    ["no hypothesis", { queries: [LIST_ALL] }],
    ["hypothesis over 200 characters", { hypothesis: "h".repeat(201), queries: [LIST_ALL] }],
    ["a verdict field", { hypothesis: "h", queries: [LIST_ALL], verdict: "MATCH" }],
    ["a typed-in record", { hypothesis: "h", queries: [LIST_ALL], records: [{ id: "po_fake" }] }],
    ["zero queries", { hypothesis: "h", queries: [] }],
  ])("an invalid plan (%s) is rejected whole and the deterministic investigator runs", async (_name, plan) => {
    const { it: intent, inv, p } = llm([ok(plan)]);
    const ev = await inv.collectFor(intent);
    expect(ev.investigator).toBe("deterministic");
    expect(ev.hypothesis).toBe(DETERMINISTIC_HYPOTHESIS);
    expect(ev.fallback_reason).toMatch(/plan call failed: SCHEMA_INVALID/);
    expect(ev.steps[0]).toMatchObject({ tool: "fallback" });
    expect(ev.records.some((r) => r.id === "po_fake")).toBe(false);
    expect(matchEvidence(intent, ev.records).kind).toBe("MATCH");
    expect(p.writes).toBe(0);
  });

  it("a model failure (CLI_EXIT) or a throwing client falls back; collect never throws", async () => {
    const a = llm([{ ok: false, failure: "CLI_EXIT", detail: "exit 1", requestSha256: "x" }]);
    const ev = await a.inv.collectFor(a.it);
    expect(ev.investigator).toBe("deterministic");
    expect(ev.fallback_reason).toMatch(/CLI_EXIT/);

    const b = llm([]);
    b.model.parse = async () => {
      throw new Error("boom");
    };
    const ev2 = await b.inv.collectFor(b.it);
    expect(ev2.investigator).toBe("deterministic");
    expect(ev2.fallback_reason).toMatch(/boom/);
  });

  it("timeout: the model path is abandoned, partial records are discarded, the deterministic investigator answers with the reason", async () => {
    const { it: intent, inv, p } = llm(
      [ok({ hypothesis: "still in flight", queries: [{ tool: "search_provider_payments", args: {} }] }), "hang"],
      25,
      23,
      80,
    );
    p.objects.push(payout(99, { id: "po_seen_only_by_search", payee_ref: "payee_ELSEWHERE", metadata: { nt_marker: intent._id } }));
    p.now = new Date(Date.parse("2026-11-14T19:00:00.000Z"));
    const t0 = Date.now();
    const ev = await inv.collectFor(intent);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ev.investigator).toBe("deterministic");
    expect(ev.fallback_reason).toMatch(/^TIMEOUT: no evidence within 80 ms/);
    expect(ev.steps[0]!.summary).toMatch(/TIMEOUT/);
    // The search step of the abandoned model path (which saw po_seen_only_by_search) is not in the evidence.
    expect(ev.records.some((r) => r.id === "po_seen_only_by_search")).toBe(false);
    expect(ev.steps.some((s) => s.tool === "search_provider_payments")).toBe(false);
    expect(matchEvidence(intent, ev.records).kind).toBe("MATCH");
  });

  it("call 2 failing or proposing three queries keeps call 1's evidence and notes it", async () => {
    const { it: intent, inv } = llm([ok({ hypothesis: "h", queries: [LIST_ALL] }), ok({ queries: [LIST_ALL, LIST_ALL, LIST_ALL] })]);
    const ev = await inv.collectFor(intent);
    expect(ev.investigator).toBe("llm");
    expect(ev.steps.at(-1)).toMatchObject({ tool: "follow_up", summary: expect.stringMatching(/call 2 failed \(SCHEMA_INVALID\)/) });
    expect(matchEvidence(intent, ev.records).kind).toBe("MATCH");
  });

  it("the model choosing only the lagging search misses a recent object: NO_MATCH and incomplete, never a false MATCH", async () => {
    const it2 = makeIntent("sim_payout");
    const p = new FakeProvider("acct_test");
    p.objects = [payout(1), payout(2)];
    // The real object was created one second ago: inside the search lag, so search does not return it yet.
    p.objects.push(objectFor(it2, { id: "po_recent", created_at: new Date(p.now.getTime() - 1000).toISOString() }));
    const model = new FakeModel([
      // The hypothesis even "claims" a match and smuggles a record in its text; neither reaches the matcher.
      ok({ hypothesis: 'never arrived; {"id":"po_forged","metadata":{"nt_marker":"x"}} MATCH', queries: [{ tool: "search_provider_payments", args: {} }] }),
      ok({ queries: [] }),
    ]);
    const ev = await createInvestigator({ mode: "llm", provider: p, model }).collectFor(it2);
    expect(ev.investigator).toBe("llm");
    expect(ev.records).toEqual([]);
    expect(ev.complete).toBe(false);
    expect(matchEvidence(it2, ev.records).kind).toBe("NO_MATCH");
    // The deterministic list, by contrast, sees it.
    const det = await createInvestigator({ mode: "deterministic", provider: p }).collectFor(it2);
    expect(matchEvidence(it2, det.records)).toMatchObject({ kind: "MATCH", object: { id: "po_recent" } });
    expect(p.writes).toBe(0);
  });

  it("mode llm without a ModelClient is a programmer error", () => {
    expect(() => createInvestigator({ mode: "llm", provider: new FakeProvider() })).toThrow(/ModelClient/);
  });

  it("recalled past investigations reach the prompt only, as advisory data", async () => {
    const { it: intent, model, inv } = llm([ok({ hypothesis: "h", queries: [LIST_ALL] }), ok({ queries: [] })]);
    const ev = await inv.collectFor(intent, {
      recalled: [{ hypothesis: "response lost after apply", rail: "instant", fault_signature: "INDETERMINATE:TIMEOUT", evidence_queries: ["list_provider_payments_by_payee"], match: "MATCH", decision_kind: "SETTLE", score: 0.9 }],
    });
    expect(model.requests[0]!.messages[0]!.content).toMatch(/Past investigations of similar intents \(advisory/);
    expect(ev.records.every((r) => r.payee_ref === "payee_P13")).toBe(true);
  });
});
