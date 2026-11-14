// Hand-written reader for the system's final report (HANDOVER §14, ARCHITECTURE §6.6). It never imports the
// system's Zod schema. Any shape violation throws ReportError and the CLI exits 2 (an error is never a pass).
import { GROUP_ID_RE, RUN_ID_RE } from "./effect-key.ts";

export class ReportError extends Error {}

export type PaidItem = { effect_key: string; marker: string; amount_minor: number; currency: string; payee_ref: string; provider: string; provider_object_id: string };
export type RefusedItem = { effect_key: string; reason_code: string; rule_citation: string };
export type ParkedItem = { effect_key: string | null; claim_id: string | null; reason_code: string; amount_minor: number | null };
export type AwaitingItem = { effect_key: string; amount_minor: number };
export type FailedItem = { effect_key: string; code: string };
export type UnresolvedItem = { effect_key: string; state: string };

export type FinalReport = {
  run_id: string; group_id: string; arm: string; scenario: string; generated_at: string; complete: boolean;
  paid: PaidItem[]; refused: RefusedItem[]; parked: ParkedItem[]; awaiting_budget: AwaitingItem[];
  failed_no_effect: FailedItem[]; unresolved: UnresolvedItem[];
};

export const REPORT_LISTS = ["paid", "refused", "parked", "awaiting_budget", "failed_no_effect", "unresolved"] as const;
export type ReportListName = (typeof REPORT_LISTS)[number];

const PROVIDERS: ReadonlySet<string> = new Set(["sim_payout", "sim_keyless", "stripe_refund"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function s(o: Record<string, unknown>, k: string, w: string): string {
  if (typeof o[k] !== "string" || (o[k] as string).length === 0) throw new ReportError(`report: ${w}.${k} must be a non-empty string`);
  return o[k] as string;
}
function sOrNull(o: Record<string, unknown>, k: string, w: string): string | null {
  if (!(k in o)) throw new ReportError(`report: ${w}.${k} is missing`);
  if (o[k] === null) return null;
  return s(o, k, w);
}
function minor(o: Record<string, unknown>, k: string, w: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new ReportError(`report: ${w}.${k} must be an integer >= 0`);
  return v;
}
function minorOrNull(o: Record<string, unknown>, k: string, w: string): number | null {
  if (!(k in o)) throw new ReportError(`report: ${w}.${k} is missing`);
  if (o[k] === null) return null;
  return minor(o, k, w);
}
function arr(o: Record<string, unknown>, k: string): Record<string, unknown>[] {
  const v = o[k];
  if (!Array.isArray(v)) throw new ReportError(`report: ${k} must be an array`);
  v.forEach((x, i) => { if (!isObj(x)) throw new ReportError(`report: ${k}[${i}] must be an object`); });
  return v as Record<string, unknown>[];
}

export function parseFinalReport(raw: unknown): FinalReport {
  if (!isObj(raw)) throw new ReportError("report: top level must be an object");
  const run_id = s(raw, "run_id", "$");
  if (!RUN_ID_RE.test(run_id)) throw new ReportError(`report: run_id ${JSON.stringify(run_id)} is not r + 7 base-36 characters`);
  if (!("group_id" in raw)) throw new ReportError("report: top-level group_id is missing");
  const group_id = s(raw, "group_id", "$");
  if (!GROUP_ID_RE.test(group_id)) throw new ReportError(`report: group_id ${JSON.stringify(group_id)} is not g + 7 base-36 characters`);
  const arm = s(raw, "arm", "$");
  const scenario = s(raw, "scenario", "$");
  if (scenario !== "S0" && scenario !== "S1") throw new ReportError("report: scenario must be S0 or S1");
  const generated_at = s(raw, "generated_at", "$");
  if (typeof raw.complete !== "boolean") throw new ReportError("report: complete must be a boolean");

  const paid = arr(raw, "paid").map((x, i): PaidItem => {
    const w = `paid[${i}]`;
    const currency = s(x, "currency", w);
    if (currency !== "CAD") throw new ReportError(`report: ${w}.currency must be CAD`);
    const provider = s(x, "provider", w);
    if (!PROVIDERS.has(provider)) throw new ReportError(`report: ${w}.provider ${JSON.stringify(provider)} is not known`);
    return { effect_key: s(x, "effect_key", w), marker: s(x, "marker", w), amount_minor: minor(x, "amount_minor", w), currency,
      payee_ref: s(x, "payee_ref", w), provider, provider_object_id: s(x, "provider_object_id", w) };
  });
  const refused = arr(raw, "refused").map((x, i): RefusedItem => {
    const w = `refused[${i}]`;
    return { effect_key: s(x, "effect_key", w), reason_code: s(x, "reason_code", w), rule_citation: s(x, "rule_citation", w) };
  });
  const parked = arr(raw, "parked").map((x, i): ParkedItem => {
    const w = `parked[${i}]`;
    const effect_key = sOrNull(x, "effect_key", w);
    const claim_id = sOrNull(x, "claim_id", w);
    if (effect_key === null && claim_id === null) throw new ReportError(`report: ${w} needs an effect_key or a claim_id`);
    return { effect_key, claim_id, reason_code: s(x, "reason_code", w), amount_minor: minorOrNull(x, "amount_minor", w) };
  });
  const awaiting_budget = arr(raw, "awaiting_budget").map((x, i): AwaitingItem => {
    const w = `awaiting_budget[${i}]`;
    return { effect_key: s(x, "effect_key", w), amount_minor: minor(x, "amount_minor", w) };
  });
  const failed_no_effect = arr(raw, "failed_no_effect").map((x, i): FailedItem => {
    const w = `failed_no_effect[${i}]`;
    return { effect_key: s(x, "effect_key", w), code: s(x, "code", w) };
  });
  const unresolved = arr(raw, "unresolved").map((x, i): UnresolvedItem => {
    const w = `unresolved[${i}]`;
    return { effect_key: s(x, "effect_key", w), state: s(x, "state", w) };
  });

  const report: FinalReport = { run_id, group_id, arm, scenario, generated_at, complete: raw.complete, paid, refused, parked, awaiting_budget, failed_no_effect, unresolved };

  // "Every claim and every obligation of the run appears in exactly one list" (HANDOVER §14).
  // An effect key in two different lists is a malformed report (exit 2). The same key twice inside `paid`
  // is allowed by the reader so that a report recording two provider objects is graded (check C1), not rejected.
  const where = new Map<string, ReportListName>();
  for (const list of REPORT_LISTS) {
    const seenHere = new Set<string>();
    for (const item of report[list] as { effect_key: string | null }[]) {
      const k = item.effect_key;
      if (k === null) continue;
      const prev = where.get(k);
      if (prev !== undefined && prev !== list) throw new ReportError(`report: effect_key ${k} appears in both ${prev} and ${list}`);
      if (seenHere.has(k) && list !== "paid") throw new ReportError(`report: effect_key ${k} appears twice in ${list}`);
      seenHere.add(k);
      where.set(k, list);
    }
  }
  const claimIds = new Set<string>();
  for (const p of report.parked) {
    if (p.effect_key === null && p.claim_id !== null) {
      if (claimIds.has(p.claim_id)) throw new ReportError(`report: claim ${p.claim_id} is parked twice`);
      claimIds.add(p.claim_id);
    }
  }
  return report;
}

/** The list that holds an effect key, or null. */
export function listOf(report: FinalReport, key: string): ReportListName | null {
  for (const list of REPORT_LISTS) {
    if ((report[list] as { effect_key: string | null }[]).some((i) => i.effect_key === key)) return list;
  }
  return null;
}
