// Transactions (HANDOVER.md §8.4, ARCHITECTURE.md §3.5). Behaviour observed by B-INT-03 on MongoDB 8.2.6
// (mongodb-memory-server) and 9.0.7 (event sandbox): a duplicate _id inside a transaction raises 11000 without the
// TransientTransactionError label, so withTransaction does not re-run the callback; a WriteConflict (112) carries
// that label and the callback is re-run.
import { MongoError, type ClientSession, type TransactionOptions } from "mongodb";
import type { NtDb } from "./client.ts";

/** Read concern snapshot, write concern majority: every transaction in the system uses these. */
export const TXN_OPTIONS: TransactionOptions = Object.freeze({
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
}) as TransactionOptions;

/** The driver's label for a commit whose outcome is unknown after its own retries (driver 7.9.0, MongoErrorLabel). */
export const UNKNOWN_COMMIT_LABEL = "UnknownTransactionCommitResult";
export const TRANSIENT_TXN_LABEL = "TransientTransactionError";

/** Thrown inside a callback when a guarded write matched nothing: the transaction aborts and is not re-run. */
export class CasMiss extends Error {
  constructor(message = "compare-and-set matched no document") {
    super(message);
    this.name = "CasMiss";
  }
}

type WithCode = { code?: unknown; writeErrors?: unknown; writeErrorsByIndex?: unknown; cause?: unknown };

/** Code 11000, also when wrapped in a bulk write error or as the cause of another error. */
export function isDuplicateKey(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 4) return false;
  const err = e as WithCode;
  if (err.code === 11000) return true;
  const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : err.writeErrors ? [err.writeErrors] : [];
  if (writeErrors.some((w) => (w as WithCode)?.code === 11000)) return true;
  return err.cause !== undefined && isDuplicateKey(err.cause, depth + 1);
}

/** True when the driver labelled the error UnknownTransactionCommitResult: the transaction may or may not have committed. */
export function isUnknownCommitResult(e: unknown): boolean {
  return e instanceof MongoError && e.hasErrorLabel(UNKNOWN_COMMIT_LABEL);
}

/**
 * Runs `fn` in one transaction with snapshot read concern and majority write concern, and always ends the session.
 * The driver may run `fn` more than once (transient errors, write conflicts): `fn` must contain only database
 * operations on the session it receives. No provider call, no model call, no clock read that matters, no logging
 * that claims an outcome. Build every id and document before calling withTxn so that a re-run writes the same thing.
 * Errors propagate unchanged (classify them with isDuplicateKey / isUnknownCommitResult or use tryTxn).
 */
export async function withTxn<T>(ntdb: Pick<NtDb, "client">, fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = ntdb.client.startSession();
  try {
    return await session.withTransaction((s) => fn(s), TXN_OPTIONS);
  } finally {
    await session.endSession();
  }
}

export type TxnOutcome<T> =
  | { kind: "COMMITTED"; value: T }
  | { kind: "DUPLICATE_KEY"; error: unknown } // aborted; nothing written; read the existing document (majority)
  | { kind: "UNKNOWN_COMMIT_RESULT"; error: unknown } // may or may not have committed; check by a pre-minted _id (majority)
  | { kind: "CAS_MISS"; error: CasMiss }; // a guarded write matched nothing; aborted; nothing written

/**
 * withTxn with the three expected non-commit endings mapped to typed outcomes. Any other error (including the
 * caller's own domain errors thrown from `fn`, and loss of a majority) is rethrown unchanged.
 */
export async function tryTxn<T>(ntdb: Pick<NtDb, "client">, fn: (session: ClientSession) => Promise<T>): Promise<TxnOutcome<T>> {
  try {
    return { kind: "COMMITTED", value: await withTxn(ntdb, fn) };
  } catch (e) {
    if (e instanceof CasMiss) return { kind: "CAS_MISS", error: e };
    if (isDuplicateKey(e)) return { kind: "DUPLICATE_KEY", error: e };
    if (isUnknownCommitResult(e)) return { kind: "UNKNOWN_COMMIT_RESULT", error: e };
    throw e;
  }
}
