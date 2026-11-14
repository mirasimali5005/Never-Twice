// Payment provider interface (HANDOVER.md §12.1; ARCHITECTURE.md §6.3).
// Outcomes are values; methods throw only on programmer error. The three read methods never mutate.
// Only packages/gateway may call createPaymentOrRefund.
import { z } from "zod";
import type { FrozenRequest } from "./frozen-request.ts";
import { Minor } from "./money.ts";
import type { ProviderId } from "./reasons.ts";

export const ProviderObject = z.object({
  id: z.string(),
  kind: z.enum(["payout", "refund"]),
  status: z.string(),
  amount_minor: Minor,
  currency: z.string(),
  payee_ref: z.string(),
  parent_ref: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  created_at: z.string(),
});
export type ProviderObject = z.infer<typeof ProviderObject>;

export const INDETERMINATE_CAUSES = ["TIMEOUT", "CONNECTION", "SERVER_ERROR", "IN_PROGRESS_CONFLICT"] as const;
export const CONTRADICTION_CODES = ["KEY_REUSED_DIFFERENT_PARAMS", "UNEXPECTED_OBJECT"] as const;

export const DispatchResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ACCEPTED"), object: ProviderObject, replayed: z.boolean() }),
  z.object({ kind: z.literal("REJECTED_DEFINITIVE"), code: z.string(), message: z.string(), replayed: z.boolean() }),
  z.object({ kind: z.literal("INDETERMINATE"), cause: z.enum(INDETERMINATE_CAUSES), detail: z.string() }),
  z.object({ kind: z.literal("CONTRADICTION"), code: z.enum(CONTRADICTION_CODES), detail: z.string() }),
]);
export type DispatchResult = z.infer<typeof DispatchResult>;

export type ProviderCapabilities = {
  dedupesOnIdempotencyKey: boolean;
  keyRetentionMs: number | null; // documented minimum retention
  declaredMaxInFlightMs: number | null; // only a simulator declares this
  stronglyConsistentList: boolean;
};

export interface PaymentProvider {
  readonly id: "sim_payout" | "sim_keyless" | "stripe_refund";
  readonly capabilities: ProviderCapabilities;
  createPaymentOrRefund(req: FrozenRequest, opts: { idempotencyKey: string | null; timeoutMs: number }): Promise<DispatchResult>;
  getOperation(providerObjectId: string): Promise<ProviderObject | null>;
  findOperationEvidence(q: { account: string; payeeRef: string; parentRef: string | null; since: Date }): Promise<{ records: ProviderObject[]; complete: boolean }>;
  listOperations(scope: { account: string; since?: Date }): AsyncIterable<ProviderObject>;
}
// Simulator providers read capabilities once at construction from GET /v1/accounts/:account (retention_ms, max_in_flight_ms,
// search_lag_ms) plus the rail: sim_payout deduplicates, sim_keyless does not. `replayed` mirrors the simulator's header
// Idempotent-Replayed: true. For stripe_refund the matcher also requires parent_ref to equal the frozen request's parent_ref.

/** Provider statuses that count as an accepted payment. Consumed by matchEvidence (packages/recovery pure sub-path). */
export const ACCEPTED_STATUSES: Record<ProviderId, ReadonlySet<string>> = {
  sim_payout: new Set(["paid"]),
  sim_keyless: new Set(["paid"]),
  stripe_refund: new Set(["succeeded", "pending"]),
};

/** Tier 3 (CP-REV-1): provider statuses that positively say an accepted payment was later undone at the provider. Only these
 *  trigger PROVIDER_REVERSAL handling; an unknown status, a missing object or a read error changes nothing (positive evidence only). */
export const REVERSAL_STATUSES: Record<ProviderId, ReadonlySet<string>> = {
  sim_payout: new Set(["reversed", "failed"]),
  sim_keyless: new Set(["reversed", "failed"]),
  stripe_refund: new Set(["failed", "canceled"]),
};
