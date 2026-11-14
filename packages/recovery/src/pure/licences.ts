// Licences and backoff (HANDOVER.md §11.3; ERRATA 12, 14, 40). Pure: `now` is always a parameter (the database clock,
// read by the caller); nothing here reads a clock or a random value.
import type { Intent, ProviderCapabilities } from "@nt/contracts";

/** First re-send backoff unit and cap (HANDOVER.md §11.3). */
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 30_000;

/**
 * key_expires_at = first_dispatch_at + provider minimum retention − NT_KEY_MARGIN_MS (computed at T2, on the database clock).
 * `null` when the provider documents no retention (no L1 window can be established).
 * The second argument is the provider's capabilities or its `keyRetentionMs` directly (AGENT_TASKS.md packet D field 9 form).
 * Clock assumption (HANDOVER.md §11.3): sound only if the provider's clock does not run ahead of the database clock by more than marginMs.
 */
export function keyExpiresAt(
  firstDispatchAt: Date,
  retention: Pick<ProviderCapabilities, "keyRetentionMs"> | number | null,
  marginMs: number,
): Date | null {
  const retentionMs = typeof retention === "number" || retention === null ? retention : retention.keyRetentionMs;
  if (retentionMs === null) return null;
  if (!Number.isFinite(retentionMs) || retentionMs < 0) throw new RangeError(`keyExpiresAt: invalid retention ${retentionMs}`);
  // A negative margin would widen the window beyond the provider's retention: refuse it.
  if (!Number.isFinite(marginMs) || marginMs < 0) throw new RangeError(`keyExpiresAt: invalid margin ${marginMs}`);
  const t = firstDispatchAt.getTime();
  if (Number.isNaN(t)) throw new RangeError("keyExpiresAt: invalid firstDispatchAt");
  return new Date(t + retentionMs - marginMs);
}

/** The intent fields the L1 check reads. A full `Intent` satisfies it. */
export type L1Intent = Pick<Intent, "idempotency_key" | "key_expires_at">;

/** Provider deduplicates on the key for this request: the provider documents deduplication and the intent carries a key. */
export function dedupesForIntent(it: Pick<Intent, "idempotency_key">, caps: Pick<ProviderCapabilities, "dedupesOnIdempotencyKey">): boolean {
  return caps.dedupesOnIdempotencyKey === true && typeof it.idempotency_key === "string" && it.idempotency_key.length > 0;
}

/** `now < key_expires_at`, strictly. `now == key_expires_at` is expired; an unknown expiry or an invalid `now` is expired. */
export function keyWindowOpen(it: Pick<Intent, "key_expires_at">, now: Date): boolean {
  if (it.key_expires_at === null) return false;
  const n = now.getTime();
  const e = it.key_expires_at.getTime();
  if (Number.isNaN(n) || Number.isNaN(e)) return false;
  return n < e;
}

/**
 * Licence L1 (same-key re-send) holds: the provider deduplicates on the key and `now < key_expires_at`.
 * The third L1 condition, identical bytes, is enforced by the gateway's hash check immediately before the send.
 * This is the licence condition alone; decideRecovery applies the guards (rows 1 to 5) before it.
 */
export function l1Holds(it: L1Intent, caps: Pick<ProviderCapabilities, "dedupesOnIdempotencyKey">, now: Date): boolean {
  return dedupesForIntent(it, caps) && keyWindowOpen(it, now);
}
/** Alias of l1Holds. */
export const l1Allowed = l1Holds;

/**
 * Backoff after an INDETERMINATE licensed re-send: min(30 s, 1 s × 2^n), where n counts re-sends including the one just made
 * (so the first re-send gives 2 s, the second 4 s, …, capped at 30 s).
 */
export function backoffMs(resendsSoFar: number): number {
  if (!Number.isInteger(resendsSoFar) || resendsSoFar < 0) throw new RangeError(`backoffMs: invalid re-send count ${resendsSoFar}`);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** resendsSoFar);
}

/** next_attempt_at = now + backoffMs(resendsSoFar). `now` is the database clock read by the caller. */
export function nextAttemptAt(now: Date, resendsSoFar: number): Date {
  const n = now.getTime();
  if (Number.isNaN(n)) throw new RangeError("nextAttemptAt: invalid now");
  return new Date(n + backoffMs(resendsSoFar));
}

/** Re-sends so far = attempts with licence other than FIRST_SEND. */
export function resendCount(it: Pick<Intent, "attempts">): number {
  return it.attempts.filter((a) => a.licence !== "FIRST_SEND").length;
}
