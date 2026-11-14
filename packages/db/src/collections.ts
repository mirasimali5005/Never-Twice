// The ten collections of HANDOVER.md §8 and minimal structural document types.
//
// @nt/contracts (task A2) is not merged yet. The types below are deliberately loose: they name only the
// fields this package reads or that every caller relies on, and allow the rest. Each carries a TODO(A2)
// marker and is to be replaced by the contracts type once A2 is frozen. No contract logic lives here.
import type { Collection, Db, Document, ObjectId } from "mongodb";

export const COLLECTIONS = {
  bookings: "bookings",
  claims: "claims",
  obligations: "obligations",
  intents: "payment_intents",
  grants: "authority_grants",
  audit: "audit_events",
  runs: "execution_runs",
  investigations: "investigation_records",
  policies: "policies",
  probes: "probes",
} as const;

export type CollectionKey = keyof typeof COLLECTIONS;
export type CollectionName = (typeof COLLECTIONS)[CollectionKey];
export const COLLECTION_NAMES: readonly CollectionName[] = Object.values(COLLECTIONS);

// TODO(A2): replace with @nt/contracts type (IntentState)
export const INTENT_STATES = [
  "RESERVED",
  "DISPATCHING",
  "OUTCOME_UNKNOWN",
  "CONFIRMED",
  "FAILED_NO_EFFECT",
  "QUARANTINED",
  "RELEASED",
] as const;
// TODO(A2): replace with @nt/contracts type (IntentState)
export type IntentState = (typeof INTENT_STATES)[number];

// TODO(A2): replace with @nt/contracts type (EntitlementType)
export const ENTITLEMENT_TYPES = ["APPR_DELAY", "APPR_DENIED_BOARDING", "APPR_REFUND_COMP", "TICKET_REFUND", "GOODWILL"] as const;
// TODO(A2): replace with @nt/contracts type (ProviderId)
export const PROVIDER_IDS = ["sim_payout", "sim_keyless", "stripe_refund"] as const;

// TODO(A2): replace with @nt/contracts type (Booking)
export type BookingDoc = Document & { _id: string; run_id: string; booking_ref: string; flight_no: string };
// TODO(A2): replace with @nt/contracts type (Claim)
export type ClaimDoc = Document & { _id: string; run_id: string; claim_id: string; status: string };
// TODO(A2): replace with @nt/contracts type (Obligation)
export type ObligationDoc = Document & {
  _id: string;
  run_id: string;
  effect_key: string;
  status: string;
  amount_minor: number;
  currency: string;
  payee_ref: string;
};
// TODO(A2): replace with @nt/contracts type (PaymentIntent)
export type IntentDoc = Document & {
  _id: string;
  run_id: string;
  effect_key: string;
  state: IntentState;
  amount_minor: number;
  currency: "CAD";
  lease: { owner: string; expires_at: Date } | null;
  lease_epoch: number;
  draws_on: string | null;
};
// TODO(A2): replace with @nt/contracts type (AuthorityGrant)
export type GrantDoc = Document & {
  _id: string;
  run_id: string;
  grant_minor: number;
  held_minor: number;
  settled_minor: number;
  frozen: boolean;
};
// TODO(A2): replace with @nt/contracts type (AuditEvent)
export type AuditDoc = Document & {
  _id: ObjectId;
  run_id: string;
  at: Date;
  actor: { kind: string; id: string };
  type: string;
};
// TODO(A2): replace with @nt/contracts type (ExecutionRun)
export type RunDoc = Document & { _id: string; group_id?: string; status?: string };
// TODO(A2): replace with @nt/contracts type (InvestigationRecord)
export type InvestigationDoc = Document & { _id: ObjectId; run_id: string; intent_id: string };
// TODO(A2): replace with @nt/contracts type (Policy)
export type PolicyDoc = Document & { _id: string };
// TODO(A2): replace with @nt/contracts type (ProbeSpec)
export type ProbeDoc = Document & { _id: string };

export type NtCollections = {
  bookings: Collection<BookingDoc>;
  claims: Collection<ClaimDoc>;
  obligations: Collection<ObligationDoc>;
  intents: Collection<IntentDoc>;
  grants: Collection<GrantDoc>;
  audit: Collection<AuditDoc>;
  runs: Collection<RunDoc>;
  investigations: Collection<InvestigationDoc>;
  policies: Collection<PolicyDoc>;
  probes: Collection<ProbeDoc>;
};

/** Typed accessors for exactly the ten collections. */
export function collectionsOf(db: Db): NtCollections {
  return {
    bookings: db.collection<BookingDoc>(COLLECTIONS.bookings),
    claims: db.collection<ClaimDoc>(COLLECTIONS.claims),
    obligations: db.collection<ObligationDoc>(COLLECTIONS.obligations),
    intents: db.collection<IntentDoc>(COLLECTIONS.intents),
    grants: db.collection<GrantDoc>(COLLECTIONS.grants),
    audit: db.collection<AuditDoc>(COLLECTIONS.audit),
    runs: db.collection<RunDoc>(COLLECTIONS.runs),
    investigations: db.collection<InvestigationDoc>(COLLECTIONS.investigations),
    policies: db.collection<PolicyDoc>(COLLECTIONS.policies),
    probes: db.collection<ProbeDoc>(COLLECTIONS.probes),
  };
}

/** A collection handle that reads with read concern majority (re-reads after a failed guard or unknown commit). */
export function majorityReader<K extends CollectionKey>(db: Db, key: K): NtCollections[K] {
  return db.collection(COLLECTIONS[key], { readConcern: { level: "majority" } }) as NtCollections[K];
}
