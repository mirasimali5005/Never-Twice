// Other stored documents (HANDOVER.md §8, §8.2; ARCHITECTURE.md §5.1 examples). Dates are Date in documents.
// These shapes are not spelled out in ARCHITECTURE.md §6; they follow the §5.1 example documents (see the A2 report).
import { z } from "zod";
import { ObjectIdLike } from "./audit.ts";
import { GroupId, RunId } from "./identity.ts";
import { Minor } from "./money.ts";
import { ClaimExtraction } from "./model.ts";
import { ProviderObject } from "./provider.ts";
import { RecoveryDecisionSchema } from "./recovery.ts";
import { Arm, GoodwillKind, HeldReason, Licence, ProviderId, Rail, RunStatus, Scenario } from "./reasons.ts";
import { FinalReport } from "./report.ts";

/** authority_grants: the guarded goodwill pool, _id `${run_id}:GOODWILL`. Tier 3 (CP-AUTH-1): optional sub-grants
 *  (`${run_id}:GOODWILL/DESK_A`, `${run_id}:GOODWILL/DESK_A/AGENT_1`) name their `ancestors`, parent first, the pool last;
 *  a reservation on a sub-grant must fit every level. Absent `ancestors` = a root (the single-pool default). */
export const AuthorityGrant = z.object({
  _id: z.string(),
  run_id: RunId,
  kind: z.literal("GOODWILL_POOL"),
  grant_minor: Minor.min(0),
  held_minor: Minor.min(0),
  settled_minor: Minor.min(0),
  frozen: z.boolean(),
  currency: z.literal("CAD"),
  policy_version: z.string(),
  ancestors: z.array(z.string()).optional(),
});
export type AuthorityGrant = z.infer<typeof AuthorityGrant>;

/** execution_runs: _id = run_id. */
export const ExecutionRun = z.object({
  _id: RunId,
  group_id: GroupId,
  arm: Arm,
  scenario: Scenario,
  seed: z.number().int(),
  fault_schedule: z.string(),
  sim_account: z.string(),
  status: RunStatus,
  started_at: z.date().nullable(),
  ended_at: z.date().nullable(),
  final_report: FinalReport.nullable(),
});
export type ExecutionRun = z.infer<typeof ExecutionRun>;

export const CLAIM_STATUSES = ["RECEIVED", "EXTRACTED", "RESOLVED", "HELD"] as const;
export const ClaimStatus = z.enum(CLAIM_STATUSES);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/** claims: _id `${run_id}:${claim_id}`. */
export const Claim = z.object({
  _id: z.string(),
  run_id: RunId,
  claim_id: z.string(),
  channel: z.string(),
  received_at: z.date(),
  raw_text: z.string(),
  status: ClaimStatus,
  hold_reason: HeldReason.nullable(),
  extraction: ClaimExtraction.nullable(),
  extraction_meta: z
    .object({
      model: z.string(),
      prompt_version: z.string(),
      mode: z.enum(["live", "record", "replay"]),
      request_sha256: z.string(),
      attempts: z.number().int().min(0),
    })
    .nullable(),
  resolution: z
    .object({ booking_ref: z.string(), passenger_ids: z.array(z.string()), method: z.string(), similarity: z.number() })
    .nullable(),
  flags: z.object({ payeeChangeRequested: z.boolean(), goodwillProposed: GoodwillKind.nullable() }),
  effect_keys: z.array(z.string()),
  embedding: z.array(z.number()).nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type Claim = z.infer<typeof Claim>;

/** investigation_records: append then close. Tier 2 recall fields are optional and written after close. */
export const InvestigationRecord = z.object({
  _id: ObjectIdLike,
  run_id: RunId,
  intent_id: z.string(),
  epoch: z.number().int(),
  investigator: z.enum(["llm", "deterministic"]),
  hypothesis: z.string().nullable(),
  steps: z.array(z.object({ tool: z.string(), input: z.unknown(), summary: z.string(), record_count: z.number().int().min(0) })),
  records: z.array(ProviderObject),
  match: z.enum(["MATCH", "NO_MATCH", "CONTRADICTION"]).nullable(),
  decision: RecoveryDecisionSchema.nullable(),
  licence: Licence.nullable(),
  opened_at: z.date(),
  closed_at: z.date().nullable(),
  // Tier 2 recall fields [ADD-33]
  rail: Rail.nullable().optional(),
  provider: ProviderId.optional(),
  fault_signature: z.string().optional(),
  evidence_queries: z.array(z.string()).optional(),
  recalled: z.array(ObjectIdLike).optional(),
  embedding_text: z.string().nullable().optional(),
  embedding_model: z.string().nullable().optional(),
  embedding: z.array(z.number()).nullable().optional(),
});
export type InvestigationRecord = z.infer<typeof InvestigationRecord>;
