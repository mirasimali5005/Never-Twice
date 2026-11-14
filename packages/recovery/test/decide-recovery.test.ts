// D1-UNIT-02: the recovery truth table (HANDOVER.md §11.3; ERRATA 10), exhaustively, first matching row wins.
import {
  RECOVERY_DECISION_KINDS,
  RecoveryDecisionSchema,
  type EvidenceMatch,
  type Intent,
  type ProviderCapabilities,
  type QuarantineReason,
  type RecoveryDecision,
  type RecoveryGuards,
} from "@nt/contracts";
import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, decideRecovery } from "../src/pure/index.ts";
import { attempts, deepFreeze, makeIntent, objectFor } from "./support/fixtures.ts";

const BASE = makeIntent("sim_payout");
const EXPIRY = BASE.key_expires_at!;
const OBJ = objectFor(BASE);

const MATCHES: Record<string, EvidenceMatch> = {
  MATCH: { kind: "MATCH", object: OBJ },
  NO_MATCH: { kind: "NO_MATCH" },
  CONTRADICTION: { kind: "CONTRADICTION", why: "MULTIPLE_OBJECTS" },
};
const OBLIGATIONS: Record<string, Omit<RecoveryGuards, "grantFrozen">> = {
  OWED: { obligationStatus: "OWED", obligationReason: null },
  "HELD:PAYEE_CHANGE_REQUESTED": { obligationStatus: "HELD", obligationReason: "PAYEE_CHANGE_REQUESTED" },
  "HELD:other": { obligationStatus: "HELD", obligationReason: "CAUSE_UNDETERMINED" },
  "HELD:null": { obligationStatus: "HELD", obligationReason: null },
  "NOT_OWED:DELAY_UNDER_3H": { obligationStatus: "NOT_OWED", obligationReason: "DELAY_UNDER_3H" },
};
const NOWS: Record<string, Date> = {
  "before expiry (-1 ms)": new Date(EXPIRY.getTime() - 1),
  "long before expiry": new Date(EXPIRY.getTime() - 3_600_000),
  "at expiry (==)": new Date(EXPIRY.getTime()),
  "after expiry (+1 ms)": new Date(EXPIRY.getTime() + 1),
};
const DEDUPE: Record<string, ProviderCapabilities> = {
  dedupes: { dedupesOnIdempotencyKey: true, keyRetentionMs: 86_400_000, declaredMaxInFlightMs: null, stronglyConsistentList: true },
  "no dedupe": { dedupesOnIdempotencyKey: false, keyRetentionMs: null, declaredMaxInFlightMs: null, stronglyConsistentList: true },
};

type Case = { match: string; ob: string; frozen: boolean; n: number; dedupe: string; now: string };

/** The table of HANDOVER.md §11.3 written as data: [row, condition, expected]. Row 8 is Tier 3 and absent. */
const TABLE: [number, (c: Case) => boolean, { kind: RecoveryDecision["kind"]; reason?: QuarantineReason }][] = [
  [1, (c) => c.match === "CONTRADICTION", { kind: "QUARANTINE", reason: "CONTRADICTORY_EVIDENCE" }],
  [2, (c) => c.match === "MATCH", { kind: "SETTLE" }],
  [3, (c) => c.ob === "HELD:PAYEE_CHANGE_REQUESTED", { kind: "QUARANTINE", reason: "PAYEE_CHANGED" }],
  [4, (c) => c.frozen || !c.ob.startsWith("OWED"), { kind: "QUARANTINE", reason: "AUTHORITY_REVOKED" }],
  [5, (c) => c.n >= 5, { kind: "QUARANTINE", reason: "RETRY_BUDGET_EXHAUSTED" }],
  [6, (c) => c.dedupe === "dedupes" && NOWS[c.now]!.getTime() < EXPIRY.getTime(), { kind: "REDISPATCH_SAME_KEY" }],
  [7, (c) => c.dedupe === "dedupes" && NOWS[c.now]!.getTime() >= EXPIRY.getTime(), { kind: "QUARANTINE", reason: "KEY_WINDOW_EXPIRED" }],
  [9, () => true, { kind: "QUARANTINE", reason: "NO_DEDUPE_NO_EVIDENCE" }],
];

const cases: Case[] = [];
for (const match of Object.keys(MATCHES))
  for (const ob of Object.keys(OBLIGATIONS))
    for (const frozen of [false, true])
      for (let n = 0; n <= 5; n++)
        for (const dedupe of Object.keys(DEDUPE)) for (const now of Object.keys(NOWS)) cases.push({ match, ob, frozen, n, dedupe, now });

function run(c: Case): RecoveryDecision {
  const it = deepFreeze(makeIntent("sim_payout", { attempts: attempts(c.n) }));
  const guards: RecoveryGuards = { ...OBLIGATIONS[c.ob]!, grantFrozen: c.frozen };
  return decideRecovery(it, MATCHES[c.match]!, DEDUPE[c.dedupe]!, NOWS[c.now]!, deepFreeze(guards));
}

describe("decideRecovery: full truth table", () => {
  it(`covers the cross product (${cases.length} cases)`, () => {
    expect(cases.length).toBe(3 * 5 * 2 * 6 * 2 * 4);
  });

  it("every case yields the first matching row, its kind and its reason", () => {
    const rowsHit = new Map<number, number>();
    const failures: string[] = [];
    for (const c of cases) {
      const [row, , want] = TABLE.find(([, cond]) => cond(c))!;
      const got = run(c);
      rowsHit.set(row, (rowsHit.get(row) ?? 0) + 1);
      const reason = got.kind === "QUARANTINE" ? got.reason : undefined;
      if (got.row !== row || got.kind !== want.kind || reason !== want.reason) {
        failures.push(`${JSON.stringify(c)} → got row ${got.row} ${got.kind} ${reason ?? ""}; want row ${row} ${want.kind} ${want.reason ?? ""}`);
      }
      if (got.kind === "SETTLE") expect(got.object).toBe(OBJ);
      if (got.kind === "REDISPATCH_SAME_KEY") expect(got.licence).toBe("L1_SAME_KEY");
    }
    expect(failures).toEqual([]);
    // Every Tier 1–2 row is reachable.
    expect([...rowsHit.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 9]);
  });

  it("only the three Tier 1–2 kinds are ever returned, and every decision passes the contracts schema", () => {
    for (const c of cases) {
      const d = run(c);
      expect(RECOVERY_DECISION_KINDS).toContain(d.kind);
      expect(() => RecoveryDecisionSchema.parse(d)).not.toThrow();
      expect(d.row).not.toBe(8);
    }
  });

  it("is deterministic: the same inputs give the same decision", () => {
    for (const c of cases.filter((_, i) => i % 37 === 0)) expect(run(c)).toEqual(run(c));
  });
});

describe("decideRecovery: row order", () => {
  const caps = DEDUPE.dedupes!;
  const now = NOWS["before expiry (-1 ms)"]!;
  const it0 = makeIntent("sim_payout");
  const g = (o: Partial<RecoveryGuards> = {}): RecoveryGuards => ({ obligationStatus: "OWED", obligationReason: null, grantFrozen: false, ...o });

  it("a CONTRADICTION beats everything", () => {
    for (const why of ["MULTIPLE_OBJECTS", "FIELD_MISMATCH", "STATUS_failed"] as const) {
      const d = decideRecovery(makeIntent("sim_payout", { attempts: attempts(5) }), { kind: "CONTRADICTION", why }, caps, now, g({ obligationStatus: "HELD", obligationReason: "PAYEE_CHANGE_REQUESTED", grantFrozen: true }));
      expect(d).toMatchObject({ row: 1, kind: "QUARANTINE", reason: "CONTRADICTORY_EVIDENCE" });
      expect(d.kind === "QUARANTINE" && d.detail).toContain(why);
    }
  });

  it("a MATCH with a frozen grant, a payee-change hold, exhausted attempts and an expired key still settles", () => {
    const d = decideRecovery(makeIntent("sim_payout", { attempts: attempts(5) }), { kind: "MATCH", object: OBJ }, caps, NOWS["after expiry (+1 ms)"]!, g({ obligationStatus: "HELD", obligationReason: "PAYEE_CHANGE_REQUESTED", grantFrozen: true }));
    expect(d).toEqual({ row: 2, kind: "SETTLE", object: OBJ });
  });

  it("a payee-change hold gives PAYEE_CHANGED even with the grant frozen", () => {
    expect(decideRecovery(it0, { kind: "NO_MATCH" }, caps, now, g({ obligationStatus: "HELD", obligationReason: "PAYEE_CHANGE_REQUESTED", grantFrozen: true }))).toMatchObject({ row: 3, reason: "PAYEE_CHANGED" });
  });

  it("PAYEE_CHANGE_REQUESTED only counts with status HELD", () => {
    expect(decideRecovery(it0, { kind: "NO_MATCH" }, caps, now, g({ obligationStatus: "NOT_OWED", obligationReason: "PAYEE_CHANGE_REQUESTED" }))).toMatchObject({ row: 4, reason: "AUTHORITY_REVOKED" });
  });

  it("authority revoked beats the retry budget and the key window", () => {
    expect(decideRecovery(makeIntent("sim_payout", { attempts: attempts(5) }), { kind: "NO_MATCH" }, caps, now, g({ grantFrozen: true }))).toMatchObject({ row: 4, reason: "AUTHORITY_REVOKED" });
  });

  it("a non-boolean grantFrozen is treated as frozen (fail safe)", () => {
    const bad = { obligationStatus: "OWED", obligationReason: null, grantFrozen: undefined } as unknown as RecoveryGuards;
    expect(decideRecovery(it0, { kind: "NO_MATCH" }, caps, now, bad)).toMatchObject({ row: 4, reason: "AUTHORITY_REVOKED" });
  });

  it("an unknown obligation status is not OWED", () => {
    const bad = { obligationStatus: "owed", obligationReason: null, grantFrozen: false } as unknown as RecoveryGuards;
    expect(decideRecovery(it0, { kind: "NO_MATCH" }, caps, now, bad)).toMatchObject({ row: 4, reason: "AUTHORITY_REVOKED" });
  });

  it("an unknown match kind is never treated as absence", () => {
    const bad = { kind: "MAYBE" } as unknown as EvidenceMatch;
    expect(decideRecovery(it0, bad, caps, now, g())).toMatchObject({ row: 1, kind: "QUARANTINE", reason: "CONTRADICTORY_EVIDENCE" });
  });

  it(`retry budget: ${MAX_ATTEMPTS - 1} attempts re-sends, ${MAX_ATTEMPTS} and more quarantine (attempts count FIRST_SEND)`, () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(decideRecovery(makeIntent("sim_payout", { attempts: attempts(4) }), { kind: "NO_MATCH" }, caps, now, g())).toMatchObject({ row: 6, kind: "REDISPATCH_SAME_KEY" });
    for (const n of [5, 6, 9]) {
      expect(decideRecovery(makeIntent("sim_payout", { attempts: attempts(n) }), { kind: "NO_MATCH" }, caps, now, g())).toMatchObject({ row: 5, reason: "RETRY_BUDGET_EXHAUSTED" });
    }
    // Retry budget applies on the keyless rail too, before row 9.
    expect(decideRecovery(makeIntent("sim_keyless", { attempts: attempts(5) }), { kind: "NO_MATCH" }, DEDUPE["no dedupe"]!, now, g())).toMatchObject({ row: 5 });
  });
});

describe("decideRecovery: key_expires_at boundaries (rows 6 and 7)", () => {
  const caps = DEDUPE.dedupes!;
  const g: RecoveryGuards = { obligationStatus: "OWED", obligationReason: null, grantFrozen: false };
  const at = (ms: number) => new Date(EXPIRY.getTime() + ms);

  it("now = expiry − 1 ms → REDISPATCH_SAME_KEY under L1", () => {
    expect(decideRecovery(BASE, { kind: "NO_MATCH" }, caps, at(-1), g)).toEqual({ row: 6, kind: "REDISPATCH_SAME_KEY", licence: "L1_SAME_KEY" });
  });
  it("now == expiry → expired: KEY_WINDOW_EXPIRED", () => {
    expect(decideRecovery(BASE, { kind: "NO_MATCH" }, caps, at(0), g)).toMatchObject({ row: 7, kind: "QUARANTINE", reason: "KEY_WINDOW_EXPIRED" });
  });
  it("now = expiry + 1 ms → KEY_WINDOW_EXPIRED", () => {
    expect(decideRecovery(BASE, { kind: "NO_MATCH" }, caps, at(1), g)).toMatchObject({ row: 7, reason: "KEY_WINDOW_EXPIRED" });
  });
  it("key_expires_at null with a deduplicating provider → KEY_WINDOW_EXPIRED (no window, no licence)", () => {
    expect(decideRecovery(makeIntent("sim_payout", { key_expires_at: null }), { kind: "NO_MATCH" }, caps, at(-1000), g)).toMatchObject({ row: 7, reason: "KEY_WINDOW_EXPIRED" });
  });
  it("an invalid now (NaN date) never licenses a re-send", () => {
    expect(decideRecovery(BASE, { kind: "NO_MATCH" }, caps, new Date(Number.NaN), g)).toMatchObject({ row: 7, reason: "KEY_WINDOW_EXPIRED" });
  });
  it("uses the stored key_expires_at, not caps.keyRetentionMs", () => {
    const short = makeIntent("sim_payout", { key_expires_at: new Date("2026-11-14T18:00:03.000Z") });
    expect(decideRecovery(short, { kind: "NO_MATCH" }, caps, new Date("2026-11-14T18:00:02.999Z"), g)).toMatchObject({ row: 6 });
    expect(decideRecovery(short, { kind: "NO_MATCH" }, caps, new Date("2026-11-14T18:00:03.000Z"), g)).toMatchObject({ row: 7 });
  });
});

describe("decideRecovery: deduplication (rows 6, 7, 9)", () => {
  const g: RecoveryGuards = { obligationStatus: "OWED", obligationReason: null, grantFrozen: false };
  const now = new Date(EXPIRY.getTime() - 1);

  it("keyless rail (no dedupe) → NO_DEDUPE_NO_EVIDENCE, whatever the key window", () => {
    const k = makeIntent("sim_keyless");
    for (const t of [now, new Date(EXPIRY.getTime() + 1)]) {
      expect(decideRecovery(k, { kind: "NO_MATCH" }, DEDUPE["no dedupe"]!, t, g)).toMatchObject({ row: 9, reason: "NO_DEDUPE_NO_EVIDENCE" });
    }
  });
  it("a provider that dedupes but an intent with no idempotency key → NO_DEDUPE_NO_EVIDENCE (a same-key re-send needs a key)", () => {
    const noKey = makeIntent("sim_payout", { idempotency_key: null });
    expect(decideRecovery(noKey, { kind: "NO_MATCH" }, DEDUPE.dedupes!, now, g)).toMatchObject({ row: 9, reason: "NO_DEDUPE_NO_EVIDENCE" });
  });
  it("stripe_refund (dedupes) inside the window → L1", () => {
    expect(decideRecovery(makeIntent("stripe_refund"), { kind: "NO_MATCH" }, DEDUPE.dedupes!, now, g)).toMatchObject({ row: 6, kind: "REDISPATCH_SAME_KEY" });
  });
  it("does not mutate the intent, the match or the guards", () => {
    const it2 = deepFreeze(makeIntent("sim_payout")) as Intent;
    const m = deepFreeze({ kind: "NO_MATCH" } as EvidenceMatch);
    expect(() => decideRecovery(it2, m, deepFreeze({ ...DEDUPE.dedupes! }), now, deepFreeze({ ...g }))).not.toThrow();
  });
});
