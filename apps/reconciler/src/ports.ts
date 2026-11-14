// The reconciler's ports (task D2). The reconciler never writes payment_intents or authority_grants itself and never calls a provider:
// every state change goes through ReconcilerGateway (ARCHITECTURE.md §4.5 Gateway, the seam-3 contract), and provider reads go through
// the gateway's read-only provider view. The store is the reconciler's own database access: candidate scans and the clock (database
// clock, $$NOW), the recovery guards (through the gateway client), and investigation_records (through the investigator client).
import type {
  BarrierName,
  DispatchResult,
  Intent,
  InvestigationStep,
  ProviderCapabilities,
  ProviderId,
  ProviderObject,
  QuarantineReason,
  RecoveryDecision,
  RecoveryGuards,
} from "@nt/contracts";
import type { ReadOnlyProviderView, WitnessEvidence } from "@nt/recovery/investigator";
import type { ObjectId } from "mongodb";

export type EvidenceInput = { object: ProviderObject; source: "RESPONSE" | "REDISPATCH" | "PROBE" };

/**
 * The subset of the Gateway interface (ARCHITECTURE.md §4.5) the reconciler calls. Return types admit `null` ("another worker acted",
 * or the compare-and-set lost) so both the documented `Promise<Intent>` and B3's `Promise<Intent | null>` satisfy it.
 */
export interface ReconcilerGateway {
  /** T2 (or T11), then T3 | T4 | T5 | T13. Orphaned RESERVED intents only. */
  dispatch(intentId: string, worker: string): Promise<Intent | null>;
  /** T5, reconciler form: lease_epoch + 1, lease cleared, next_attempt_at = $$NOW. null: not expired / someone else moved it. */
  takeOverExpired(intentId: string, seenEpoch: number, worker: string): Promise<Intent | null>;
  /** Not a transition. Guarded single-document update; null: another worker has it or it is not due. */
  acquireLease(intentId: string, seenEpoch: number, worker: string): Promise<Intent | null>;
  /** T6 (from OUTCOME_UNKNOWN). */
  settle(it: Intent, ev: EvidenceInput, ctx: { investigationId: ObjectId | null }): Promise<Intent | null>;
  /** T9 from OUTCOME_UNKNOWN. */
  quarantine(it: Intent, reason: QuarantineReason, detail: string): Promise<Intent | null>;
  /** T8a: appends the licence to attempts with majority acknowledgement, BEFORE any byte. null: not licensed now → send nothing. */
  recordLicence(it: Intent, licence: "L1_SAME_KEY", ctx: { investigationId: ObjectId }): Promise<Intent | null>;
  /** assertHash; the same frozen bytes under the same key. No database write. */
  resend(it2: Intent, opts?: { unlicensed?: boolean }): Promise<DispatchResult>;
  /** T6 | T7 | T8b (backoff) | T9. */
  applyResendResult(it2: Intent, res: DispatchResult): Promise<Intent | null>;
  /** Read-only provider access for the investigator (no createPaymentOrRefund). */
  readOnlyProviderView(provider: ProviderId): ReadOnlyProviderView;
  capabilitiesOf(provider: ProviderId): ProviderCapabilities;
  /** T12 (Tier 2 watcher): QUARANTINED (absence class) → CONFIRMED on matching evidence. Optional until B3 exposes it. */
  confirmQuarantined?(it: Intent, object: ProviderObject): Promise<Intent | null>;
  /** Tier 3 (CP-REV-1): records a PROVIDER_REVERSAL audit event for a CONFIRMED intent whose object the provider now reports undone.
   *  No state change and no provider write; the gateway re-runs the fixed detector. */
  recordProviderReversal?(it: Intent, object: ProviderObject): Promise<{ kind: string }>;
}

export type OpenedRecord = { id: ObjectId };

export type ClosedRecord = {
  investigator: "llm" | "deterministic";
  fallback_reason: string | null;
  hypothesis: string | null;
  steps: InvestigationStep[];
  records: ProviderObject[];
  complete: boolean;
  match: "MATCH" | "NO_MATCH" | "CONTRADICTION";
  match_detail: string | null;
  decision: RecoveryDecision;
  licence: "L1_SAME_KEY" | null;
  guards: RecoveryGuards;
  db_now: Date;
  /** Tier 2: ids of the past investigation records shown to the LLM investigator before it started (advisory context only). */
  recalled?: string[];
};

export interface ReconcilerStore {
  /** The database clock ($$NOW). Never Date.now(). */
  now(): Promise<Date>;
  /** Candidate scans (ARCHITECTURE.md §3.3), compared on the database clock; each action re-checks in its own compare-and-set. */
  orphans(runId: string, leaseMs: number): Promise<Intent[]>;
  expiredDispatching(runId: string): Promise<Intent[]>;
  dueUnknown(runId: string): Promise<Intent[]>;
  watchable(runId: string): Promise<Intent[]>;
  /** Tier 3 (CP-REV-1): CONFIRMED intents of the run with no PROVIDER_REVERSAL audit event yet. */
  confirmedUnreversed?(runId: string): Promise<Intent[]>;
  /** Count of RESERVED, DISPATCHING or OUTCOME_UNKNOWN intents of the run (QUARANTINED does not count). */
  unresolvedCount(runId: string): Promise<number>;
  /** Guards for decideRecovery, read through the gateway client from obligations and authority_grants. Bookings are not read. */
  guards(it: Intent): Promise<RecoveryGuards>;
  openInvestigation(it: Intent, worker: string): Promise<OpenedRecord>;
  closeInvestigation(rec: OpenedRecord, it: Intent, closed: ClosedRecord, worker: string): Promise<void>;
}

export type Barrier = (name: BarrierName, effectKey?: string) => void;

/** Evidence plus, on the LLM path with Tier 2 recall on, the ids of the past records shown to the model. */
export type CollectedWithRecall = WitnessEvidence & { recalled?: string[] };

/** Collects evidence for one intent: the model path with the deterministic fallback, or deterministic only. Never writes. */
export type Collect = (it: Intent) => Promise<CollectedWithRecall>;

/** Tier 2: embeds a closed investigation record (best effort; never throws, never blocks recovery). */
export type EmbedClosed = (investigationId: ObjectId) => Promise<void>;

export type Logger = (line: string) => void;
