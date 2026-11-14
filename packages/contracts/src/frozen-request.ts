// The frozen request (HANDOVER.md §9.3; ARCHITECTURE.md §6.3).
// Wire format for the simulator: the HTTP body is exactly canonicalJson(frozen_request), the whole FrozenRequest, so the SHA-256 of the
// raw body equals frozen_request_sha256. One hash, used by the simulator's request log and by its key-reuse check.
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { Minor } from "./money.ts";
import { ProviderId, Rail } from "./reasons.ts";

export const FrozenRequestMetadata = z
  .object({ nt_marker: z.string(), nt_effect_key: z.string(), nt_run_id: z.string(), nt_type: z.string() })
  .strict();
export type FrozenRequestMetadata = z.infer<typeof FrozenRequestMetadata>;

export const FrozenRequest = z
  .object({
    provider: ProviderId,
    operation: z.enum(["PAYOUT", "REFUND"]),
    account: z.string(), // simulator account, or "stripe"
    rail: Rail.nullable(),
    amount_minor: Minor.min(1),
    currency: z.literal("CAD"),
    payee_ref: z.string(), // synthetic payee token
    parent_ref: z.string().nullable(), // Stripe PaymentIntent id for a refund
    metadata: FrozenRequestMetadata,
  })
  .strict();
export type FrozenRequest = z.infer<typeof FrozenRequest>;
/** Alias of FrozenRequest (AGENT_TASKS.md packet A name). */
export const FrozenRequestSchema = FrozenRequest;

/** frozen_request_sha256 = sha256Hex(canonicalJson(frozen_request)). Validates first; throws on an invalid request.
 *  The only function that computes this hash. */
export function hashFrozenRequest(fr: FrozenRequest): string {
  const parsed = FrozenRequest.parse(fr);
  return sha256Hex(canonicalJson(parsed));
}

/** The exact HTTP body sent to the simulator for this request. */
export function frozenRequestBody(fr: FrozenRequest): string {
  return canonicalJson(FrozenRequest.parse(fr));
}
