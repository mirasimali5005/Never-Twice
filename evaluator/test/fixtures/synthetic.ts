// Synthetic builders for the evaluator's own tests: manifests from the test ops records and the hidden truth,
// in-memory ledgers and final reports. No simulator, no database.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOpsRecord } from "../../src/ops-record.ts";
import { computeManifest, parseClaimTruth, manifestSha256, withGroup } from "../../src/manifest.ts";
import type { Manifest } from "../../src/manifest.ts";
import type { LedgerObject } from "../../src/ledger.ts";
import type { FinalReport, PaidItem } from "../../src/report.ts";
import type { CheckInput, Commitment } from "../../src/checker.ts";

export const EVAL_DIR = join(import.meta.dirname, "..", "..");
export const RUN = "r7k2m9qa";
export const GROUP = "g4x8p2nd";

export const K = {
  P02: "ZT4H9X.P02.NT101-20261110.APPR_DELAY",
  P03C: "LM2P8D.P03.NT101-20261110.APPR_REFUND_COMP",
  P03R: "LM2P8D.P03.NT101-20261110.TICKET_REFUND",
  P04: "HV9C3T.P04.NT101-20261110.APPR_DELAY",
  P11: "PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING",
  P13: "KS2R9B.P13.NT880-20261110.APPR_DELAY",
  P08: "DX3F7Q.P08.NT101-20261110.APPR_DELAY",
  P15: "AJ6W5L.P15.NT455-20261110.APPR_DELAY",
  P17: "EH5B2Z.P17.NT101-20261110.APPR_DELAY",
} as const;

export function opsRecordPath(s: "S0" | "S1"): string {
  return join(EVAL_DIR, "test", "fixtures", `ops-record.${s}.json`);
}

export function loadManifest(s: "S0" | "S1", group = GROUP): Manifest {
  const ops = parseOpsRecord(JSON.parse(readFileSync(opsRecordPath(s), "utf8")));
  const truth = parseClaimTruth(JSON.parse(readFileSync(join(EVAL_DIR, "hidden", s, "claim-truth.json"), "utf8")));
  return withGroup(computeManifest(ops, truth), group);
}

export function commitmentFor(m: Manifest): Commitment {
  return { group_id: m.group_id!, sha256: manifestSha256(m), committed_at: "2026-11-14T17:57:40.118Z" };
}

let seq = 0;
export function obj(key: string | null, amount: number, payee: string, extra: Partial<LedgerObject> = {}): LedgerObject {
  seq += 1;
  const metadata: Record<string, string> = key === null ? {} : { nt_effect_key: key, nt_marker: `${RUN}:${key}`, nt_run_id: RUN, nt_type: key.split(".").pop()! };
  return {
    source: "sim", id: `po_${String(seq).padStart(16, "0")}`, kind: "payout", status: "paid", amount_minor: amount, currency: "CAD",
    payee_ref: payee, parent_ref: null, metadata, created_at: "2026-11-14T18:00:00.000Z", ...extra,
  };
}

export function paidOf(o: LedgerObject, provider = "sim_payout"): PaidItem {
  const key = o.metadata.nt_effect_key;
  return { effect_key: key, marker: `${RUN}:${key}`, amount_minor: o.amount_minor, currency: o.currency, payee_ref: o.payee_ref ?? "", provider, provider_object_id: o.id };
}

export function emptyReport(scenario: "S0" | "S1"): FinalReport {
  return { run_id: RUN, group_id: GROUP, arm: "nt", scenario, generated_at: "2026-11-14T18:02:20.511Z", complete: true,
    paid: [], refused: [], parked: [], awaiting_budget: [], failed_no_effect: [], unresolved: [] };
}

/** EVL-01: clean S0 run. Five payments (P03's ticket refund as a simulated refund object), P04 refused, complete. */
export function cleanS0(): CheckInput {
  const manifest = loadManifest("S0");
  const ledger = [
    obj(K.P11, 90000, "payee_P11"),
    obj(K.P13, 70000, "payee_P13"),
    obj(K.P02, 70000, "payee_P02"),
    obj(K.P03C, 40000, "payee_P03"),
    obj(K.P03R, 41260, "payee_P03", { kind: "refund", id: `rf_${String(++seq).padStart(16, "0")}` }),
  ];
  const report = emptyReport("S0");
  report.paid = ledger.map((o) => paidOf(o, o.metadata.nt_effect_key === K.P11 ? "sim_keyless" : "sim_payout"));
  report.refused = [{ effect_key: K.P04, reason_code: "DELAY_UNDER_3H", rule_citation: "s. 19(1)" }];
  return { manifest, storedManifest: structuredClone(manifest), commitment: commitmentFor(manifest), ledger, report };
}

/** A clean S1 run: every owed statutory entitlement and the ticket refund paid, goodwill P10, P01, P05 paid (fills 50000),
 *  P06 and P07 awaiting budget, four refusals, P08/P15/P16 parked, C17 claim-level hold. */
export function cleanS1(): CheckInput {
  const manifest = loadManifest("S1");
  const ledger: LedgerObject[] = [];
  const report = emptyReport("S1");
  for (const e of manifest.entries) {
    if (!e.claimed) continue;
    const first = e.acceptable[0];
    if (first.outcome === "PAY") ledger.push(obj(e.effect_key, first.amount_minor, first.payee_ref));
    else if (first.outcome === "REFUSE") report.refused.push({ effect_key: e.effect_key, reason_code: first.reason, rule_citation: "s. 19" });
    else if (first.outcome === "HOLD") report.parked.push({ effect_key: e.effect_key, claim_id: null, reason_code: first.reason, amount_minor: null });
    else if (first.outcome === "GOODWILL_ELIGIBLE") {
      if (["P10", "P01", "P05"].includes(e.passenger_id)) ledger.push(obj(e.effect_key, first.amount_minor, first.payee_ref));
      else report.awaiting_budget.push({ effect_key: e.effect_key, amount_minor: first.amount_minor });
    }
  }
  report.paid = ledger.map((o) => paidOf(o));
  report.parked.push({ effect_key: null, claim_id: "C17", reason_code: "BOOKING_UNRESOLVED", amount_minor: null });
  return { manifest, storedManifest: structuredClone(manifest), commitment: commitmentFor(manifest), ledger, report };
}

export function failing(r: { checks: Record<string, { status: string }> }): string[] {
  return Object.entries(r.checks).filter(([, v]) => v.status === "FAIL").map(([k]) => k).sort();
}
