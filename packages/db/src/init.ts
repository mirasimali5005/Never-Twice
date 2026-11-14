// `pnpm db:init` body (ARCHITECTURE.md §5.2, AGENT_TASKS.md B1). Idempotent: creates what is missing, re-applies
// validators with collMod only when they differ, and creates only missing indexes. Never inside a transaction.
// Never drops a collection or a database.
import type { Db, Document, IndexDirection } from "mongodb";
import { ENTITLEMENT_TYPES, INTENT_STATES, PROVIDER_IDS } from "@nt/contracts";
import { COLLECTIONS, COLLECTION_NAMES, type CollectionName } from "./collections.ts";

const VALIDATION = { validationLevel: "strict", validationAction: "error" } as const;

/** The payment_intents $jsonSchema of ARCHITECTURE.md §5.2 (HANDOVER.md §8.1). */
export const PAYMENT_INTENTS_SCHEMA: Document = {
  bsonType: "object",
  required: [
    "_id", "run_id", "effect_key", "obligation_id", "entitlement_type", "amount_minor", "currency", "payee_ref", "provider",
    "idempotency_key", "frozen_request", "frozen_request_sha256", "draws_on", "state", "lease", "lease_epoch", "attempts",
    "policy_version", "rule_citation", "created_at", "updated_at",
  ],
  properties: {
    _id: { bsonType: "string" },
    run_id: { bsonType: "string" },
    effect_key: { bsonType: "string", pattern: "^[A-Z0-9._-]+$" },
    obligation_id: { bsonType: "string" },
    state: { enum: [...INTENT_STATES] },
    amount_minor: { bsonType: ["int", "long"], minimum: 1 },
    currency: { enum: ["CAD"] },
    payee_ref: { bsonType: "string" },
    entitlement_type: { enum: [...ENTITLEMENT_TYPES] },
    provider: { enum: [...PROVIDER_IDS] },
    idempotency_key: { bsonType: ["string", "null"] },
    draws_on: { bsonType: ["string", "null"] },
    frozen_request: { bsonType: "object" },
    frozen_request_sha256: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
    lease: {
      bsonType: ["object", "null"],
      required: ["owner", "expires_at"],
      additionalProperties: false,
      properties: { owner: { bsonType: "string" }, expires_at: { bsonType: "date" } }, // no epoch in the lease
    },
    lease_epoch: { bsonType: ["int", "long"], minimum: 0 },
    attempts: { bsonType: "array" },
    policy_version: { bsonType: "string" },
    rule_citation: { bsonType: "string" },
    created_at: { bsonType: "date" },
    updated_at: { bsonType: "date" },
  },
};

const runIdOnly: Document = { bsonType: "object", required: ["run_id"], properties: { run_id: { bsonType: "string" } } };

/** Validators per collection. Collections not listed carry no validator (policies, probes, execution_runs keyed by run_id). */
export const VALIDATORS: Partial<Record<CollectionName, Document>> = {
  [COLLECTIONS.intents]: PAYMENT_INTENTS_SCHEMA,
  [COLLECTIONS.bookings]: runIdOnly,
  [COLLECTIONS.claims]: runIdOnly,
  [COLLECTIONS.obligations]: runIdOnly,
  [COLLECTIONS.grants]: runIdOnly,
  [COLLECTIONS.investigations]: runIdOnly,
  [COLLECTIONS.audit]: {
    bsonType: "object",
    required: ["run_id", "type", "at", "actor"],
    properties: {
      run_id: { bsonType: "string" },
      type: { bsonType: "string" },
      at: { bsonType: "date" },
      actor: { bsonType: "object", required: ["kind", "id"] },
    },
  },
};

/** The indexes of ARCHITECTURE.md §5.2. `_id` values are the natural keys; no extra unique index is needed. */
export const INDEXES: ReadonlyArray<{ collection: CollectionName; key: Record<string, IndexDirection> }> = [
  { collection: COLLECTIONS.bookings, key: { run_id: 1, flight_no: 1 } },
  { collection: COLLECTIONS.claims, key: { run_id: 1, status: 1 } },
  { collection: COLLECTIONS.obligations, key: { run_id: 1, status: 1 } },
  { collection: COLLECTIONS.intents, key: { run_id: 1, state: 1, "lease.expires_at": 1 } },
  { collection: COLLECTIONS.intents, key: { run_id: 1, state: 1, next_attempt_at: 1 } },
  { collection: COLLECTIONS.audit, key: { run_id: 1, _id: 1 } },
  { collection: COLLECTIONS.audit, key: { intent_id: 1, _id: 1 } },
  { collection: COLLECTIONS.runs, key: { group_id: 1 } },
  { collection: COLLECTIONS.investigations, key: { run_id: 1, intent_id: 1, _id: 1 } },
];

export type InitReport = {
  dbName: string;
  collections: { name: string; action: "created" | "existing" }[];
  // "unauthorized": the validator differs and this user may not run collMod (observed on the event sandbox, code 13).
  // The collection is left as it is; the CLI exits non-zero so the difference is never silent.
  validators: { name: string; action: "applied" | "updated" | "unchanged" | "unauthorized" }[];
  indexes: { collection: string; name: string; action: "created" | "existing" }[];
};

const indexName = (key: Record<string, IndexDirection>) => Object.entries(key).map(([k, v]) => `${k}_${String(v)}`).join("_");
const sameKey = (a: Document, b: Document) => JSON.stringify(a) === JSON.stringify(b);

/** Creates the ten collections, their validators and indexes. Safe to run any number of times. */
export async function initDatabase(db: Db): Promise<InitReport> {
  const report: InitReport = { dbName: db.databaseName, collections: [], validators: [], indexes: [] };
  const existing = new Map<string, Document>();
  for (const info of await db.listCollections({}, { nameOnly: false }).toArray()) {
    existing.set(info.name, (info as { options?: Document }).options ?? {});
  }

  for (const name of COLLECTION_NAMES) {
    const validator = VALIDATORS[name];
    const opts: Document = validator ? { validator: { $jsonSchema: validator }, ...VALIDATION } : {};
    const current = existing.get(name);
    if (current === undefined) {
      try {
        await db.createCollection(name, opts);
        report.collections.push({ name, action: "created" });
        if (validator) report.validators.push({ name, action: "applied" });
        continue;
      } catch (e) {
        if ((e as { code?: number }).code !== 48) throw e; // 48 NamespaceExists: created concurrently; fall through
        report.collections.push({ name, action: "existing" });
      }
    } else {
      report.collections.push({ name, action: "existing" });
    }
    if (!validator) continue;
    const unchanged =
      current !== undefined &&
      sameKey(current.validator ?? {}, opts.validator ?? {}) &&
      current.validationLevel === VALIDATION.validationLevel &&
      current.validationAction === VALIDATION.validationAction;
    if (unchanged) {
      report.validators.push({ name, action: "unchanged" });
    } else {
      try {
        await db.command({ collMod: name, ...opts });
        report.validators.push({ name, action: "updated" });
      } catch (e) {
        if ((e as { code?: number }).code !== 13) throw e; // 13 Unauthorized
        report.validators.push({ name, action: "unauthorized" });
      }
    }
  }

  for (const { collection, key } of INDEXES) {
    const present = await db.collection(collection).listIndexes().toArray();
    const match = present.find((ix) => sameKey(ix.key as Document, key));
    if (match) {
      report.indexes.push({ collection, name: String(match.name), action: "existing" });
    } else {
      const name = await db.collection(collection).createIndex(key, { name: indexName(key) });
      report.indexes.push({ collection, name, action: "created" });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------------------------------------------
// Tier 2, behind `pnpm db:init -- --vector`: Atlas Vector Search index definitions (ARCHITECTURE.md §5.2). Advisory
// only, outside the safety argument. Definition syntax, dimensions and similarity must be checked against current
// Atlas documentation before relying on them. A refusal by the deployment is reported and does not fail db:init.

export type VectorIndexReport = { collection: string; name: string; action: "created" | "existing" | "failed"; error?: string };

export function vectorIndexDefinitions(numDimensions: number) {
  return [
    {
      collection: COLLECTIONS.investigations,
      name: "investigation_recall",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions, similarity: "cosine" },
          { type: "filter", path: "rail" },
          { type: "filter", path: "provider" },
          { type: "filter", path: "match" },
          { type: "filter", path: "run_id" },
          // Recall pre-filters on intent_id ($ne: the intent under investigation) so k results are never eaten by a post-filter.
          { type: "filter", path: "intent_id" },
        ],
      },
    },
    {
      collection: COLLECTIONS.claims,
      name: "claims_embedding",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions, similarity: "cosine" },
          { type: "filter", path: "run_id" },
        ],
      },
    },
  ] as const;
}

export async function initVectorIndexes(db: Db, opts: { numDimensions: number }): Promise<VectorIndexReport[]> {
  const out: VectorIndexReport[] = [];
  for (const spec of vectorIndexDefinitions(opts.numDimensions)) {
    const coll = db.collection(spec.collection);
    try {
      const found = await coll.listSearchIndexes(spec.name).toArray();
      if (found.length > 0) {
        out.push({ collection: spec.collection, name: spec.name, action: "existing" });
        continue;
      }
      await coll.createSearchIndex({ name: spec.name, type: "vectorSearch", definition: spec.definition as unknown as Document });
      out.push({ collection: spec.collection, name: spec.name, action: "created" });
    } catch (e) {
      out.push({ collection: spec.collection, name: spec.name, action: "failed", error: (e as Error).message });
    }
  }
  return out;
}
