// Test-only fixtures for the pure recovery code. Synthetic data only.
import { Intent, hashFrozenRequest, type Attempt, type FrozenRequest, type ProviderId, type ProviderObject } from "@nt/contracts";

export const RUN = "r7k2m9qa";
export const T0 = new Date("2026-11-14T18:00:00.000Z");

const RAIL: Record<ProviderId, FrozenRequest["rail"]> = { sim_payout: "instant", sim_keyless: "legacy", stripe_refund: null, notify_letter: null };

export function makeIntent(provider: ProviderId = "sim_payout", over: Partial<Intent> = {}): Intent {
  const letter = provider === "notify_letter"; // CP-LETTER-1: a decision letter, amount 0
  const effect_key = provider === "stripe_refund" ? "ZT4H9X.P03.NT101-20261110.TICKET_REFUND" : letter ? "LETTER.C13" : "ZT4H9X.P13.NT880-20261110.APPR_DELAY";
  const amount = letter ? 0 : 70000;
  const _id = `${RUN}:${effect_key}`;
  const frozen_request: FrozenRequest = {
    provider,
    operation: provider === "stripe_refund" ? "REFUND" : letter ? "NOTIFY" : "PAYOUT",
    account: provider === "stripe_refund" ? "stripe" : "acct_test",
    rail: RAIL[provider],
    amount_minor: amount,
    currency: "CAD",
    payee_ref: "payee_P13",
    parent_ref: provider === "stripe_refund" ? "pi_test_parent_1" : null,
    metadata: { nt_marker: _id, nt_effect_key: effect_key, nt_run_id: RUN, nt_type: letter ? "DECISION_LETTER" : "APPR_DELAY" },
  };
  const base: Intent = {
    _id,
    run_id: RUN,
    effect_key,
    obligation_id: _id,
    entitlement_type: provider === "stripe_refund" ? "TICKET_REFUND" : letter ? "DECISION_LETTER" : "APPR_DELAY",
    amount_minor: amount,
    currency: "CAD",
    payee_ref: "payee_P13",
    provider,
    idempotency_key: provider === "sim_keyless" || letter ? null : _id,
    frozen_request,
    frozen_request_sha256: hashFrozenRequest(frozen_request),
    draws_on: null,
    state: "OUTCOME_UNKNOWN",
    lease: null,
    lease_epoch: 2,
    first_dispatch_at: T0,
    last_send_at: T0,
    key_expires_at: new Date(T0.getTime() + 86_400_000 - 60_000),
    next_attempt_at: T0,
    attempts: [attempt(1, "FIRST_SEND")],
    evidence: null,
    rejection: null,
    quarantine: null,
    policy_version: "APPR-SOR-2019-150@2022-09-08",
    rule_citation: "APPR s.19(1)(a)(i)",
    created_at: T0,
    updated_at: T0,
  };
  return Intent.parse({ ...base, ...over });
}

export function attempt(n: number, licence: Attempt["licence"] = n === 1 ? "FIRST_SEND" : "L1_SAME_KEY"): Attempt {
  return { n, at: new Date(T0.getTime() + n * 1000), licence, request_sha256: "0".repeat(64), epoch: n, result: null };
}

export function attempts(count: number): Attempt[] {
  return Array.from({ length: count }, (_, i) => attempt(i + 1));
}

/** A provider object that matches `it` exactly, with an accepted status for its provider. */
export function objectFor(it: Intent, over: Partial<ProviderObject> = {}): ProviderObject {
  return {
    id: it.provider === "stripe_refund" ? "re_test_1" : "po_b71e04c9d2a6f318",
    kind: it.provider === "stripe_refund" ? "refund" : it.provider === "notify_letter" ? "message" : "payout",
    status: it.provider === "stripe_refund" ? "succeeded" : it.provider === "notify_letter" ? "sent" : "paid",
    amount_minor: it.amount_minor,
    currency: it.currency,
    payee_ref: it.payee_ref,
    parent_ref: it.frozen_request.parent_ref,
    metadata: { nt_marker: it._id, nt_effect_key: it.effect_key, nt_run_id: it.run_id },
    created_at: "2026-11-14T18:00:01.000Z",
    ...over,
  };
}

/** Deep-freeze, so a test fails if the pure code mutates its input. */
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o) && !(o instanceof Date)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}
