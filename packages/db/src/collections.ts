// The ten collections of HANDOVER.md §8 with the document types of @nt/contracts (task A2, frozen at IC0).
// No contract logic lives here: state, entitlement and provider enums are re-used from @nt/contracts.
import type { Collection, Db, Document } from "mongodb";
import type {
  AuditEvent,
  AuthorityGrant,
  Booking,
  Claim,
  ExecutionRun,
  Intent,
  InvestigationRecord,
  Obligation,
} from "@nt/contracts";
export { ENTITLEMENT_TYPES, INTENT_STATES, PROVIDER_IDS, type IntentState } from "@nt/contracts";

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

export type BookingDoc = Booking;
export type ClaimDoc = Claim;
export type ObligationDoc = Obligation;
export type IntentDoc = Intent;
export type GrantDoc = AuthorityGrant;
export type AuditDoc = AuditEvent;
export type RunDoc = ExecutionRun;
export type InvestigationDoc = InvestigationRecord;
/** @nt/contracts has fixture shapes for policies (ApprPolicy, GoodwillPolicy) but no stored-document type; kept open. */
export type PolicyDoc = Document & { _id: string };
/** Tier 3 probe specifications (HANDOVER.md §11.4); no contracts type; kept open. */
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
