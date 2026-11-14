// Gateway proposals (HANDOVER.md §9.4, §10.3; ARCHITECTURE.md §6.5).
import { z } from "zod";
import { Actor } from "./audit.ts";
import { RunId } from "./identity.ts";
import type { Intent } from "./intent.ts";
import { Minor } from "./money.ts";
import type { ProposalRefusal } from "./reasons.ts";

/** Built by the orchestrator from an OWED obligation; the model never writes one. */
export const ProposedPayment = z.object({
  run_id: RunId,
  effect_key: z.string(),
  amount_minor: Minor.min(1),
  currency: z.literal("CAD"),
  payee_ref: z.string(),
  claim_ids: z.array(z.string()),
  proposed_by: Actor,
});
export type ProposedPayment = z.infer<typeof ProposedPayment>;

export const PROPOSE_RESULT_KINDS = ["RESERVED", "ADOPTED", "DIVERGED", "REFUSED"] as const;

export type ProposeResult =
  | { kind: "RESERVED"; intent: Intent }
  | { kind: "ADOPTED"; intent: Intent } // an intent with the same frozen_request_sha256 already existed
  | { kind: "DIVERGED"; intent: Intent } // HANDOVER.md §9.4: existing intent returned, DECISION_DIVERGENCE appended [ADD-13]
  | { kind: "REFUSED"; reason: ProposalRefusal }; // a proposal refusal, not an adjudication
