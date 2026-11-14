// The payment_intents document (HANDOVER.md §8.1 frozen shape; ARCHITECTURE.md §6.4).
import { z } from "zod";
import { SHA256_HEX_RE } from "./canonical.ts";
import { FrozenRequest } from "./frozen-request.ts";
import { RunId } from "./identity.ts";
import { Minor } from "./money.ts";
import { EntitlementType, Licence, ProviderId, QuarantineReason } from "./reasons.ts";
import { IntentState } from "./states.ts";

/** NO epoch: the only epoch is Intent.lease_epoch. Strict, so a lease carrying an epoch fails. */
export const Lease = z.object({ owner: z.string(), expires_at: z.date() }).strict();
export type Lease = z.infer<typeof Lease>;

/** [ADD-8] */
export const AttemptResult = z.object({
  kind: z.enum(["ACCEPTED", "REJECTED_DEFINITIVE", "INDETERMINATE", "CONTRADICTION", "LEASE_EXPIRED"]),
  cause: z.string().nullable(),
  code: z.string().nullable(),
  replayed: z.boolean().nullable(),
  provider_object_id: z.string().nullable(),
});
export type AttemptResult = z.infer<typeof AttemptResult>;

export const Attempt = z.object({
  n: z.number().int().min(1),
  at: z.date(),
  licence: Licence,
  request_sha256: z.string(),
  epoch: z.number().int(),
  result: AttemptResult.nullable(),
});
export type Attempt = z.infer<typeof Attempt>;

export const Evidence = z.object({
  source: z.enum(["RESPONSE", "REDISPATCH", "PROBE"]),
  provider_object_id: z.string(),
  status: z.string(),
  amount_minor: Minor,
  currency: z.string(),
  payee_ref: z.string(),
  marker: z.string(),
  retrieved_at: z.date(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Intent = z.object({
  _id: z.string(),
  run_id: RunId,
  effect_key: z.string(),
  obligation_id: z.string(),
  entitlement_type: EntitlementType,
  amount_minor: Minor.min(1),
  currency: z.literal("CAD"),
  payee_ref: z.string(),
  provider: ProviderId,
  idempotency_key: z.string().nullable(),
  frozen_request: FrozenRequest,
  frozen_request_sha256: z.string().regex(SHA256_HEX_RE),
  draws_on: z.string().nullable(),
  state: IntentState,
  lease: Lease.nullable(),
  lease_epoch: z.number().int().min(0),
  first_dispatch_at: z.date().nullable(),
  last_send_at: z.date().nullable(),
  key_expires_at: z.date().nullable(),
  next_attempt_at: z.date().nullable(),
  attempts: z.array(Attempt),
  evidence: Evidence.nullable(),
  rejection: z.object({ code: z.string(), message: z.string(), replayed: z.boolean(), at: z.date() }).nullable(),
  quarantine: z.object({ reason: QuarantineReason, detail: z.string(), at: z.date() }).nullable(),
  policy_version: z.string(),
  rule_citation: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type Intent = z.infer<typeof Intent>;
/** Alias of Intent (AGENT_TASKS.md packet A name). */
export const PaymentIntent = Intent;
export type PaymentIntent = Intent;
