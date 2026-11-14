// Wire types of the desk API (ARCHITECTURE.md section 9 and 10.5). Dates are ISO strings on the wire.
// Money is integer cents; formatting is this UI's job (format.ts).

export type Arm = "nt" | "control" | "documented" | "rules_only" | "nt_mutant";
export type RunStatus = "SEEDED" | "RUNNING" | "PAUSED" | "ENDED";
export type IntentState =
  | "RESERVED"
  | "DISPATCHING"
  | "OUTCOME_UNKNOWN"
  | "CONFIRMED"
  | "FAILED_NO_EFFECT"
  | "QUARANTINED"
  | "RELEASED";
export type Colour = "amber" | "green" | "grey-blue" | "neutral";
export type ServerColour = "in_doubt" | "confirmed" | "needs_person";

export type GroupRun = { run_id: string; arm: Arm; status: RunStatus; sim_account: string; fault_schedule: string };
// `manifest_sha256` and `intake_mode` are NOT in ARCHITECTURE.md section 9. They are optional: the UI uses them if G1 adds them.
export type GroupView = {
  group_id: string;
  scenario: "S0" | "S1";
  recorded: boolean;
  runs: GroupRun[];
  manifest_sha256?: string;
  intake_mode?: "live" | "record" | "replay";
};

export type RunSummary = {
  run_id: string;
  group_id: string;
  arm: Arm;
  scenario: "S0" | "S1";
  status: RunStatus;
  intents_by_state: Record<IntentState, number>;
  colours: { in_doubt: number; confirmed: number; needs_person: number };
  complete: boolean | null;
  report_generated_at: string | null;
};

export type ClaimRow = {
  claim_id: string;
  channel: string;
  received_at: string;
  status: string;
  hold_reason: string | null;
  effect_keys: string[];
};

export type ClaimExtraction = {
  claimant_names: string[];
  booking_refs: string[];
  flight_numbers: string[];
  asserted_delay: string | null;
  asserted_cause: string | null;
  requested_amount: string | null;
  [k: string]: unknown;
};

export type CaseObligation = {
  effect_key: string;
  entitlement_type: string;
  status: "OWED" | "NOT_OWED" | "HELD";
  amount_minor: number;
  currency: string;
  reason_code: string | null;
  rule_citation: string;
  policy_version: string;
  claim_ids: string[];
  due_by: string | null;
};

export type ClaimCase = {
  claim_id: string;
  channel: string;
  received_at: string;
  raw_text: string;
  status: string;
  hold_reason: string | null;
  extraction: ClaimExtraction | null;
  extraction_meta: { mode: "live" | "record" | "replay"; prompt_version: string; attempts: number } | null;
  resolution: { booking_ref: string; passenger_ids: string[]; method: string; similarity: number } | null;
  record_facts: { flight_no: string; cause_code: string; control_class: string; arrival_delay_minutes: number | null }[];
  obligations: CaseObligation[];
  merged_claims: string[];
};

export type PaymentRow = {
  effect_key: string;
  passenger_id: string;
  entitlement_type: string;
  amount_minor: number;
  rail: "instant" | "legacy" | null;
  provider: string;
  state: IntentState | null; // null for baseline arms
  colour: ServerColour | null;
  quarantine_reason: string | null;
  source: "nt" | "baseline";
};

export type Attempt = {
  n: number;
  licence: string;
  epoch: number;
  at: string;
  request_sha256?: string;
  result: { kind: string; cause: string | null; code: string | null; replayed: boolean | null; provider_object_id: string | null } | null;
};

export type Evidence = {
  source: "RESPONSE" | "REDISPATCH" | "PROBE";
  provider_object_id: string;
  status: string;
  amount_minor: number;
  currency: string;
  payee_ref: string;
  marker: string;
  retrieved_at: string;
};

export type Intent = {
  _id: string;
  state: IntentState;
  amount_minor: number;
  payee_ref: string;
  provider: string;
  idempotency_key?: string | null;
  frozen_request_sha256?: string;
  lease: { owner: string; expires_at: string } | null;
  lease_epoch: number;
  attempts: Attempt[];
  evidence: Evidence | null;
  quarantine?: { reason: string; detail: string; at: string } | null;
  [k: string]: unknown;
};

export type InvestigationStep = { tool: string; input: unknown; summary: string; record_count: number };
export type InvestigationRecord = {
  epoch: number;
  investigator: "llm" | "deterministic";
  hypothesis: string | null;
  steps: InvestigationStep[] | null;
  // An open record (the investigation is running) carries match, decision and closed_at as null.
  match: "MATCH" | "NO_MATCH" | "CONTRADICTION" | null;
  decision: { kind: "SETTLE" | "REDISPATCH_SAME_KEY" | "QUARANTINE"; row: number; reason?: string; detail?: string } | null;
  licence: string | null;
  recalled: unknown[];
  opened_at: string;
  closed_at: string | null;
};

export type AuditEvent = {
  type: string;
  from_state?: IntentState | null;
  to_state?: IntentState | null;
  actor?: { kind: string; id: string };
  detail?: Record<string, unknown>;
  [k: string]: unknown;
};

export type PaymentTrail = {
  source?: "nt";
  intent: Intent;
  obligation: Partial<CaseObligation> & { status: string };
  investigations: InvestigationRecord[];
  audit: AuditEvent[];
};

// NOT in ARCHITECTURE.md: the evidence trail of a baseline arm payment (what the control arm's own code did).
// Assumed shape, to be agreed with task E5 and G1 (see tasks/reports/G2.md).
export type BaselineTrail = {
  source: "baseline";
  effect_key: string;
  passenger_id: string;
  entitlement_type: string;
  amount_minor: number;
  currency: string;
  payee_ref: string;
  attempts: {
    n: number;
    idempotency_key: string;
    at: string;
    result: string; // plain words from the baseline's own record, e.g. "provider answered 201, payout applied"
  }[];
  marked_done: boolean;
  marked_done_at: string | null;
  note: string | null;
};
export type AnyTrail = PaymentTrail | BaselineTrail;

export type StatementObject = { id: string; status: string; amount_minor: number; created_at: string };
export type ProviderStatement = {
  run_id: string;
  account: string;
  read_at: string;
  complete: boolean;
  entitlements: { effect_key: string; count: number; amount_minor_total: number; objects: StatementObject[] }[];
  unattributed: StatementObject[];
  paid_twice: number;
};

export type Pool = {
  run_id: string;
  grant_minor: number;
  held_minor: number;
  settled_minor: number;
  frozen: boolean;
  currency: string;
  awaiting_budget: string[];
};

export type CheckId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C9" | "C10";
export type Certificate = {
  certificate_version: 1;
  run_id: string;
  group_id: string;
  arm: string;
  scenario: string;
  manifest_sha256: string;
  commitment_sha256: string | null;
  checked_at: string;
  ledger: { sim_objects: number; stripe_objects: number | null };
  safety: "PASS" | "FAIL";
  checks: Record<CheckId, { status: "PASS" | "FAIL"; count: number }>;
  findings: {
    check: string;
    effect_key: string | null;
    claim_id: string | null;
    provider_object_ids: string[];
    also_listed_as: string | null;
    message: string;
  }[];
  completion: {
    owed_paid: [number, number];
    refusals_correct: [number, number];
    holds_correct: [number, number];
    over_parked: number;
    goodwill_paid_minor: number;
    goodwill_eligible_minor: number;
  };
  notes: string[];
};

/** An audit event as sent on the SSE stream (a signal to refetch, not the data). */
export type StreamEvent = {
  _id: string;
  at: string;
  type: string;
  actor?: string;
  intent_id?: string | null;
  effect_key?: string | null;
  claim_id?: string | null;
  from_state?: IntentState | null;
  to_state?: IntentState | null;
  transition?: string | null;
};
