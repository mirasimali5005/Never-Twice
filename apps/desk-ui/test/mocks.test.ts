import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// G2-UNIT-03: the mock files parse and contain every field the components read.
const dir = join(__dirname, "..", "src", "mocks");
const read = (n: string) => JSON.parse(readFileSync(join(dir, n), "utf8"));
const has = (o: unknown, keys: string[]) => {
  for (const k of keys) expect(o, `missing ${k}`).toHaveProperty(k);
};

describe("mock files", () => {
  const json = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("all parse", () => {
    expect(json.length).toBeGreaterThan(20);
    for (const f of json) expect(() => read(f), f).not.toThrow();
  });
  it("group, summary, claims, claim", () => {
    has(read("group.json"), ["group_id", "scenario", "recorded", "runs"]);
    for (const r of read("group.json").runs) has(r, ["run_id", "arm", "status", "sim_account", "fault_schedule"]);
    for (const a of ["nt", "control", "nt_mutant"]) has(read(`summary.${a}.json`), ["run_id", "group_id", "arm", "status", "intents_by_state", "colours", "complete", "report_generated_at"]);
    for (const c of read("claims.nt.json")) has(c, ["claim_id", "channel", "received_at", "status", "hold_reason", "effect_keys"]);
    for (const f of ["claim.nt.json", "claim.nt.S1.json"]) {
      const c = read(f);
      has(c, ["claim_id", "channel", "raw_text", "status", "extraction", "extraction_meta", "resolution", "record_facts", "obligations", "merged_claims"]);
      has(c.record_facts[0], ["flight_no", "cause_code", "control_class", "arrival_delay_minutes"]);
      has(c.obligations[0], ["effect_key", "entitlement_type", "status", "amount_minor", "rule_citation", "policy_version", "claim_ids", "due_by"]);
    }
    expect(read("claim.nt.S1.json").merged_claims).toEqual(["C03"]);
    expect(read("claim.nt.json").obligations[0].amount_minor).toBe(70000);
  });
  it("payments and trails", () => {
    for (const a of ["nt", "control"]) for (const p of read(`payments.${a}.json`)) has(p, ["effect_key", "passenger_id", "entitlement_type", "amount_minor", "rail", "provider", "state", "colour", "quarantine_reason", "source"]);
    expect(read("payments.control.json").every((p: { state: unknown; source: string }) => p.state === null && p.source === "baseline")).toBe(true);
    const trails = json.filter((f) => f.startsWith("payment.nt."));
    expect(trails.length).toBeGreaterThanOrEqual(9);
    for (const f of trails) {
      const t = read(f);
      has(t, ["intent", "obligation", "investigations", "audit"]);
      has(t.intent, ["_id", "state", "amount_minor", "payee_ref", "provider", "lease", "lease_epoch", "attempts", "evidence"]);
      for (const a of t.intent.attempts) has(a, ["n", "licence", "epoch", "at", "result"]);
      for (const i of t.investigations) has(i, ["epoch", "investigator", "hypothesis", "steps", "match", "decision", "licence", "recalled", "opened_at", "closed_at"]);
    }
    for (const f of json.filter((x) => x.startsWith("payment.control."))) has(read(f), ["source", "effect_key", "attempts", "marked_done"]);
  });
  it("statement, pool, certificates", () => {
    for (const a of ["nt", "control"]) has(read(`provider-statement.${a}.json`), ["run_id", "account", "read_at", "complete", "entitlements", "unattributed", "paid_twice"]);
    expect(read("provider-statement.control.json").paid_twice).toBe(1);
    has(read("pool.json"), ["run_id", "grant_minor", "held_minor", "settled_minor", "frozen", "currency", "awaiting_budget"]);
    for (const a of ["nt", "control", "nt_mutant"]) {
      const c = read(`certificate.${a}.json`);
      has(c, ["certificate_version", "run_id", "group_id", "arm", "manifest_sha256", "commitment_sha256", "ledger", "safety", "checks", "findings", "completion", "notes"]);
      has(c.checks, ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C9", "C10"]);
      has(c.completion, ["owed_paid", "refusals_correct", "holds_correct", "over_parked", "goodwill_paid_minor", "goodwill_eligible_minor"]);
    }
    expect(read("certificate.nt.json").safety).toBe("PASS");
    expect(read("certificate.nt_mutant.json").safety).toBe("FAIL");
    expect(read("certificate.nt_mutant.json").checks.C5.status).toBe("FAIL");
    expect(read("certificate.control.json").checks.C1.status).toBe("FAIL");
    expect(read("certificate.nt.json").ledger.stripe_objects).toBe(1);
  });
});
