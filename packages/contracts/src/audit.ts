// Audit events (HANDOVER.md §8.2; ARCHITECTURE.md §6.4).
import { z } from "zod";
import { RunId } from "./identity.ts";
import { AuditEventType } from "./reasons.ts";
import { IntentState } from "./states.ts";

/** Structural stand-in for a BSON ObjectId, so this package needs no `bson` dependency (ARCHITECTURE.md §6.4 permits z.unknown()
 *  here; this is stricter). A real `ObjectId` from the `mongodb` driver satisfies it. */
export type ObjectIdLike = { toHexString(): string };
export const ObjectIdLike = z.custom<ObjectIdLike>(
  (v) => typeof v === "object" && v !== null && typeof (v as { toHexString?: unknown }).toHexString === "function",
  { message: "expected an ObjectId" },
);

export const ACTOR_KINDS = ["gateway", "orchestrator", "reconciler", "investigator", "agent", "human"] as const;
export const Actor = z.object({ kind: z.enum(ACTOR_KINDS), id: z.string() });
export type Actor = z.infer<typeof Actor>;

export const AuditEvent = z.object({
  _id: ObjectIdLike,
  run_id: RunId,
  at: z.date(),
  actor: Actor,
  type: AuditEventType,
  intent_id: z.string().nullable(),
  effect_key: z.string().nullable(),
  claim_id: z.string().nullable(),
  from_state: IntentState.nullable(),
  to_state: IntentState.nullable(),
  rule_citation: z.string().nullable(),
  policy_version: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
