// Investigator, evidence and the recovery decision (HANDOVER.md §11.2–11.3; ARCHITECTURE.md §6.7).
import { z } from "zod";
import type { Attempt, Intent } from "./intent.ts";
import { ProviderObject } from "./provider.ts";
import type { AdjudicationStatus, HeldReason, NotOwedReason, Rail } from "./reasons.ts";
import { QuarantineReason } from "./reasons.ts";

// ---------------------------------------------------------------------------------------------------------------- evidence match

export type EvidenceMatch =
  | { kind: "MATCH"; object: ProviderObject }
  | { kind: "NO_MATCH" }
  | { kind: "CONTRADICTION"; why: "MULTIPLE_OBJECTS" | "FIELD_MISMATCH" | `STATUS_${string}` };
/** Alias of EvidenceMatch (AGENT_TASKS.md packet A / D name). */
export type MatchResult = EvidenceMatch;
export const EVIDENCE_MATCH_KINDS = ["MATCH", "NO_MATCH", "CONTRADICTION"] as const;

// ---------------------------------------------------------------------------------------------------------------- recovery decision

/** Read by the caller (through the gateway's client) immediately before decideRecovery; HANDOVER.md §11.3. */
export type RecoveryGuards = { obligationStatus: AdjudicationStatus; obligationReason: NotOwedReason | HeldReason | null; grantFrozen: boolean };

/** Row of the truth table in HANDOVER.md §11.3 (row 8 is Tier 3). */
export const RECOVERY_ROWS = [1, 2, 3, 4, 5, 6, 7, 9] as const;
export type RecoveryRow = (typeof RECOVERY_ROWS)[number];

/** Tier 1 and Tier 2: exactly three kinds. WAIT and an L2 re-send exist only if licence L2 is built (Tier 3, PLANNED);
 *  adding them is a change proposal to this package, not a silent extension. */
export const RECOVERY_DECISION_KINDS = ["SETTLE", "REDISPATCH_SAME_KEY", "QUARANTINE"] as const;

export type RecoveryDecision = { row: RecoveryRow } & (
  | { kind: "SETTLE"; object: ProviderObject } // row 2 → T6
  | { kind: "REDISPATCH_SAME_KEY"; licence: "L1_SAME_KEY" } // row 6 → T8
  | { kind: "QUARANTINE"; reason: QuarantineReason; detail: string } // rows 1, 3, 4, 5, 7, 9 → T9
);

const Row = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(9)]);
/** Runtime schema for RecoveryDecision (e.g. investigation_records.decision). Admits only the three kinds. */
export const RecoveryDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ row: Row, kind: z.literal("SETTLE"), object: ProviderObject }).strict(),
  z.object({ row: Row, kind: z.literal("REDISPATCH_SAME_KEY"), licence: z.literal("L1_SAME_KEY") }).strict(),
  z.object({ row: Row, kind: z.literal("QUARANTINE"), reason: QuarantineReason, detail: z.string() }).strict(),
]);

// ---------------------------------------------------------------------------------------------------------------- investigator

/** No secrets, no frozen bytes. */
export type IntentSummary = Pick<Intent, "_id" | "provider" | "amount_minor" | "currency" | "payee_ref" | "first_dispatch_at" | "last_send_at"> & {
  rail: Rail | null;
  attempts: Pick<Attempt, "n" | "at" | "licence" | "result">[];
};
export type ProviderPage = { records: ProviderObject[]; has_more: boolean; next_cursor: string | null };

/** Account, payee and marker are fixed from the intent; the model chooses order, window and paging [ADD-13]. */
export interface ReadOnlyEvidenceTools {
  get_intent_summary(): Promise<IntentSummary>;
  /** Strongly consistent. */
  list_provider_payments_by_payee(q: { created_gte?: string; starting_after?: string; limit?: number }): Promise<ProviderPage>;
  /** Lags. */
  search_provider_payments(): Promise<{ records: ProviderObject[] }>;
  /** Tier 2. */
  list_provider_events?(q: { since?: string }): Promise<{ events: { type: string; object_id: string; at: string }[] }>;
}

export type InvestigationStep = { tool: string; input: unknown; summary: string; record_count: number };
export type CollectedEvidence = {
  investigator: "llm" | "deterministic";
  hypothesis: string | null;
  steps: InvestigationStep[];
  /** Accumulated by the tool implementations; the model cannot type a record in. */
  records: ProviderObject[];
  /** True only if the strongly consistent list was followed to its last page. */
  complete: boolean;
};

/** Tier 2. Implemented with Voyage AI in packages/agents. */
export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[], inputType: "document" | "query"): Promise<number[][]>;
}

/** Context for the model only; never matcher input. */
export type PastInvestigation = {
  hypothesis: string | null;
  rail: Rail | null;
  fault_signature: string;
  evidence_queries: string[];
  match: EvidenceMatch["kind"];
  decision_kind: RecoveryDecision["kind"];
  score: number;
};
/** [] on any failure, including no vector index. */
export interface Recall {
  similar(it: Intent, k: number): Promise<PastInvestigation[]>;
}

export interface Investigator {
  readonly kind: "llm" | "deterministic";
  /** Never writes, never sends, never throws for a model failure. */
  collect(it: Intent, tools: ReadOnlyEvidenceTools, opts: { timeoutMs: number; recalled?: PastInvestigation[] }): Promise<CollectedEvidence>;
}
