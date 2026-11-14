// The frozen request is built from the obligation (and, for a Stripe refund, the booking's payment reference) by
// deterministic code. Nothing in it comes from a proposal or from model output (HANDOVER.md §9.3, §10.2 T1).
import { hashFrozenRequest, marker, simAccountOf, type FrozenRequest, type Obligation, type ProviderCapabilities, type ProviderId } from "@nt/contracts";
import { ProgrammerError } from "./errors.ts";

/** HANDOVER.md §12.1: TICKET_REFUND → stripe_refund when Stripe is enabled; otherwise the rail picks the simulator. */
export function providerFor(ob: Pick<Obligation, "entitlement_type" | "rail">, stripeEnabled: boolean): ProviderId {
  if (ob.entitlement_type === "DECISION_LETTER") return "notify_letter"; // CP-LETTER-1: a letter, through NotifySim, keyless
  if (ob.entitlement_type === "TICKET_REFUND" && stripeEnabled) return "stripe_refund";
  return ob.rail === "instant" ? "sim_payout" : "sim_keyless";
}

export type FrozenCtx = { runId: string; ticketPaymentRef?: string | null };

export function buildFrozenRequest(
  ob: Pick<Obligation, "effect_key" | "entitlement_type" | "amount_minor" | "currency" | "payee_ref" | "rail">,
  provider: ProviderId,
  ctx: FrozenCtx,
): FrozenRequest {
  const m = marker(ctx.runId, ob.effect_key);
  const stripe = provider === "stripe_refund";
  const letter = provider === "notify_letter";
  // CP-LETTER-1: a letter carries amount 0 and nothing else does; a payment of 0 or a letter with an amount is a programmer error.
  if (letter !== (ob.entitlement_type === "DECISION_LETTER")) throw new ProgrammerError(`provider ${provider} for ${ob.entitlement_type}`);
  if (letter ? ob.amount_minor !== 0 : ob.amount_minor < 1) throw new ProgrammerError(`amount_minor ${ob.amount_minor} is invalid for ${ob.entitlement_type}`);
  if (stripe && !ctx.ticketPaymentRef) throw new ProgrammerError(`no ticket_payment_ref on the booking for ${ob.effect_key}`);
  return {
    provider,
    operation: letter ? "NOTIFY" : ob.entitlement_type === "TICKET_REFUND" ? "REFUND" : "PAYOUT",
    account: stripe ? "stripe" : simAccountOf(ctx.runId),
    rail: stripe || letter ? null : ob.rail,
    amount_minor: ob.amount_minor,
    currency: ob.currency,
    payee_ref: ob.payee_ref,
    parent_ref: stripe ? (ctx.ticketPaymentRef ?? null) : null,
    metadata: { nt_marker: m, nt_effect_key: ob.effect_key, nt_run_id: ctx.runId, nt_type: ob.entitlement_type },
  };
}

/** The marker on a rail that deduplicates on the key; null on a keyless rail. */
export function idempotencyKeyFor(intentId: string, caps: ProviderCapabilities): string | null {
  return caps.dedupesOnIdempotencyKey ? intentId : null;
}

export { hashFrozenRequest };
