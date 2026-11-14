import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuditorPanel, mutantLabel, mutationName } from "../src/components/AuditorPanel";
import { ChoiceStrip, KILL_TARGETS } from "../src/components/ChoiceStrip";
import { HowItWorks } from "../src/components/HowItWorks";
import { Header } from "../src/components/Header";
import { formatStamp } from "../src/format";
import { certificateBackoffMs, isNotAudited } from "../src/useRunData";
import type { Certificate, GroupRun, GroupView } from "../src/types";

const dir = join(__dirname, "..", "src", "mocks");
const cert = (a: string) => JSON.parse(readFileSync(join(dir, `certificate.${a}.json`), "utf8")) as Certificate;
const run = (arm: string): GroupRun => ({ run_id: "r7k2m9qa", arm: arm as GroupRun["arm"], status: "ENDED", sim_account: "acct_r7k2m9qa", fault_schedule: "F-DEMO" });
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("certificate poll", () => {
  it("404 NOT_AUDITED is an expected answer, other failures are not", () => {
    expect(isNotAudited({ ok: false, status: 404, error: "NOT_AUDITED" })).toBe(true);
    expect(isNotAudited({ ok: false, status: 503, error: "CERTIFICATE_UNREADABLE" })).toBe(false);
    expect(isNotAudited(null)).toBe(false);
  });
  it("backs off 2 s, 4 s, 8 s and stops at 10 s", () => {
    expect([0, 1, 2, 3, 4, 8].map(certificateBackoffMs)).toEqual([2000, 2000, 4000, 8000, 10000, 10000]);
  });
});

describe("beat 3 list", () => {
  it("S0 shows P02 only; S1 shows P01, P02, P03, P05, P06, P07", () => {
    expect(KILL_TARGETS.S0).toEqual(["P02"]);
    expect(KILL_TARGETS.S1).toEqual(["P01", "P02", "P03", "P05", "P06", "P07"]);
    const s1 = html(createElement(ChoiceStrip, { scenario: "S1" }));
    for (const id of KILL_TARGETS.S1) expect(s1).toContain(id);
    expect(s1).toContain("Daniel Whitlock");
    expect(s1).not.toContain("P04");
    const s0 = html(createElement(ChoiceStrip, { scenario: "S0" }));
    expect(s0).toContain("P02");
    expect(s0).not.toContain("P01");
    expect(html(createElement(ChoiceStrip, { scenario: null }))).toBe("");
  });
});

describe("header labels", () => {
  const view = (over: Partial<GroupView>): GroupView => ({ group_id: "g4x8p2nd", scenario: "S0", recorded: false, runs: [], ...over });
  const head = (g: GroupView) => html(createElement(Header, { groupId: g.group_id, group: { ok: true, data: g }, manifest: { hash: null, commitment: null }, mock: false, stream: "live", intakeReplay: false }));
  it("a recorded run carries its date and time", () => {
    const at = "2026-11-14T12:51:30.000Z";
    const h = head(view({ recorded: true, recorded_at: at }));
    expect(h).toContain("RECORDED");
    expect(h).toContain(formatStamp(at));
    expect(formatStamp(at)).toMatch(/^\d{1,2} Nov 2026 \d\d:\d\d$/);
    expect(head(view({ recorded: true }))).toContain("RECORDED");
    expect(formatStamp("junk")).toBe("");
  });
  it("LOCAL DATABASE shows only when the desk API says local", () => {
    expect(head(view({ database: "local" }))).toContain("LOCAL DATABASE");
    expect(head(view({ database: "atlas_sandbox" }))).not.toContain("LOCAL DATABASE");
    expect(head(view({}))).not.toContain("LOCAL DATABASE");
  });
});

describe("auditor panel labels", () => {
  it("the mutant label names M2 and what it does", () => {
    expect(mutantLabel("M2")).toBe("Labelled mutant M2: marks unknown outcomes confirmed without evidence — a test of the auditor");
    expect(mutationName(cert("nt_mutant"))).toBe("M2");
    expect(mutationName(cert("nt"))).toBeNull();
  });
  it("the Stripe line carries the amount", () => {
    const c = cert("nt");
    expect(c.ledger.stripe_objects).toBe(1);
    const h = html(createElement(AuditorPanel, { entries: [{ run: run("nt"), cert: { ok: true, data: c } }], selectedArm: "nt", onSelect: () => {}, stripeAmountMinor: 41260 }));
    expect(h).toContain("$412.60 ticket refund read from Stripe (test mode)");
    const none = html(createElement(AuditorPanel, { entries: [{ run: run("nt"), cert: { ok: true, data: c } }], selectedArm: "nt", onSelect: () => {} }));
    expect(none).toContain("ticket refund read from Stripe (test mode)");
    expect(none).not.toContain("$412.60");
  });
});

describe("How it works card", () => {
  const card = (goodwill: boolean) => html(createElement(HowItWorks, { open: true, onClose: () => {}, trail: null, goodwill }));
  it("says the four things, with the wording rules", () => {
    const h = card(true);
    expect(h).toContain("one MongoDB");
    expect(h).toContain("goodwill reservation");
    expect(h).toContain("The model proposes and investigates. Deterministic code authorizes and verifies.");
    expect(h).toContain("read-only access to the provider ledgers and no access to the system&#x27;s database");
    expect(h).toContain("Simulated:</b> the payout provider");
    expect(h).toContain("Stripe in test mode");
    expect(card(false)).not.toContain("goodwill");
    const low = h.toLowerCase();
    for (const w of ["exactly-once", "guaranteed", "tamper-proof", "immutable", "never pays twice"]) expect(low).not.toContain(w);
    expect(html(createElement(HowItWorks, { open: false, onClose: () => {}, trail: null, goodwill: false }))).toBe("");
  });
});
