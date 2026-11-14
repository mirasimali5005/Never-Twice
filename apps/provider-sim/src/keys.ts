// Idempotency key store, per account, rail "instant" only.
// A record stores the OUTCOME OF THE OPERATION (committed object -> 201, definitive rejection -> 400),
// not the transport response a fault may have altered. Records older than retention_ms on the account's
// virtual clock are forgotten and the key executes anew.

export type StoredResult =
  | { status: 201; object_id: string }
  | { status: 400; error: { code: string; message: string } };

export type KeyRecord = {
  key: string;
  body_sha256: string;
  state: "IN_PROGRESS" | "DONE";
  result: StoredResult | null;
  created_at_ms: number; // virtual time
};

export class KeyStore {
  private records = new Map<string, KeyRecord>();

  /** Returns the live record, forgetting it first if it has outlived retention on the virtual clock. */
  lookup(key: string, nowMs: number, retentionMs: number): KeyRecord | undefined {
    const rec = this.records.get(key);
    if (!rec) return undefined;
    if (nowMs - rec.created_at_ms >= retentionMs) {
      this.records.delete(key);
      return undefined;
    }
    return rec;
  }

  beginInProgress(key: string, bodySha256: string, nowMs: number): KeyRecord {
    const rec: KeyRecord = { key, body_sha256: bodySha256, state: "IN_PROGRESS", result: null, created_at_ms: nowMs };
    this.records.set(key, rec);
    return rec;
  }

  /** Store the operation's result and mark DONE. Creates the record if it is missing (late commit after expiry). */
  complete(key: string, bodySha256: string, result: StoredResult, createdAtMs: number): KeyRecord {
    const existing = this.records.get(key);
    const rec: KeyRecord = {
      key,
      body_sha256: bodySha256,
      state: "DONE",
      result,
      created_at_ms: existing && existing.body_sha256 === bodySha256 ? existing.created_at_ms : createdAtMs,
    };
    this.records.set(key, rec);
    return rec;
  }

  /** Used when rebuilding from the ledger: the last stored line for a key wins. */
  restore(rec: KeyRecord): void {
    this.records.set(rec.key, rec);
  }

  clear(): void {
    this.records.clear();
  }

  size(): number {
    return this.records.size;
  }
}
