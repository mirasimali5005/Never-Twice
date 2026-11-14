// The final report (HANDOVER.md §14, AGENT_TASKS.md E field 12): derived from MongoDB state alone, never from a provider, never edited.
// Every obligation and every claim of the run appears in exactly one list. An obligation with an intent is classified by the intent;
// an obligation without one by its adjudication. `complete` is true only when `unresolved` is empty and every claim has been adjudicated.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FinalReport, RELEASED_BEFORE_SEND, type Intent, type Obligation } from "@nt/contracts";
import { dbNow, type NtDb } from "@nt/db";

type Db = Pick<NtDb, "runs" | "claims" | "obligations" | "intents" | "audit">;

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

const byKey = <T>(key: (x: T) => string) => (a: T, b: T): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** Pure derivation, so the mapping can be unit-tested without a database. */
export function deriveReport(input: {
  run: { _id: string; group_id: string; arm: FinalReport["arm"]; scenario: FinalReport["scenario"] };
  claims: { claim_id: string; status: string; hold_reason: string | null; effect_keys: string[] }[];
  obligations: Obligation[];
  intents: Intent[];
  budgetRefusedKeys: ReadonlySet<string>;
  generatedAt: string;
}): FinalReport {
  const { run, claims, obligations, intents, budgetRefusedKeys } = input;
  const paid: FinalReport["paid"] = [];
  const refused: FinalReport["refused"] = [];
  const parked: FinalReport["parked"] = [];
  const awaiting_budget: FinalReport["awaiting_budget"] = [];
  const failed_no_effect: FinalReport["failed_no_effect"] = [];
  const unresolved: FinalReport["unresolved"] = [];

  const intentKeys = new Set<string>();
  for (const it of intents) {
    intentKeys.add(it.effect_key);
    switch (it.state) {
      case "CONFIRMED":
        if (it.evidence === null) unresolved.push({ effect_key: it.effect_key, state: "CONFIRMED_WITHOUT_EVIDENCE" });
        else
          paid.push({
            effect_key: it.effect_key,
            marker: it._id,
            amount_minor: it.amount_minor,
            currency: it.currency,
            payee_ref: it.payee_ref,
            provider: it.provider,
            provider_object_id: it.evidence.provider_object_id,
          });
        break;
      case "FAILED_NO_EFFECT":
        failed_no_effect.push({ effect_key: it.effect_key, code: it.rejection?.code ?? "UNKNOWN" });
        break;
      case "RELEASED":
        failed_no_effect.push({ effect_key: it.effect_key, code: RELEASED_BEFORE_SEND });
        break;
      case "QUARANTINED":
        if (it.quarantine === null) unresolved.push({ effect_key: it.effect_key, state: "QUARANTINED_WITHOUT_REASON" });
        else parked.push({ effect_key: it.effect_key, claim_id: null, reason_code: it.quarantine.reason, amount_minor: it.amount_minor });
        break;
      default:
        unresolved.push({ effect_key: it.effect_key, state: it.state });
    }
  }

  for (const ob of obligations) {
    if (intentKeys.has(ob.effect_key)) continue;
    if (ob.status === "NOT_OWED") {
      refused.push({ effect_key: ob.effect_key, reason_code: ob.reason_code as FinalReport["refused"][number]["reason_code"], rule_citation: ob.rule_citation });
    } else if (ob.status === "HELD") {
      parked.push({ effect_key: ob.effect_key, claim_id: null, reason_code: ob.reason_code as FinalReport["parked"][number]["reason_code"], amount_minor: null });
    } else if (ob.entitlement_type === "GOODWILL" && budgetRefusedKeys.has(ob.effect_key)) {
      awaiting_budget.push({ effect_key: ob.effect_key, amount_minor: ob.amount_minor });
    } else {
      unresolved.push({ effect_key: ob.effect_key, state: "NO_INTENT" });
    }
  }

  let allAdjudicated = true;
  for (const c of claims) {
    if (c.status === "HELD") {
      parked.push({ effect_key: null, claim_id: c.claim_id, reason_code: c.hold_reason as FinalReport["parked"][number]["reason_code"], amount_minor: null });
    } else if (c.status !== "RESOLVED" || c.effect_keys.length === 0) {
      allAdjudicated = false; // RECEIVED, EXTRACTED, or RESOLVED with no obligation yet: not adjudicated, so the report cannot be complete
    }
  }

  paid.sort(byKey((x) => x.effect_key));
  refused.sort(byKey((x) => x.effect_key));
  parked.sort(byKey((x) => x.effect_key ?? x.claim_id ?? ""));
  awaiting_budget.sort(byKey((x) => x.effect_key));
  failed_no_effect.sort(byKey((x) => x.effect_key));
  unresolved.sort(byKey((x) => x.effect_key));

  return FinalReport.parse({
    run_id: run._id,
    group_id: run.group_id,
    arm: run.arm,
    scenario: run.scenario,
    generated_at: input.generatedAt,
    complete: unresolved.length === 0 && allAdjudicated,
    paid,
    refused,
    parked,
    awaiting_budget,
    failed_no_effect,
    unresolved,
  });
}

/** Reads the run's state (majority-consistent enough for a report: every writer uses majority) and derives the report. Writes nothing. */
export async function buildFinalReport(db: Db & Pick<NtDb, "db">, runId: string, opts: { now?: Date } = {}): Promise<FinalReport> {
  const run = await db.runs.findOne({ _id: runId });
  if (!run) throw new ReportError(`no execution_runs document for ${runId}`);
  const [claims, obligations, intents, budget] = await Promise.all([
    db.claims.find({ run_id: runId }).toArray(),
    db.obligations.find({ run_id: runId }).toArray(),
    db.intents.find({ run_id: runId }).toArray(),
    db.audit.find({ run_id: runId, type: "BUDGET_REFUSED" }).toArray(),
  ]);
  const generatedAt = (opts.now ?? (await dbNow(db, runId))).toISOString();
  return deriveReport({
    run,
    claims,
    obligations,
    intents,
    budgetRefusedKeys: new Set(budget.flatMap((e) => (e.effect_key ? [e.effect_key] : []))),
    generatedAt,
  });
}

export function reportPath(outDir: string, runId: string): string {
  return join(outDir, `${runId}.final-report.json`);
}

/** Temporary file then rename, so a reader never sees a half-written report. Returns the path. */
export function writeReportFile(outDir: string, report: FinalReport): string {
  const path = reportPath(outDir, report.run_id);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return path;
}

/** `--report-only`: rewrites the report file and execution_runs.final_report from current state. Touches nothing else (status stays as it is). */
export async function rewriteReport(db: Db & Pick<NtDb, "db">, runId: string, outDir: string): Promise<FinalReport> {
  const report = await buildFinalReport(db, runId);
  writeReportFile(outDir, report);
  await db.runs.updateOne({ _id: runId }, { $set: { final_report: report } });
  return report;
}
