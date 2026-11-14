// Deterministic fault schedule, per account. No randomness.
// An ordered list of { match: { account?, payee_ref?, marker?, ordinal? }, fault, times, ...args }.
// For each POST /v1/payouts the first entry with remaining > 0 whose every present match field equals the
// request is applied and its counter decremented. Outcome faults only apply to a request that would execute
// fresh and are not consumed by a replay (they are skipped); transport faults apply to any matching request.

export const FAULT_NAMES = [
  "DROP_RESPONSE_AFTER_APPLY",
  "DROP_REQUEST",
  "LATE_COMMIT_ON_RELEASE",
  "LATE_COMMIT_AFTER_MS",
  "REJECT",
  "IN_PROGRESS",
  "SERVER_ERROR_AFTER_APPLY",
  "HOLD_RESPONSE_MS",
] as const;
export type FaultName = (typeof FAULT_NAMES)[number];

const OUTCOME_FAULTS: ReadonlySet<string> = new Set(["REJECT", "LATE_COMMIT_ON_RELEASE", "LATE_COMMIT_AFTER_MS"]);

export type FaultMatch = { account?: string; payee_ref?: string; marker?: string; ordinal?: number };

export type FaultEntry = {
  match: FaultMatch;
  fault: FaultName;
  times: number;
  code?: string; // REJECT
  n?: number; // IN_PROGRESS
  ms?: number; // HOLD_RESPONSE_MS, LATE_COMMIT_AFTER_MS
  remaining: number;
};

export type RequestFacts = { account: string; payee_ref: string; marker: string | null; ordinal: number };

export function isOutcomeFault(f: FaultName): boolean {
  return OUTCOME_FAULTS.has(f);
}

function posInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

export function parseFaults(input: unknown): { ok: true; faults: FaultEntry[] } | { ok: false; message: string } {
  if (!Array.isArray(input)) return { ok: false, message: "faults must be an array" };
  const out: FaultEntry[] = [];
  for (let i = 0; i < input.length; i++) {
    const e = input[i] as Record<string, unknown> | null;
    const at = `faults[${i}]`;
    if (e === null || typeof e !== "object") return { ok: false, message: `${at} must be an object` };
    if (typeof e.fault !== "string" || !(FAULT_NAMES as readonly string[]).includes(e.fault)) {
      return { ok: false, message: `${at}.fault must be one of ${FAULT_NAMES.join(", ")}` };
    }
    const fault = e.fault as FaultName;
    const times = e.times === undefined ? 1 : e.times;
    if (!posInt(times)) return { ok: false, message: `${at}.times must be an integer >= 1` };
    const m = (e.match ?? {}) as Record<string, unknown>;
    if (m === null || typeof m !== "object" || Array.isArray(m)) return { ok: false, message: `${at}.match must be an object` };
    const match: FaultMatch = {};
    if (m.account !== undefined) {
      if (typeof m.account !== "string") return { ok: false, message: `${at}.match.account must be a string` };
      match.account = m.account;
    }
    if (m.payee_ref !== undefined) {
      if (typeof m.payee_ref !== "string") return { ok: false, message: `${at}.match.payee_ref must be a string` };
      match.payee_ref = m.payee_ref;
    }
    if (m.marker !== undefined) {
      if (typeof m.marker !== "string") return { ok: false, message: `${at}.match.marker must be a string` };
      match.marker = m.marker;
    }
    if (m.ordinal !== undefined) {
      if (!posInt(m.ordinal)) return { ok: false, message: `${at}.match.ordinal must be an integer >= 1` };
      match.ordinal = m.ordinal;
    }
    const entry: FaultEntry = { match, fault, times, remaining: times };
    if (fault === "REJECT") {
      if (typeof e.code !== "string" || e.code === "") return { ok: false, message: `${at}.code is required for REJECT` };
      entry.code = e.code;
    }
    if (fault === "IN_PROGRESS") {
      if (!posInt(e.n)) return { ok: false, message: `${at}.n must be an integer >= 1 for IN_PROGRESS` };
      entry.n = e.n;
      entry.remaining = e.n * times; // IN_PROGRESS(n) answers 409 n times; with times 1 that is exactly n
    }
    if (fault === "HOLD_RESPONSE_MS" || fault === "LATE_COMMIT_AFTER_MS") {
      if (!posInt(e.ms)) return { ok: false, message: `${at}.ms must be an integer >= 1 for ${fault}` };
      entry.ms = e.ms;
    }
    out.push(entry);
  }
  return { ok: true, faults: out };
}

function matches(entry: FaultEntry, f: RequestFacts): boolean {
  const m = entry.match;
  if (m.account !== undefined && m.account !== f.account) return false;
  if (m.payee_ref !== undefined && m.payee_ref !== f.payee_ref) return false;
  if (m.marker !== undefined && m.marker !== f.marker) return false;
  if (m.ordinal !== undefined && m.ordinal !== f.ordinal) return false;
  return true;
}

/** Find and consume the fault for this request, or null. `fresh` = the request would execute (no live key record). */
export function consumeFault(entries: FaultEntry[], facts: RequestFacts, fresh: boolean): FaultEntry | null {
  for (const e of entries) {
    if (e.remaining <= 0) continue;
    if (!matches(e, facts)) continue;
    if (!fresh && isOutcomeFault(e.fault)) continue; // not consumed by a replay
    e.remaining -= 1;
    return e;
  }
  return null;
}
