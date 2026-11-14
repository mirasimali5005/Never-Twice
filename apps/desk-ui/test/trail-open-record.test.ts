import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidenceTrail } from "../src/components/EvidenceTrail";
import { decisionWords, matchWords, trailSteps } from "../src/trailSteps";
import type { InvestigationRecord, PaymentTrail } from "../src/types";

// The desk API returns an investigation record as soon as it is opened: decision, match, licence and closed_at are null, and the
// hypothesis is null until the agent has written one. The page used to go white on that (decisionWords(null)).
const dir = join(__dirname, "..", "src", "mocks");
const base = JSON.parse(readFileSync(join(dir, "payment.nt.ZT4H9X.P02.NT101-20261110.APPR_DELAY.DISPATCHING.json"), "utf8")) as PaymentTrail;

const open = (over: Partial<InvestigationRecord> = {}): InvestigationRecord => ({
  epoch: 1,
  investigator: "llm",
  hypothesis: null,
  steps: [],
  match: null,
  decision: null,
  licence: null,
  recalled: [],
  opened_at: "2026-11-14T18:00:20.000Z",
  closed_at: null,
  ...over,
});
const withInv = (...investigations: InvestigationRecord[]): PaymentTrail => ({ ...base, investigations });

describe("open investigation records", () => {
  it("render as Investigating… without throwing", () => {
    const steps = trailSteps(withInv(open()));
    const s = steps.find((x) => x.label === "Investigating…");
    expect(s).toBeDefined();
    expect(s?.kind).toBe("pending");
    expect(steps.some((x) => x.kind === "decision" || x.kind === "matcher")).toBe(false);
  });
  it("show the hypothesis once present, and the queries so far", () => {
    const steps = trailSteps(
      withInv(open({ hypothesis: "response lost after apply", steps: [{ tool: "list_provider_payments_by_payee", input: {}, summary: "payee_P02", record_count: 1 }] })),
    );
    expect(steps.find((x) => x.label === "Investigating…")?.text).toContain("response lost after apply");
    expect(steps.some((x) => x.kind === "query" && x.text.includes("1 record"))).toBe(true);
  });
  it("tolerate null steps, a missing list and a null decision helper input", () => {
    expect(() => trailSteps(withInv(open({ steps: null })))).not.toThrow();
    expect(() => trailSteps({ ...base, investigations: undefined as never })).not.toThrow();
    expect(decisionWords(null)).toBe("Investigating…");
    expect(matchWords(null)).toBe("not decided yet");
  });
  it("a closed record still renders its decision, and says when the model did not produce it", () => {
    const steps = trailSteps(
      withInv(open({ investigator: "deterministic", hypothesis: "h", match: "MATCH", decision: { kind: "SETTLE", row: 1 }, closed_at: "2026-11-14T18:00:30.000Z" })),
    );
    expect(steps.find((x) => x.kind === "decision")?.text).toContain("SETTLE");
    expect(steps.find((x) => x.kind === "hypothesis")?.text).toContain("investigator: deterministic");
  });
  it("EvidenceTrail renders an open record to markup (no throw)", () => {
    const html = renderToString(createElement(EvidenceTrail, { trail: { ok: true, data: withInv(open()) }, selectedKey: base.intent.effect_key as string }));
    expect(html).toContain("Investigating…");
  });
});
