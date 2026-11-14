// D3: the deterministic investigator and createInvestigator (HANDOVER.md §11.2).
import type { Investigator } from "@nt/contracts";
import { describe, expect, it } from "vitest";
import { matchEvidence } from "../src/pure/index.ts";
import { DETERMINISTIC_HYPOTHESIS, createDeterministicInvestigator, createInvestigator, createReadOnlyEvidenceTools } from "../src/investigator/index.ts";
import { FakeProvider, payout } from "./investigator-fakes.ts";
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
