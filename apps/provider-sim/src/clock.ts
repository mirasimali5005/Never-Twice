// Per-account virtual clock: wall time plus an offset that can only increase.
// Used for created_at, key expiry and search lag. HOLD_RESPONSE_MS and LATE_COMMIT_AFTER_MS use real timers.
export class VirtualClock {
  private offset = 0;

  now(): number {
    return Date.now() + this.offset;
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  get offsetMs(): number {
    return this.offset;
  }

  /** Only increases. Throws on a non-positive or non-integer step. */
  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error("clock advance must be a positive integer");
    this.offset += ms;
  }
}
