// Shared fixtures for the reconciler tests: a well-formed intent and a matching provider object.
import type { Intent, ProviderCapabilities, ProviderId, ProviderObject } from "@nt/contracts";

export const RUN = "rtest001";
export const T0 = new Date("2026-11-14T15:00:00.000Z");
export const CAPS: Record<ProviderId, ProviderCapabilities> = {
  sim_payout: { dedupesOnIdempotencyKey: true, keyRetentionMs: 86_400_000, declaredMaxInFlightMs: null, stronglyConsistentList: true },
  sim_keyless: { dedupesOnIdempotencyKey: false, keyRetentionMs: null, declaredMaxInFlightMs: null, stronglyConsistentList: true },
  stripe_refund: { dedupesOnIdempotencyKey: true, keyRetentionMs: 86_400_000, declaredMaxInFlightMs: null, stronglyConsistentList: true },
};

export function intent(p: string, provider: ProviderId, over: Partial<Intent> = {}): Intent {
  const id = `${RUN}:ZT4H9X.${p}.NT101-20261110.APPR_DELAY`;
  const keyed = provider !== "sim_keyless";
  return {
    _id: id,
    run_id: RUN,
    effect_key: `ZT4H9X.${p}.NT101-20261110.APPR_DELAY`,
    obligation_id: `${RUN}:ZT4H9X.${p}.NT101-20261110.APPR_DELAY`,
    entitlement_type: "APPR_DELAY",
    amount_minor: 70000,
    currency: "CAD",
    payee_ref: `payee_${p}`,
    provider,
    idempotency_key: keyed ? id : null,
    frozen_request: {
      provider,
      operation: "PAYOUT",
      account: "acct_test",
      rail: keyed ? "instant" : "legacy",
      amount_minor: 70000,
      currency: "CAD",
      payee_ref: `payee_${p}`,
      parent_ref: null,
      metadata: { nt_marker: id, nt_effect_key: `ZT4H9X.${p}.NT101-20261110.APPR_DELAY`, nt_run_id: RUN, nt_type: "APPR_DELAY" },
    },
    frozen_request_sha256: "a".repeat(64),
    draws_on: null,
    state: "OUTCOME_UNKNOWN",
    lease: null,
    lease_epoch: 1,
    first_dispatch_at: new Date(T0.getTime() - 10_000),
    last_send_at: new Date(T0.getTime() - 10_000),
    key_expires_at: keyed ? new Date(T0.getTime() + 86_400_000 - 60_000) : null,
    next_attempt_at: new Date(T0.getTime() - 1),
    attempts: [{ n: 1, at: new Date(T0.getTime() - 10_000), licence: "FIRST_SEND", request_sha256: "a".repeat(64), epoch: 1, result: null }],
    evidence: null,
    rejection: null,
    quarantine: null,
    policy_version: "APPR-SOR-2019-150@2022-09-08",
    rule_citation: "SOR/2019-150 s.19(1)(a)(i)",
    created_at: new Date(T0.getTime() - 20_000),
    updated_at: new Date(T0.getTime() - 10_000),
    ...over,
  } as Intent;
}

export function obj(it: Intent, over: Partial<ProviderObject> = {}): ProviderObject {
  return {
    id: `po_${it.effect_key.split(".")[1]}`,
    kind: "payout",
    status: "paid",
    amount_minor: it.amount_minor,
    currency: it.currency,
    payee_ref: it.payee_ref,
    parent_ref: null,
    metadata: { nt_marker: it._id },
    created_at: T0.toISOString(),
    ...over,
  };
}

