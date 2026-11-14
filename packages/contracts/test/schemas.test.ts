// A2-UNIT-06: stored-document and report schemas.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AuditEvent,
  ClaimExtraction,
  DispatchResult,
  FinalReport,
  InvestigationPlan,
  Intent,
  Obligation,
  RECOVERY_DECISION_KINDS,
  RecoveryDecisionSchema,
  hashFrozenRequest,
  type ProposeResult,
  type RecoveryDecision,
} from "../src/index.ts";

const MARKER = "r7k2m9qa:KS2R9B.P13.NT880-20261110.APPR_DELAY";
const EK = "KS2R9B.P13.NT880-20261110.APPR_DELAY";
const frozen = {
  provider: "sim_payout",
  operation: "PAYOUT",
  account: "acct_r7k2m9qa",
  rail: "instant",
  amount_minor: 70000,
  currency: "CAD",
  payee_ref: "payee_P13",
  parent_ref: null,
  metadata: { nt_marker: MARKER, nt_effect_key: EK, nt_run_id: "r7k2m9qa", nt_type: "APPR_DELAY" },
} as const;
const sha = hashFrozenRequest(frozen);

// HANDOVER.md §8.1 / ARCHITECTURE.md §5.1 example intent (P13 after DROP_REQUEST, one L1 re-send and T6).
const intent = {
  _id: MARKER,
  run_id: "r7k2m9qa",
  effect_key: EK,
  obligation_id: MARKER,
  entitlement_type: "APPR_DELAY",
  amount_minor: 70000,
  currency: "CAD",
  payee_ref: "payee_P13",
  provider: "sim_payout",
  idempotency_key: MARKER,
  frozen_request: frozen,
  frozen_request_sha256: sha,
  draws_on: null,
  state: "CONFIRMED",
  lease: null,
  lease_epoch: 2,
  first_dispatch_at: new Date("2026-11-14T18:00:02.110Z"),
  last_send_at: new Date("2026-11-14T18:02:11.090Z"),
  key_expires_at: new Date("2026-11-15T17:59:02.110Z"),
  next_attempt_at: null,
  attempts: [
    {
      n: 1,
      at: new Date("2026-11-14T18:00:02.110Z"),
      licence: "FIRST_SEND",
      request_sha256: sha,
      epoch: 1,
      result: { kind: "INDETERMINATE", cause: "TIMEOUT", code: null, replayed: null, provider_object_id: null },
    },
    {
      n: 2,
      at: new Date("2026-11-14T18:02:11.090Z"),
      licence: "L1_SAME_KEY",
      request_sha256: sha,
      epoch: 2,
      result: { kind: "ACCEPTED", cause: null, code: null, replayed: false, provider_object_id: "po_b71e04c9d2a6f318" },
    },
  ],
  evidence: {
    source: "REDISPATCH",
    provider_object_id: "po_b71e04c9d2a6f318",
    status: "paid",
    amount_minor: 70000,
    currency: "CAD",
    payee_ref: "payee_P13",
    marker: MARKER,
    retrieved_at: new Date("2026-11-14T18:02:11.418Z"),
  },
  rejection: null,
  quarantine: null,
  policy_version: "APPR-SOR-2019-150@2022-09-08",
  rule_citation: "s. 19(1)(a)(ii)",
  created_at: new Date("2026-11-14T18:00:02.050Z"),
  updated_at: new Date("2026-11-14T18:02:11.418Z"),
};

describe("Intent", () => {
  it("parses the §8.1 example, fresh and confirmed", () => {
    expect(Intent.safeParse(intent).success).toBe(true);
    const fresh = { ...intent, state: "RESERVED", lease_epoch: 0, attempts: [], evidence: null, first_dispatch_at: null, last_send_at: null, key_expires_at: null };
    expect(Intent.safeParse(fresh).success).toBe(true);
    const leased = { ...intent, state: "DISPATCHING", lease: { owner: "runner-1", expires_at: new Date() } };
    expect(Intent.safeParse(leased).success).toBe(true);
  });

  it.each([
    ["amount_minor 0", { amount_minor: 0 }],
    ["float amount", { amount_minor: 700.5 }],
    ["currency USD", { currency: "USD" }],
    ["unknown state", { state: "PAID" }],
    ["lease carrying an epoch", { lease: { owner: "runner-1", expires_at: new Date(), epoch: 3 } }],
    ["bad run id", { run_id: "run1" }],
    ["short sha", { frozen_request_sha256: "4be1" }],
    ["negative lease_epoch", { lease_epoch: -1 }],
  ])("rejects %s", (_label, patch) => {
    expect(Intent.safeParse({ ...intent, ...patch }).success).toBe(false);
  });
});

describe("Obligation and AuditEvent", () => {
  it("parses the §5.1 obligation", () => {
    const o = {
      _id: "r7k2m9qa:ZT4H9X.P02.NT101-20261110.APPR_DELAY",
      run_id: "r7k2m9qa",
      effect_key: "ZT4H9X.P02.NT101-20261110.APPR_DELAY",
      booking_ref: "ZT4H9X",
      passenger_id: "P02",
      disruption_id: "NT101-20261110",
      entitlement_type: "APPR_DELAY",
      status: "OWED",
      amount_minor: 70000,
      currency: "CAD",
      payee_ref: "payee_P02",
      rail: "instant",
      reason_code: null,
      rule_citation: "s. 19(1)(a)(ii)",
      policy_version: "APPR-SOR-2019-150@2022-09-08",
      claim_ids: ["C02"],
      decided_at: new Date("2026-11-14T17:58:40Z"),
      due_by: new Date("2026-12-11T14:05:00Z"),
    };
    expect(Obligation.safeParse(o).success).toBe(true);
    expect(Obligation.safeParse({ ...o, reason_code: "AWAITING_BUDGET" }).success).toBe(false); // a proposal refusal is not a reason code
  });

  it("parses an audit event with an ObjectId-like _id", () => {
    const ev = {
      _id: { toHexString: () => "69176d43a1b2c3d4e5f60718" },
      run_id: "r7k2m9qa",
      at: new Date(),
      actor: { kind: "reconciler", id: "reconciler-1" },
      type: "TRANSITION",
      intent_id: MARKER,
      effect_key: EK,
      claim_id: null,
      from_state: "OUTCOME_UNKNOWN",
      to_state: "CONFIRMED",
      rule_citation: "s. 19(1)(a)(ii)",
      policy_version: "APPR-SOR-2019-150@2022-09-08",
      detail: { transition: "T6", epoch: 2 },
    };
    expect(AuditEvent.safeParse(ev).success).toBe(true);
    expect(AuditEvent.safeParse({ ...ev, _id: "69176d43a1b2c3d4e5f60718" }).success).toBe(false);
  });
});

describe("FinalReport", () => {
  // HANDOVER.md §14 example, with concrete values in place of "…".
  const report = {
    run_id: "r7k2m9qa",
    group_id: "g4x8p2nd",
    arm: "nt",
    scenario: "S1",
    generated_at: "2026-11-14T18:03:30.000Z",
    complete: false,
    paid: [
      {
        effect_key: "ZT4H9X.P02.NT101-20261110.APPR_DELAY",
        marker: "r7k2m9qa:ZT4H9X.P02.NT101-20261110.APPR_DELAY",
        amount_minor: 70000,
        currency: "CAD",
        payee_ref: "payee_P02",
        provider: "sim_payout",
        provider_object_id: "po_3f9a1c07e2b84d55",
      },
    ],
    refused: [{ effect_key: "QW7E3R.P04.NT880-20261110.APPR_DELAY", reason_code: "DELAY_UNDER_3H", rule_citation: "s. 19(1)" }],
    parked: [
      { effect_key: "HB6N2C.P11.NT212-20261110.APPR_DENIED_BOARDING", claim_id: null, reason_code: "NO_DEDUPE_NO_EVIDENCE", amount_minor: 90000 },
      { effect_key: "XX1111.P08.NT101-20261110.APPR_DELAY", claim_id: null, reason_code: "PAYEE_CHANGE_REQUESTED", amount_minor: null },
      { effect_key: null, claim_id: "C17", reason_code: "PASSENGER_UNMATCHED", amount_minor: null },
    ],
    awaiting_budget: [{ effect_key: "AB1234.P06.NT330-20261110.GOODWILL", amount_minor: 15000 }],
    failed_no_effect: [{ effect_key: "CD5678.P09.NT455-20261110.APPR_DELAY", code: "payee_closed" }],
    unresolved: [{ effect_key: "EF9012.P05.NT455-20261110.APPR_DELAY", state: "OUTCOME_UNKNOWN" }],
  };

  it("parses the §14 example", () => {
    expect(FinalReport.safeParse(report).success).toBe(true);
  });

  it("fails without group_id or with a malformed one", () => {
    const { group_id: _g, ...noGroup } = report;
    expect(FinalReport.safeParse(noGroup).success).toBe(false);
    expect(FinalReport.safeParse({ ...report, group_id: "…" }).success).toBe(false);
  });

  it("keeps the reason-code families apart", () => {
    expect(FinalReport.safeParse({ ...report, refused: [{ ...report.refused[0], reason_code: "AWAITING_BUDGET" }] }).success).toBe(false);
    expect(FinalReport.safeParse({ ...report, parked: [{ ...report.parked[0], reason_code: "DELAY_UNDER_3H" }] }).success).toBe(false);
  });
});

describe("RecoveryDecision", () => {
  it("admits only SETTLE, REDISPATCH_SAME_KEY and QUARANTINE", () => {
    expect(RECOVERY_DECISION_KINDS).toEqual(["SETTLE", "REDISPATCH_SAME_KEY", "QUARANTINE"]);
    expectTypeOf<RecoveryDecision["kind"]>().toEqualTypeOf<"SETTLE" | "REDISPATCH_SAME_KEY" | "QUARANTINE">();
    const obj = {
      id: "po_1",
      kind: "payout",
      status: "paid",
      amount_minor: 70000,
      currency: "CAD",
      payee_ref: "payee_P13",
      parent_ref: null,
      metadata: { nt_marker: MARKER },
      created_at: "2026-11-14T18:00:07.388Z",
    };
    expect(RecoveryDecisionSchema.safeParse({ row: 2, kind: "SETTLE", object: obj }).success).toBe(true);
    expect(RecoveryDecisionSchema.safeParse({ row: 6, kind: "REDISPATCH_SAME_KEY", licence: "L1_SAME_KEY" }).success).toBe(true);
    expect(RecoveryDecisionSchema.safeParse({ row: 9, kind: "QUARANTINE", reason: "NO_DEDUPE_NO_EVIDENCE", detail: "" }).success).toBe(true);
    for (const bad of [
      { row: 8, kind: "WAIT" },
      { row: 6, kind: "REDISPATCH_SAME_KEY", licence: "L2_BOUNDED_WAIT" },
      { row: 3, kind: "RELEASE" },
      { row: 8, kind: "QUARANTINE", reason: "NO_DEDUPE_NO_EVIDENCE", detail: "" },
      { row: 1, kind: "QUARANTINE", reason: "AWAITING_BUDGET", detail: "" },
    ]) {
      expect(RecoveryDecisionSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("ProposeResult has four kinds", () => {
    expectTypeOf<ProposeResult["kind"]>().toEqualTypeOf<"RESERVED" | "ADOPTED" | "DIVERGED" | "REFUSED">();
  });
});

describe("model output", () => {
  it("ClaimExtraction has no field for an amount to pay, a key, a payee token or a state", () => {
    const fields = Object.keys(ClaimExtraction.shape);
    for (const f of fields) {
      expect(f).not.toMatch(/amount_minor|amount_to_pay|pay_amount|key|payee_ref|payee_token|marker|state|status|effect/i);
    }
    expect(fields).toContain("requested_amount"); // what the text asks for, a string, never used as an amount
  });

  it("InvestigationPlan bounds the query count", () => {
    const q = { tool: "search_provider_payments", args: {} };
    expect(InvestigationPlan.safeParse({ hypothesis: "never arrived", queries: [q] }).success).toBe(true);
    expect(InvestigationPlan.safeParse({ hypothesis: "x", queries: [] }).success).toBe(false);
    expect(InvestigationPlan.safeParse({ hypothesis: "x", queries: [q, q, q, q, q] }).success).toBe(false);
    expect(InvestigationPlan.safeParse({ hypothesis: "x", queries: [{ tool: "create_payout", args: {} }] }).success).toBe(false);
    expect(InvestigationPlan.safeParse({ hypothesis: "x", queries: [q], verdict: "CONFIRMED" }).success).toBe(false);
  });
});

describe("DispatchResult", () => {
  it("parses the four kinds and rejects others", () => {
    expect(DispatchResult.safeParse({ kind: "INDETERMINATE", cause: "TIMEOUT", detail: "" }).success).toBe(true);
    expect(DispatchResult.safeParse({ kind: "REJECTED_DEFINITIVE", code: "payee_closed", message: "", replayed: true }).success).toBe(true);
    expect(DispatchResult.safeParse({ kind: "CONTRADICTION", code: "KEY_REUSED_DIFFERENT_PARAMS", detail: "" }).success).toBe(true);
    expect(DispatchResult.safeParse({ kind: "INDETERMINATE", cause: "NOT_FOUND", detail: "" }).success).toBe(false);
    expect(DispatchResult.safeParse({ kind: "NOT_FOUND" }).success).toBe(false);
  });
});
