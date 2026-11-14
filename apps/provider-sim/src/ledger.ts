// Accounts, the append-only ledger (the provider's system of record) and the request log.
// Two JSONL files per account under the data dir: <account>.ledger.jsonl and <account>.requests.jsonl.
// Every line is written (synchronously) before the response is sent. On start the state is rebuilt from the
// ledger. Held late commits, IN_PROGRESS key records and fault schedules are NOT persisted.
// /admin/reset is the only operation that truncates a file.
import fs from "node:fs";
import path from "node:path";
import { VirtualClock } from "./clock.ts";
import { sha256Hex, canonicalJson } from "./canonical.ts";
import { KeyStore } from "./keys.ts";
import type { FaultEntry } from "./faults.ts";
import type { StoredResult } from "./keys.ts";

export type AccountConfig = { account: string; retention_ms: number; max_in_flight_ms: number | null; search_lag_ms: number };

export type PayoutObject = {
  id: string;
  kind: "payout" | "refund";
  /** "paid" on creation; "reversed" or "failed" only after POST /admin/payouts/reverse (Tier 3: a payout undone later). */
  status: "paid" | "reversed" | "failed";
  amount_minor: number;
  currency: string;
  payee_ref: string;
  parent_ref: string | null;
  metadata: Record<string, string>;
  created_at: string;
};

export type StoredObject = { seq: number; obj: PayoutObject };

/** NotifySim (Tier 3, task C4): a keyless message, e.g. the written decision letter. Not a payment. */
export type MessageObject = {
  id: string;
  object: "message";
  status: "sent";
  recipient: string;
  template: string;
  amount_minor: number | null;
  currency: string | null;
  metadata: Record<string, string>;
  created_at: string;
};

export type StoredMessage = { seq: number; msg: MessageObject };

export function messageId(account: string, seq: number): string {
  return "msg_" + sha256Hex(`${account}:msg:${seq}`).slice(0, 16);
}

export type RequestLogEntry = {
  seq: number;
  at: string;
  method: string;
  path: string;
  idempotency_key: string | null;
  body_sha256: string | null;
  fault: string | null;
  outcome: string;
  status: number | null;
};

export type HeldRequest = {
  account: string;
  payee_ref: string;
  marker: string | null;
  key: string | null; // set on rail instant with a key
  body_sha256: string;
  kind: "payout" | "refund";
  amount_minor: number;
  currency: string;
  parent_ref: string | null;
  metadata: Record<string, string>;
  fault: "LATE_COMMIT_ON_RELEASE" | "LATE_COMMIT_AFTER_MS";
  timer: NodeJS.Timeout | null;
  committed: boolean;
};

export const ACCOUNT_NAME = /^[A-Za-z0-9_.-]{1,80}$/;

export function objectId(account: string, kind: "payout" | "refund", seq: number): string {
  return (kind === "refund" ? "rf_" : "po_") + sha256Hex(`${account}:${seq}`).slice(0, 16);
}

export class AccountState {
  readonly config: AccountConfig;
  readonly clock = new VirtualClock();
  readonly keys = new KeyStore();
  faults: FaultEntry[] = [];
  held: HeldRequest[] = [];
  objects: StoredObject[] = []; // creation order
  byId = new Map<string, StoredObject>();
  messages: StoredMessage[] = []; // NotifySim, creation order
  msgById = new Map<string, StoredMessage>();
  msgOrdinal = 0; // count of message requests that passed validation
  ledgerSeq = 0;
  requestSeq = 0;
  ordinal = 0; // count of payout requests that passed validation
  requestLog: RequestLogEntry[] = [];
  private readonly ledgerPath: string;
  private readonly requestsPath: string;

  constructor(config: AccountConfig, dataDir: string) {
    this.config = config;
    this.ledgerPath = path.join(dataDir, `${config.account}.ledger.jsonl`);
    this.requestsPath = path.join(dataDir, `${config.account}.requests.jsonl`);
  }

  /** Append ledger lines in one write so a kill cannot leave an object without its key record. */
  appendLedger(lines: Array<Record<string, unknown> & { type: string }>): void {
    const at = new Date().toISOString();
    const vt = this.clock.nowIso();
    const text = lines
      .map((l) => JSON.stringify({ seq: l.type === "payout_created" || l.type === "message_created" ? (l.seq as number) : ++this.ledgerSeq, at, vt, account: this.config.account, ...l }))
      .join("\n");
    fs.appendFileSync(this.ledgerPath, text + "\n");
  }

  appendRequest(entry: Omit<RequestLogEntry, "seq" | "at">): void {
    const full: RequestLogEntry = { seq: ++this.requestSeq, at: new Date().toISOString(), ...entry };
    fs.appendFileSync(this.requestsPath, JSON.stringify(full) + "\n");
    this.requestLog.push(full);
  }

  /** Commit a new object: ledger payout_created (+ key_stored for a keyed request) in one write. */
  commitObject(args: {
    kind: "payout" | "refund";
    amount_minor: number;
    currency: string;
    payee_ref: string;
    parent_ref: string | null;
    metadata: Record<string, string>;
    key: string | null;
    body_sha256: string;
  }): PayoutObject {
    const seq = ++this.ledgerSeq;
    const obj: PayoutObject = {
      id: objectId(this.config.account, args.kind, seq),
      kind: args.kind,
      status: "paid",
      amount_minor: args.amount_minor,
      currency: args.currency,
      payee_ref: args.payee_ref,
      parent_ref: args.parent_ref,
      metadata: args.metadata,
      created_at: this.clock.nowIso(),
    };
    const lines: Array<Record<string, unknown> & { type: string }> = [{ type: "payout_created", seq, object: obj }];
    const keyCreated = args.key !== null ? this.keyCreatedAt(args.key, args.body_sha256) : 0;
    if (args.key !== null) {
      lines.push({
        type: "key_stored",
        key: args.key,
        body_sha256: args.body_sha256,
        key_created_at_ms: keyCreated,
        result: { status: 201, object_id: obj.id },
      });
    }
    this.appendLedger(lines);
    const so: StoredObject = { seq, obj };
    this.objects.push(so);
    this.byId.set(obj.id, so);
    if (args.key !== null) {
      this.keys.restore({ key: args.key, body_sha256: args.body_sha256, state: "DONE", result: { status: 201, object_id: obj.id }, created_at_ms: keyCreated });
    }
    return obj;
  }

  /** NotifySim: commit a message (ledger message_created). Keyless: no key record is ever stored. */
  commitMessage(args: { recipient: string; template: string; amount_minor: number | null; currency: string | null; metadata: Record<string, string> }): MessageObject {
    const seq = ++this.ledgerSeq;
    const msg: MessageObject = {
      id: messageId(this.config.account, seq),
      object: "message",
      status: "sent",
      recipient: args.recipient,
      template: args.template,
      amount_minor: args.amount_minor,
      currency: args.currency,
      metadata: args.metadata,
      created_at: this.clock.nowIso(),
    };
    this.appendLedger([{ type: "message_created", seq, message: msg }]);
    const sm: StoredMessage = { seq, msg };
    this.messages.push(sm);
    this.msgById.set(msg.id, sm);
    return msg;
  }

  private keyCreatedAt(key: string, bodySha: string): number {
    // The record may be IN_PROGRESS (late commit): keep its creation time; otherwise it is created now.
    const rec = this.keys.lookup(key, this.clock.now(), Number.MAX_SAFE_INTEGER);
    return rec && rec.body_sha256 === bodySha ? rec.created_at_ms : this.clock.now();
  }

  /** Store a definitive rejection as the key's result (no object). */
  storeRejection(key: string, bodySha: string, error: { code: string; message: string }): void {
    const result: StoredResult = { status: 400, error };
    const created = this.clock.now();
    this.appendLedger([{ type: "key_stored", key, body_sha256: bodySha, key_created_at_ms: created, result }]);
    this.keys.restore({ key, body_sha256: bodySha, state: "DONE", result, created_at_ms: created });
  }

  /** Tier 3: the provider later undoes a paid object (status paid → reversed | failed). One-way; appended to the ledger. */
  reverseObject(id: string, status: "reversed" | "failed"): PayoutObject | "not_found" | "not_paid" {
    const so = this.byId.get(id);
    if (!so) return "not_found";
    if (so.obj.status !== "paid") return "not_paid";
    this.appendLedger([{ type: "payout_status_changed", object_id: id, status }]);
    so.obj = { ...so.obj, status };
    return so.obj;
  }

  advanceClock(ms: number): void {
    this.clock.advance(ms);
    this.appendLedger([{ type: "clock_advanced", ms, offset_ms: this.clock.offsetMs }]);
  }

  /** Objects as the state hash sees them: sorted by id. */
  stateHash(): { objects: number; state_hash: string } {
    const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const sorted = this.objects.map((o) => o.obj).sort(byId);
    if (this.messages.length === 0) return { objects: sorted.length, state_hash: sha256Hex(canonicalJson(sorted)) };
    // NotifySim messages are part of the state (canary 4 of probe admission compares this hash before and after a probe).
    const msgs = this.messages.map((m) => m.msg).sort(byId);
    return { objects: sorted.length + msgs.length, state_hash: sha256Hex(canonicalJson({ objects: sorted, messages: msgs })) };
  }

  /** Truncate this account's files; keep its configuration and its (monotone) clock offset. */
  reset(): void {
    for (const h of this.held) if (h.timer) clearTimeout(h.timer);
    this.held = [];
    this.faults = [];
    this.objects = [];
    this.byId.clear();
    this.messages = [];
    this.msgById.clear();
    this.msgOrdinal = 0;
    this.keys.clear();
    this.requestLog = [];
    this.requestSeq = 0;
    this.ordinal = 0;
    this.ledgerSeq = 0;
    fs.writeFileSync(this.ledgerPath, "");
    fs.writeFileSync(this.requestsPath, "");
    this.writeCreated();
    if (this.clock.offsetMs > 0) {
      this.appendLedger([{ type: "clock_advanced", ms: this.clock.offsetMs, offset_ms: this.clock.offsetMs }]);
    }
  }

  writeCreated(): void {
    this.appendLedger([{ type: "account_created", ...this.config }]);
  }
}

export class Store {
  readonly dataDir: string;
  readonly accounts = new Map<string, AccountState>();
  private readonly objectIndex = new Map<string, AccountState>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.rebuild();
  }

  get(account: string): AccountState | undefined {
    return this.accounts.get(account);
  }

  createAccount(config: AccountConfig): AccountState {
    const acct = new AccountState(config, this.dataDir);
    acct.writeCreated();
    this.accounts.set(config.account, acct);
    return acct;
  }

  /** NotifySim: global lookup of a message by id. */
  findMessage(id: string): { acct: AccountState; sm: StoredMessage } | undefined {
    for (const a of this.accounts.values()) {
      const sm = a.msgById.get(id);
      if (sm) return { acct: a, sm };
    }
    return undefined;
  }

  /** Global lookup by object id (ids are unique across accounts). */
  findObject(id: string): { acct: AccountState; so: StoredObject } | undefined {
    const idx = this.objectIndex.get(id);
    const acct = idx ?? this.findByScan(id);
    const so = acct?.byId.get(id);
    return acct && so ? { acct, so } : undefined;
  }

  private findByScan(id: string): AccountState | undefined {
    for (const a of this.accounts.values()) {
      if (a.byId.has(id)) {
        this.objectIndex.set(id, a);
        return a;
      }
    }
    return undefined;
  }

  /** Replay every <account>.ledger.jsonl (and request log) in the data dir. */
  private rebuild(): void {
    for (const f of fs.readdirSync(this.dataDir).sort()) {
      if (!f.endsWith(".ledger.jsonl")) continue;
      const lines = readJsonl(path.join(this.dataDir, f));
      const created = lines.find((l) => l.type === "account_created");
      if (!created) continue;
      const config: AccountConfig = {
        account: created.account as string,
        retention_ms: created.retention_ms as number,
        max_in_flight_ms: (created.max_in_flight_ms as number | null) ?? null,
        search_lag_ms: created.search_lag_ms as number,
      };
      const acct = new AccountState(config, this.dataDir);
      for (const l of lines) {
        const seq = typeof l.seq === "number" ? l.seq : 0;
        if (seq > acct.ledgerSeq) acct.ledgerSeq = seq;
        if (l.type === "payout_created") {
          const obj = l.object as PayoutObject;
          const so: StoredObject = { seq, obj };
          acct.objects.push(so);
          acct.byId.set(obj.id, so);
        } else if (l.type === "message_created") {
          const msg = l.message as MessageObject;
          const sm: StoredMessage = { seq, msg };
          acct.messages.push(sm);
          acct.msgById.set(msg.id, sm);
        } else if (l.type === "key_stored") {
          const result = l.result as StoredResult;
          acct.keys.restore({
            key: l.key as string,
            body_sha256: l.body_sha256 as string,
            state: "DONE",
            result,
            created_at_ms: typeof l.key_created_at_ms === "number" ? l.key_created_at_ms : Date.parse(l.vt as string),
          });
        } else if (l.type === "payout_status_changed") {
          const so = acct.byId.get(l.object_id as string);
          if (so) so.obj = { ...so.obj, status: l.status as PayoutObject["status"] };
        } else if (l.type === "clock_advanced") {
          acct.clock.advance(l.ms as number);
        }
      }
      const reqLines = readJsonl(path.join(this.dataDir, `${config.account}.requests.jsonl`));
      acct.requestLog = reqLines as unknown as RequestLogEntry[];
      acct.requestSeq = acct.requestLog.reduce((m, r) => Math.max(m, r.seq), 0);
      acct.ordinal = acct.requestLog.filter(
        (r) => r.method === "POST" && r.path === "/v1/payouts" && r.outcome !== "INVALID" && r.outcome !== "UNAUTHORIZED",
      ).length;
      acct.msgOrdinal = acct.requestLog.filter(
        (r) => r.method === "POST" && r.path === "/v1/messages" && r.outcome !== "INVALID" && r.outcome !== "UNAUTHORIZED",
      ).length;
      this.accounts.set(config.account, acct);
    }
  }
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // a partial last line left by a kill: ignore it
    }
  }
  return out;
}
