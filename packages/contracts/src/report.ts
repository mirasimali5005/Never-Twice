// The graded final report (HANDOVER.md §14; ARCHITECTURE.md §6.6).
//
// Rules: written by the runner at the end of its pass from MongoDB state (complete: false if anything is unresolved);
// rewritten by `pnpm run:arm -- --run <id> --report-only` after `pnpm reconcile -- --run <id> --until-drained`; always regenerated,
// never edited; the reconciler never writes it. `complete` is true only when `unresolved` is empty and every claim has been
// adjudicated. Every claim and every obligation of the run appears in exactly one list. `parked` holds everything waiting for a person:
//   quarantined intents  → reason_code a QuarantineReason, effect_key set, claim_id null, amount_minor = the held amount;
//   HELD obligations     → reason_code a HeldReason, effect_key set, claim_id null, amount_minor null;
//   claim-level holds    → reason_code a HeldReason, effect_key null, claim_id set, amount_minor null.
// A RELEASED intent is listed under failed_no_effect with code RELEASED_BEFORE_SEND.
import { z } from "zod";
import { GroupId, RunId } from "./identity.ts";
import { Minor } from "./money.ts";
import { Arm, HeldReason, NotOwedReason, ProviderId, QuarantineReason, Scenario } from "./reasons.ts";

export const RELEASED_BEFORE_SEND = "RELEASED_BEFORE_SEND";

export const FinalReportPaid = z.object({
  effect_key: z.string(),
  marker: z.string(),
  amount_minor: Minor,
  currency: z.literal("CAD"),
  payee_ref: z.string(),
  provider: ProviderId,
  provider_object_id: z.string(),
});
export const FinalReportRefused = z.object({ effect_key: z.string(), reason_code: NotOwedReason, rule_citation: z.string() });
export const FinalReportParked = z.object({
  effect_key: z.string().nullable(),
  claim_id: z.string().nullable(),
  reason_code: z.union([HeldReason, QuarantineReason]),
  amount_minor: Minor.nullable(),
});
export const FinalReportAwaitingBudget = z.object({ effect_key: z.string(), amount_minor: Minor });
export const FinalReportFailedNoEffect = z.object({ effect_key: z.string(), code: z.string() });
export const FinalReportUnresolved = z.object({ effect_key: z.string(), state: z.string() });

export const FinalReport = z.object({
  run_id: RunId,
  group_id: GroupId,
  arm: Arm,
  scenario: Scenario,
  generated_at: z.string(),
  complete: z.boolean(),
  paid: z.array(FinalReportPaid),
  refused: z.array(FinalReportRefused),
  parked: z.array(FinalReportParked),
  awaiting_budget: z.array(FinalReportAwaitingBudget),
  failed_no_effect: z.array(FinalReportFailedNoEffect),
  unresolved: z.array(FinalReportUnresolved),
});
export type FinalReport = z.infer<typeof FinalReport>;
/** Alias of FinalReport (AGENT_TASKS.md packet A name). */
export const FinalReportSchema = FinalReport;
