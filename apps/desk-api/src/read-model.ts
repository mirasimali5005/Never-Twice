// Read model of the desk API: shapes the stored documents into the wire shapes of ARCHITECTURE.md section 9.
// Everything here reads. The collection handles it receives are typed `find | findOne | countDocuments` only, so a write
// method is not even expressible; test/read-only.test.ts asserts it again at run time.
import type { Collection } from "mongodb";
import type { NtCollections } from "@nt/db";
import type { ProviderStatement, StatementObject } from "./provider-statement.ts";

type ReadOnly<C extends Collection<any>> = Pick<C, "find" | "findOne" | "countDocuments">; // eslint-disable-line @typescript-eslint/no-explicit-any
export type DeskCollections = {
  bookings: ReadOnly<NtCollections["bookings"]>;
  claims: ReadOnly<NtCollections["claims"]>;
  obligations: ReadOnly<NtCollections["obligations"]>;
  intents: ReadOnly<NtCollections["intents"]>;
  grants: ReadOnly<NtCollections["grants"]>;
  audit: ReadOnly<NtCollections["audit"]>;
  runs: ReadOnly<NtCollections["runs"]>;
  investigations: ReadOnly<NtCollections["investigations"]>;
};
export const READ_ONLY_METHODS = ["find", "findOne", "countDocuments"] as const;

export const BASELINE_ARMS: ReadonlySet<string> = new Set(["control", "documented"]);
const ZERO_STATES = { RESERVED: 0, DISPATCHING: 0, OUTCOME_UNKNOWN: 0, CONFIRMED: 0, FAILED_NO_EFFECT: 0, QUARANTINED: 0, RELEASED: 0 };
type StateCounts = typeof ZERO_STATES;

const iso = (d: Date | null | undefined): string | null => (d instanceof Date ? d.toISOString() : null);
const colourOf = (s: string | null, reversed = false): "in_doubt" | "confirmed" | "needs_person" | "reversed" | null =>
  s === "CONFIRMED" ? (reversed ? "reversed" : "confirmed") : s === "DISPATCHING" || s === "OUTCOME_UNKNOWN" ? "in_doubt" : s === "QUARANTINED" ? "needs_person" : null;

/** Tier 3 (CP-REV-1): CONFIRMED intents the provider later reversed (one PROVIDER_REVERSAL audit event each), by intent id. */
async function reversalsOf(c: DeskCollections, runId: string): Promise<Map<string, { status_now: string | null; provider_object_id: string | null; at: Date }>> {
  const evs = await c.audit.find({ run_id: runId, type: "PROVIDER_REVERSAL" }).toArray();
  const out = new Map<string, { status_now: string | null; provider_object_id: string | null; at: Date }>();
  for (const e of evs) {
    if (!e.intent_id) continue;
    const d = (e.detail ?? {}) as Record<string, unknown>;
    out.set(e.intent_id, { status_now: typeof d.status_now === "string" ? d.status_now : null, provider_object_id: typeof d.provider_object_id === "string" ? d.provider_object_id : null, at: e.at });
  }
  return out;
}
const passengerOf = (effectKey: string): string => effectKey.split(".")[1] ?? "";
const entitlementOf = (effectKey: string): string => effectKey.split(".")[3] ?? "";

export type RunRow = {
  _id: string;
  group_id: string;
  arm: string;
  scenario: "S0" | "S1";
  fault_schedule: string;
  sim_account: string;
  status: string;
  final_report: {
    complete: boolean;
    generated_at: string;
    awaiting_budget: { effect_key: string }[];
  } | null;
};

export async function getRun(c: DeskCollections, runId: string): Promise<RunRow | null> {
  const r = await c.runs.findOne({ _id: runId });
  return r as unknown as RunRow | null;
}

// ---- GET /api/groups/:group_id ------------------------------------------------------------------------------------
export async function groupView(c: DeskCollections, groupId: string, recorded: boolean) {
  const runs = (await c.runs.find({ group_id: groupId }).sort({ _id: 1 }).toArray()) as unknown as RunRow[];
  if (runs.length === 0) return null;
  // intake mode of the group: the mode stamped on the first extraction that carries one (all arms replay the same cassettes)
  let intake_mode: "live" | "record" | "replay" | undefined;
  for (const r of runs) {
    const withMeta = await c.claims.findOne({ run_id: r._id, extraction_meta: { $ne: null } }, { projection: { extraction_meta: 1 } });
    const mode = withMeta?.extraction_meta?.mode;
    if (mode) {
      intake_mode = mode;
      break;
    }
  }
  return {
    group_id: groupId,
    scenario: runs[0]!.scenario,
    recorded,
    runs: runs.map((r) => ({ run_id: r._id, arm: r.arm, status: r.status, sim_account: r.sim_account, fault_schedule: r.fault_schedule })),
    ...(intake_mode ? { intake_mode } : {}),
  };
}

// ---- GET /api/runs/:run_id/summary --------------------------------------------------------------------------------
export async function runSummary(c: DeskCollections, run: RunRow) {
  const intents = await c.intents.find({ run_id: run._id }, { projection: { state: 1 } }).toArray();
  const by: StateCounts = { ...ZERO_STATES };
  for (const i of intents) if (i.state in by) by[i.state as keyof StateCounts] += 1;
  const reversed = (await reversalsOf(c, run._id)).size;
  const heldObligations = await c.obligations.countDocuments({ run_id: run._id, status: "HELD" });
  const heldClaims = await c.claims.countDocuments({ run_id: run._id, status: "HELD" });
  const report = run.final_report;
  return {
    run_id: run._id,
    group_id: run.group_id,
    arm: run.arm,
    scenario: run.scenario,
    status: run.status,
    intents_by_state: by,
    colours: {
      in_doubt: by.DISPATCHING + by.OUTCOME_UNKNOWN,
      confirmed: by.CONFIRMED - reversed, // a confirmed payment the provider later reversed is not counted as confirmed
      needs_person: by.QUARANTINED + heldObligations + heldClaims + reversed,
      ...(reversed > 0 ? { reversed } : {}), // CP-REV-1: "Reversed at provider — needs a person"; key present only when non-zero
    },
    complete: report ? report.complete : null,
    report_generated_at: report ? report.generated_at : null,
  };
}

// ---- claims -------------------------------------------------------------------------------------------------------
export async function claimRows(c: DeskCollections, runId: string) {
  const claims = await c.claims.find({ run_id: runId }).sort({ received_at: 1, claim_id: 1 }).toArray();
  return claims.map((k) => ({
    claim_id: k.claim_id,
    channel: k.channel,
    received_at: iso(k.received_at),
    status: k.status,
    hold_reason: k.hold_reason,
    effect_keys: k.effect_keys,
  }));
}

export async function claimCase(c: DeskCollections, runId: string, claimId: string) {
  const k = await c.claims.findOne({ _id: `${runId}:${claimId}` });
  if (!k) return null;
  const record_facts: { flight_no: string; cause_code: string; control_class: string; arrival_delay_minutes: number | null }[] = [];
  if (k.resolution) {
    const bookings = await c.bookings
      .find({ run_id: runId, booking_ref: k.resolution.booking_ref, passenger_id: { $in: k.resolution.passenger_ids } })
      .sort({ passenger_id: 1 })
      .toArray();
    const seen = new Set<string>();
    for (const b of bookings) {
      const fact = {
        flight_no: b.flight_no,
        cause_code: b.disruption.cause_code,
        control_class: b.disruption.control_class,
        arrival_delay_minutes: b.passenger.arrival_delay_minutes,
      };
      const id = JSON.stringify(fact);
      if (!seen.has(id)) {
        seen.add(id);
        record_facts.push(fact);
      }
    }
  }
  const obls = await c.obligations.find({ run_id: runId, claim_ids: claimId }).sort({ decided_at: 1, _id: 1 }).toArray();
  const merged = new Set<string>();
  for (const o of obls) for (const id of o.claim_ids) if (id !== claimId) merged.add(id);
  return {
    claim_id: k.claim_id,
    channel: k.channel,
    received_at: iso(k.received_at),
    raw_text: k.raw_text,
    status: k.status,
    hold_reason: k.hold_reason,
    extraction: k.extraction,
    extraction_meta: k.extraction_meta
      ? { mode: k.extraction_meta.mode, prompt_version: k.extraction_meta.prompt_version, attempts: k.extraction_meta.attempts }
      : null,
    resolution: k.resolution,
    record_facts,
    obligations: obls.map((o) => ({
      effect_key: o.effect_key,
      entitlement_type: o.entitlement_type,
      status: o.status,
      amount_minor: o.amount_minor,
      currency: o.currency,
      reason_code: o.reason_code,
      rule_citation: o.rule_citation,
      policy_version: o.policy_version,
      claim_ids: o.claim_ids,
      due_by: iso(o.due_by),
    })),
    merged_claims: [...merged].sort(),
  };
}

// ---- baseline bookkeeping (claims.baseline, written by the baseline arms; ARCHITECTURE section 9 + AGENT_TASKS E5) --------
type BaselinePayment = {
  effect_key: string;
  amount_minor: number | null;
  currency: string;
  payee_ref: string;
  provider: string;
  provider_object_id: string | null;
  idempotency_key: string | null;
  at: string | null;
  result: string | null;
};
type BaselineClaim = { claim_id: string; effect_keys: string[]; done: boolean; done_at: string | null; updated_at: string | null; payments: BaselinePayment[] };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const when = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : str(v));

async function baselineClaims(c: DeskCollections, runId: string): Promise<BaselineClaim[]> {
  const claims = await c.claims.find({ run_id: runId }).sort({ received_at: 1, claim_id: 1 }).toArray();
  const out: BaselineClaim[] = [];
  for (const k of claims) {
    const b = (k as unknown as { baseline?: Record<string, unknown> }).baseline;
    if (!b || typeof b !== "object") continue;
    const rawPayments = Array.isArray(b["payments"]) ? (b["payments"] as Record<string, unknown>[]) : [];
    out.push({
      claim_id: k.claim_id,
      effect_keys: k.effect_keys,
      done: b["done"] === true,
      done_at: when(b["done_at"]),
      updated_at: iso(k.updated_at),
      payments: rawPayments
        .filter((p) => typeof p["effect_key"] === "string")
        .map((p) => ({
          effect_key: p["effect_key"] as string,
          amount_minor: typeof p["amount_minor"] === "number" ? p["amount_minor"] : null,
          currency: str(p["currency"]) ?? "CAD",
          payee_ref: str(p["payee_ref"]) ?? "",
          provider: str(p["provider"]) ?? "",
          provider_object_id: str(p["provider_object_id"]),
          idempotency_key: str(p["idempotency_key"]),
          at: when(p["at"]),
          result: typeof p["result"] === "string" ? p["result"] : p["result"] !== undefined && p["result"] !== null ? JSON.stringify(p["result"]) : null,
        })),
    });
  }
  return out;
}

const railOfProvider = (provider: string): "instant" | "legacy" => (provider === "sim_keyless" ? "legacy" : "instant");

// ---- GET /api/runs/:run_id/payments ---------------------------------------------------------------------------------
export async function paymentRows(c: DeskCollections, run: RunRow) {
  if (BASELINE_ARMS.has(run.arm)) {
    const rows = new Map<string, ReturnType<typeof baselineRow>>();
    for (const bc of await baselineClaims(c, run._id)) for (const p of bc.payments) rows.set(p.effect_key, baselineRow(p));
    return [...rows.values()];
  }
  const intents = await c.intents.find({ run_id: run._id }).sort({ created_at: 1, _id: 1 }).toArray();
  const obls = await c.obligations.find({ run_id: run._id }, { projection: { rail: 1, effect_key: 1 } }).toArray();
  const railOf = new Map(obls.map((o) => [o._id, o.rail] as const));
  const rev = await reversalsOf(c, run._id);
  return intents.map((i) => ({
    effect_key: i.effect_key,
    passenger_id: passengerOf(i.effect_key),
    entitlement_type: i.entitlement_type,
    amount_minor: i.amount_minor,
    rail: railOf.get(i.obligation_id) ?? i.frozen_request.rail ?? null,
    provider: i.provider,
    state: i.state,
    colour: colourOf(i.state, rev.has(i._id)),
    quarantine_reason: i.quarantine?.reason ?? null,
    ...(i.state === "CONFIRMED" && rev.has(i._id) ? { reversed_at_provider: true as const } : {}), // CP-REV-1; absent otherwise
    source: "nt" as const,
  }));
}

function baselineRow(p: BaselinePayment) {
  return {
    effect_key: p.effect_key,
    passenger_id: passengerOf(p.effect_key),
    entitlement_type: entitlementOf(p.effect_key),
    amount_minor: p.amount_minor ?? 0,
    rail: railOfProvider(p.provider),
    provider: p.provider,
    state: null,
    colour: null,
    quarantine_reason: null, // a baseline's reversal shows from the provider statement (objects with a reversal status)
    source: "baseline" as const,
  };
}

// ---- GET /api/runs/:run_id/payments/:effect_key (Never Twice arms) -----------------------------------------------------
export async function paymentTrail(c: DeskCollections, run: RunRow, effectKey: string) {
  const marker = `${run._id}:${effectKey}`;
  const intent = await c.intents.findOne({ _id: marker });
  if (!intent) return null;
  const obligation = await c.obligations.findOne({ _id: intent.obligation_id });
  const investigations = await c.investigations
    .find({ run_id: run._id, intent_id: marker }, { projection: { embedding: 0 } })
    .sort({ _id: 1 })
    .toArray();
  const audit = await c.audit
    .find({ run_id: run._id, $or: [{ intent_id: marker }, { effect_key: effectKey, type: "OBLIGATION_DECIDED" }] })
    .sort({ _id: 1 })
    .toArray();
  const reversal = intent.state === "CONFIRMED" ? ((await reversalsOf(c, run._id)).get(marker) ?? null) : null;
  return { intent, obligation, investigations, audit, ...(reversal ? { reversal } : {}) }; // CP-REV-1: reversal only when recorded
}

// ---- GET /api/runs/:run_id/payments/:effect_key (baseline arms): the `BaselineTrail` addition --------------------------------
const BASELINE_NOTES: Record<string, string> = {
  control: "a 2xx is treated as paid",
  documented: "one stable key per entitlement, retried up to three times; a 2xx is treated as paid",
};

/** Built from the baseline's own bookkeeping (claims.baseline), the run's audit events for the effect key (when they carry an
 *  idempotency key) and the provider statement (objects the baseline's own record does not show, so a payment applied before
 *  the process stopped still appears). `statement` is null when the provider could not be read; the trail is then built without it. */
export async function baselineTrail(c: DeskCollections, run: RunRow, effectKey: string, statement: ProviderStatement | null) {
  const claims = await baselineClaims(c, run._id);
  const owner = claims.find((k) => k.payments.some((p) => p.effect_key === effectKey) || k.effect_keys.includes(effectKey));
  const entries = owner ? owner.payments.filter((p) => p.effect_key === effectKey) : [];
  const objects: StatementObject[] = statement?.entitlements.find((e) => e.effect_key === effectKey)?.objects ?? [];
  if (!owner && objects.length === 0) return null;

  const events = await c.audit.find({ run_id: run._id, effect_key: effectKey }).sort({ _id: 1 }).toArray();
  const keyed = events.flatMap((e) => {
    const d = e.detail as Record<string, unknown>;
    const key = str(d["idempotency_key"]);
    return key ? [{ key, at: e.at.toISOString(), result: str(d["result"]) ?? e.type, object: str(d["provider_object_id"]) }] : [];
  });

  type A = { idempotency_key: string; at: string; result: string; object: string | null };
  const attempts: A[] =
    keyed.length > 0
      ? keyed.map((k) => ({ idempotency_key: k.key, at: k.at, result: k.result, object: k.object }))
      : entries.map((p) => ({
          idempotency_key: p.idempotency_key ?? "not recorded",
          at: p.at ?? owner?.updated_at ?? "",
          result: p.result ?? "no result recorded",
          object: p.provider_object_id,
        }));
  const known = new Set<string>([...attempts.flatMap((a) => (a.object ? [a.object] : [])), ...entries.flatMap((p) => (p.provider_object_id ? [p.provider_object_id] : []))]);
  for (const o of objects) {
    if (known.has(o.id)) continue;
    attempts.push({
      idempotency_key: "not recorded",
      at: o.created_at,
      result: `the provider holds payment ${o.id} (${o.status}) that the baseline's own record does not show`,
      object: o.id,
    });
  }
  attempts.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const first = entries[0];
  const firstObject = objects[0];
  return {
    source: "baseline" as const,
    effect_key: effectKey,
    passenger_id: passengerOf(effectKey),
    entitlement_type: entitlementOf(effectKey),
    amount_minor: first?.amount_minor ?? firstObject?.amount_minor ?? 0,
    currency: first?.currency ?? "CAD",
    payee_ref: first?.payee_ref ?? "",
    attempts: attempts.map((a, i) => ({ n: i + 1, idempotency_key: a.idempotency_key, at: a.at, result: a.result })),
    marked_done: owner?.done === true,
    marked_done_at: owner?.done === true ? (owner.done_at ?? owner.updated_at) : null,
    note: BASELINE_NOTES[run.arm] ?? null,
  };
}

// ---- GET /api/runs/:run_id/pool -------------------------------------------------------------------------------------
export async function pool(c: DeskCollections, run: RunRow) {
  // The run's pool by _id: under hierarchical authority (CP-AUTH-1) every node of the tree is a GOODWILL_POOL document too.
  const g = await c.grants.findOne({ _id: `${run._id}:GOODWILL` });
  if (!g) return null;
  return {
    run_id: run._id,
    grant_minor: g.grant_minor,
    held_minor: g.held_minor,
    settled_minor: g.settled_minor,
    frozen: g.frozen,
    currency: g.currency,
    awaiting_budget: run.final_report ? run.final_report.awaiting_budget.map((a) => a.effect_key) : [],
  };
}

