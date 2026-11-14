// Mock desk API: serves the JSON files in this folder (ARCHITECTURE.md section 9 shapes) and plays a demo progression over time,
// so the screen can be rehearsed with no backend. Nothing here is a second source of truth: every response body is a file in this
// folder, trimmed or selected by the elapsed time. Enabled by VITE_MOCK=1 or ?mock=1 (api.ts).
//
// Timeline (seconds after load; ?speed=2 doubles it, ?t=25 starts at second 25, key "r" restarts):
//   <0  paused before payout (default start is -8 s): no payments yet, the case file is on screen
//    0  three amber: P11 and P13 OUTCOME_UNKNOWN, P02 DISPATCHING (the kill has happened); control: P02 paid once so far
//    6  both arms restart: control pays P02 a second time (paid twice); the nt runner pays P03's two payments (confirmed)
//   10  P02 green by evidence (receipt found, nothing re-sent)
//   18  licence L1 recorded for P13        20  P13 green after the identical same-key re-send
//   30  P11 grey-blue: would not guess      40  the auditor's certificates exist
//   55  only with ?late=1: demo:late-commit lands; control P11 paid twice; nt P11 grey-blue to green (Tier 2 watcher)
import type {
  AnyTrail,
  Certificate,
  ClaimCase,
  ClaimRow,
  GroupView,
  IntentState,
  PaymentRow,
  PaymentTrail,
  Pool,
  ProviderStatement,
  RunSummary,
  StatementObject,
  StreamEvent,
} from "../types";

const files = import.meta.glob("./*.json", { eager: true, import: "default" }) as Record<string, unknown>;
function file<T>(name: string): T | undefined {
  return files[`./${name}`] as T | undefined;
}

export const T = { restart: 6, p02: 10, licence: 18, p13: 20, p11: 30, audit: 40, late: 55 } as const;
const NT = "r7k2m9qa";
const CONTROL = "r3c9v5tb";
const MUTANT = "r5h1w8ze";
const K = {
  P02: "ZT4H9X.P02.NT101-20261110.APPR_DELAY",
  P13: "KS2R9B.P13.NT880-20261110.APPR_DELAY",
  P11: "PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING",
  P03c: "LM2P8D.P03.NT101-20261110.APPR_REFUND_COMP",
  P03t: "LM2P8D.P03.NT101-20261110.TICKET_REFUND",
};

type Opts = { speed: number; t0: number; late: boolean; scenario: "S0" | "S1"; forceCertificates: boolean };
function readOpts(): Opts {
  const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const num = (k: string, d: number) => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) ? v : d;
  };
  return {
    speed: Math.max(0.1, num("speed", 1)),
    t0: num("t", -8), // negative: the run is paused before payout, so the case file is on screen first
    late: q.get("late") === "1",
    scenario: q.get("scenario") === "S1" ? "S1" : "S0",
    forceCertificates: q.has("arm"), // ?arm=nt_mutant must show a certificate straight away
  };
}

let opts = readOpts();
let startedAt = Date.now();
export function mockElapsed(): number {
  return opts.t0 + ((Date.now() - startedAt) / 1000) * opts.speed;
}
export function restartMock(): void {
  startedAt = Date.now();
  opts = readOpts();
  lastEmitted = -1;
}

// ---------- state at time t ----------
function ntState(key: string, t: number): IntentState | null {
  if (t < 0) return null;
  switch (key) {
    case K.P02: return t >= T.p02 ? "CONFIRMED" : "DISPATCHING";
    case K.P13: return t >= T.p13 ? "CONFIRMED" : "OUTCOME_UNKNOWN";
    case K.P11: return opts.late && t >= T.late ? "CONFIRMED" : t >= T.p11 ? "QUARANTINED" : "OUTCOME_UNKNOWN";
    case K.P03c:
    case K.P03t: return t >= T.restart ? "CONFIRMED" : null; // not paid yet: no intent
    default: return null;
  }
}
const colourOf = (s: IntentState | null) => (s === "CONFIRMED" ? "confirmed" : s === "QUARANTINED" ? "needs_person" : s ? "in_doubt" : null);

function paymentsFor(run: string, t: number): PaymentRow[] | null {
  if (run === NT) {
    const base = file<PaymentRow[]>("payments.nt.json") ?? [];
    return base.flatMap((r) => {
      const s = ntState(r.effect_key, t);
      if (s === null) return [];
      return [{ ...r, state: s, colour: colourOf(s), quarantine_reason: s === "QUARANTINED" ? "NO_DEDUPE_NO_EVIDENCE" : null }];
    });
  }
  if (run === CONTROL) {
    if (t < 0) return [];
    const base = file<PaymentRow[]>("payments.control.json") ?? [];
    return base.filter((r) => (r.effect_key === K.P03c || r.effect_key === K.P03t ? t >= T.restart : true));
  }
  if (run === MUTANT) return [];
  return null;
}

function obj(o: unknown): StatementObject {
  return o as StatementObject;
}
function statementFor(run: string, t: number): ProviderStatement | null {
  const readAt = new Date().toISOString();
  const extras = file<{ late_commit: { control_object: StatementObject; nt_object: StatementObject } }>("mock-extras.json")?.late_commit;
  const lateLanded = opts.late && t >= T.late;
  if (run === NT) {
    const base = file<ProviderStatement>("provider-statement.nt.json");
    if (!base) return null;
    let ents = base.entitlements
      .filter((e) => (e.effect_key === K.P13 ? t >= T.p13 : e.effect_key === K.P03c ? t >= T.restart : true))
      .map((e) => ({ ...e }));
    if (lateLanded && extras) ents = [{ effect_key: K.P11, count: 1, amount_minor_total: 90000, objects: [obj(extras.nt_object)] }, ...ents];
    if (t < 0) return { ...base, read_at: readAt, entitlements: [], paid_twice: 0 };
    return { ...base, read_at: readAt, entitlements: ents, paid_twice: ents.filter((e) => e.count >= 2).length };
  }
  if (run === CONTROL) {
    const base = file<ProviderStatement>("provider-statement.control.json");
    if (!base) return null;
    const ents = base.entitlements
      .filter((e) => (e.effect_key === K.P03c ? t >= T.restart : true))
      .map((e) => {
        if (e.effect_key === K.P02 && t < T.restart) return { ...e, count: 1, amount_minor_total: 70000, objects: e.objects.slice(0, 1) };
        if (e.effect_key === K.P11 && lateLanded && extras)
          return { ...e, count: 2, amount_minor_total: 180000, objects: [...e.objects, obj(extras.control_object)] };
        return { ...e };
      });
    if (t < 0) return { ...base, read_at: readAt, entitlements: [], paid_twice: 0 };
    return { ...base, read_at: readAt, entitlements: ents, paid_twice: ents.filter((e) => e.count >= 2).length };
  }
  if (run === MUTANT) {
    return { run_id: MUTANT, account: `acct_${MUTANT}`, read_at: readAt, complete: true, entitlements: [], unattributed: [], paid_twice: 0 };
  }
  return null;
}

function summaryFor(run: string, t: number): RunSummary | null {
  const f = file<RunSummary>(`summary.${run === NT ? "nt" : run === CONTROL ? "control" : "nt_mutant"}.json`);
  if (!f || ![NT, CONTROL, MUTANT].includes(run)) return null;
  const audited = t >= T.audit;
  const paused = t < 0;
  const status = audited ? "ENDED" : paused ? "PAUSED" : "RUNNING";
  if (run === NT) {
    const rows = paymentsFor(NT, t) ?? [];
    const by = { RESERVED: 0, DISPATCHING: 0, OUTCOME_UNKNOWN: 0, CONFIRMED: 0, FAILED_NO_EFFECT: 0, QUARANTINED: 0, RELEASED: 0 } as Record<IntentState, number>;
    for (const r of rows) if (r.state) by[r.state]++;
    return {
      ...f,
      status,
      intents_by_state: by,
      colours: { in_doubt: by.DISPATCHING + by.OUTCOME_UNKNOWN, confirmed: by.CONFIRMED, needs_person: by.QUARANTINED },
      complete: audited ? true : null,
      report_generated_at: audited ? f.report_generated_at : null,
    };
  }
  return { ...f, status: run === MUTANT ? "ENDED" : status, complete: audited ? f.complete : null, report_generated_at: audited ? f.report_generated_at : null };
}

function certFor(run: string, t: number): Certificate | "NOT_AUDITED" | null {
  const arm = run === NT ? "nt" : run === CONTROL ? "control" : run === MUTANT ? "nt_mutant" : null;
  if (!arm) return null;
  if (t < T.audit && !opts.forceCertificates) return "NOT_AUDITED";
  return file<Certificate>(`certificate.${arm}.json`) ?? null;
}

// ---------- the fetch ----------
export type MockResponse = { status: number; body: unknown };
const ok = (body: unknown): MockResponse => ({ status: 200, body });
const nf = (error: string): MockResponse => ({ status: 404, body: { error } });

export function mockGet(rawPath: string): MockResponse {
  const t = mockElapsed();
  const path = rawPath.split("?")[0];
  const s1 = opts.scenario === "S1";
  let m: RegExpMatchArray | null;

  if ((m = path.match(/^\/api\/groups\/([^/]+)$/))) {
    const g = file<GroupView>("group.json");
    if (!g || m[1] !== g.group_id) return nf("UNKNOWN_GROUP");
    return ok({ ...g, scenario: opts.scenario, runs: g.runs.map((r) => (r.arm === "nt_mutant" ? r : { ...r, status: t >= T.audit ? "ENDED" : "RUNNING" })) });
  }
  if (!(m = path.match(/^\/api\/runs\/([^/]+)\/(.+)$/))) return nf("UNKNOWN_RUN");
  const run = m[1];
  const rest = m[2];
  if (![NT, CONTROL, MUTANT].includes(run)) return nf("UNKNOWN_RUN");
  const armKey = run === CONTROL ? "control" : "nt";

  if (rest === "summary") return ok(summaryFor(run, t));
  if (rest === "claims") return ok(file<ClaimRow[]>(`claims.${armKey}${s1 ? ".S1" : ""}.json`) ?? file<ClaimRow[]>(`claims.${armKey}.json`) ?? []);
  if ((m = rest.match(/^claims\/(.+)$/))) {
    const c = file<ClaimCase>(`claim.${armKey}${s1 ? ".S1" : ""}.json`) ?? file<ClaimCase>(`claim.${armKey}.json`);
    return c && c.claim_id === m[1] ? ok(c) : nf("UNKNOWN_CLAIM");
  }
  if (rest === "payments") return ok(paymentsFor(run, t));
  if ((m = rest.match(/^payments\/(.+)$/))) {
    const key = decodeURIComponent(m[1]);
    if (run === CONTROL) {
      const phase = key === K.P02 && t < T.restart ? "NOT_MARKED_DONE" : "MARKED_DONE";
      const trail = file<AnyTrail>(`payment.control.${key}.${phase}.json`);
      const visible = (paymentsFor(CONTROL, t) ?? []).some((r) => r.effect_key === key);
      return trail && visible ? ok(trail) : nf("UNKNOWN_PAYMENT");
    }
    const state = ntState(key, t);
    const trail = state ? file<PaymentTrail>(`payment.nt.${key}.${state}.json`) : undefined;
    if (!trail) return nf("UNKNOWN_PAYMENT");
    // the lease-expiry takeover has not happened yet at second 0; the trail file for DISPATCHING already shows the held lease
    return ok(trail);
  }
  if (rest === "provider-statement") return ok(statementFor(run, t));
  if (rest === "pool") return ok(file<Pool>("pool.json"));
  if (rest === "certificate") {
    const c = certFor(run, t);
    if (c === "NOT_AUDITED") return { status: 404, body: { status: "NOT_AUDITED" } };
    return c ? ok(c) : nf("UNKNOWN_RUN");
  }
  return nf("UNKNOWN_RUN");
}

// ---------- the event stream ----------
type Milestone = { at: number; ev: Omit<StreamEvent, "_id" | "at"> };
const tr = (key: string, from: IntentState | null, to: IntentState, transition: string): Milestone["ev"] => ({
  type: "TRANSITION", actor: "reconciler", intent_id: `${NT}:${key}`, effect_key: key, claim_id: null, from_state: from, to_state: to, transition,
});
function milestones(): Milestone[] {
  const list: Milestone[] = [
    { at: 0.01, ev: tr(K.P02, "RESERVED", "DISPATCHING", "T2") }, // demo:go: payouts begin, the kill leaves three payments in doubt
    { at: T.restart, ev: tr(K.P03c, "DISPATCHING", "CONFIRMED", "T3") },
    { at: T.restart, ev: tr(K.P03t, "DISPATCHING", "CONFIRMED", "T3") },
    { at: T.p02, ev: tr(K.P02, "OUTCOME_UNKNOWN", "CONFIRMED", "T6") },
    { at: T.licence, ev: { type: "LICENCE_GRANTED", actor: "reconciler", intent_id: `${NT}:${K.P13}`, effect_key: K.P13, claim_id: null, from_state: null, to_state: null } },
    { at: T.p13, ev: tr(K.P13, "OUTCOME_UNKNOWN", "CONFIRMED", "T6") },
    { at: T.p11, ev: tr(K.P11, "OUTCOME_UNKNOWN", "QUARANTINED", "T9") },
  ];
  if (opts.late) list.push({ at: T.late, ev: tr(K.P11, "QUARANTINED", "CONFIRMED", "T12") });
  return list;
}
let lastEmitted = -1;
let counter = 0;
const hex = (n: number) => n.toString(16).padStart(24, "0");

/** Emits audit events (signals to refetch) for the nt run as the timeline passes; the control run writes none. */
export function mockSubscribe(runId: string, onEvent: (e: StreamEvent) => void): () => void {
  if (runId !== NT) return () => {};
  lastEmitted = mockElapsed();
  const timer = setInterval(() => {
    const now = mockElapsed();
    if (now < lastEmitted) lastEmitted = now; // restarted
    for (const m of milestones()) {
      if (m.at > lastEmitted && m.at <= now) onEvent({ _id: hex(++counter), at: new Date().toISOString(), ...m.ev });
    }
    lastEmitted = now;
  }, 250);
  return () => clearInterval(timer);
}
