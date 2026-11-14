// scanInvariants(run_id) (HANDOVER.md §16): P1, P2, P3, P9 and UNMATCHED_PROVIDER_OBJECT. Reads the provider only through
// its list method (listOperations). Never patches anything; the only write is an ANOMALY audit event per unmatched object.
import { ObjectId } from "mongodb";
import { allowedTransition, simAccountOf, type Intent, type IntentState, type ProviderObject } from "@nt/contracts";
import { auditEvent } from "./audit.ts";
import { goodwillGrantId } from "./authority.ts";
import type { GatewayDeps } from "./types.ts";

export type InvariantViolation = { code: string; intent_id: string | null; detail: string };
export type InvariantReport = { ok: boolean; run_id: string; intents: number; violations: InvariantViolation[] };

const HELD_STATES: readonly IntentState[] = ["RESERVED", "DISPATCHING", "OUTCOME_UNKNOWN", "QUARANTINED"];

export async function scanInvariants(deps: GatewayDeps, runId: string): Promise<InvariantReport> {
  const v: InvariantViolation[] = [];
  const intents = await deps.db.intents.find({ run_id: runId }, { readConcern: { level: "majority" } } as never).toArray();
  const byId = new Map(intents.map((i) => [i._id, i]));

  // P1: at most one intent per effect key.
  const perKey = new Map<string, Intent[]>();
  for (const it of intents) perKey.set(it.effect_key, [...(perKey.get(it.effect_key) ?? []), it]);
  for (const [key, list] of perKey) if (list.length > 1) v.push({ code: "P1_MULTIPLE_INTENTS_PER_KEY", intent_id: null, detail: `${key}: ${list.map((i) => i._id).join(", ")}` });

  // P2: counters equal the recomputation, and held + settled <= grant (unknown and quarantined count as held).
  const grant = await deps.db.grants.findOne({ _id: goodwillGrantId(runId) });
  const drawing = intents.filter((i) => i.draws_on !== null);
  if (grant) {
    const held = drawing.filter((i) => HELD_STATES.includes(i.state)).reduce((s, i) => s + i.amount_minor, 0);
    const settled = drawing.filter((i) => i.state === "CONFIRMED").reduce((s, i) => s + i.amount_minor, 0);
    if (held !== grant.held_minor || settled !== grant.settled_minor) {
      v.push({ code: "P2_COUNTER_DRIFT", intent_id: null, detail: `stored held ${grant.held_minor} settled ${grant.settled_minor}; recomputed held ${held} settled ${settled}` });
    }
    if (grant.held_minor + grant.settled_minor > grant.grant_minor) v.push({ code: "P2_CAP_EXCEEDED", intent_id: null, detail: `${grant.held_minor} + ${grant.settled_minor} > ${grant.grant_minor}` });
  } else if (drawing.length > 0) {
    v.push({ code: "P2_GRANT_MISSING", intent_id: null, detail: `${drawing.length} intent(s) draw on a missing grant` });
  }

  // P3: every CONFIRMED intent carries evidence whose marker equals its _id.
  for (const it of intents) {
    if (it.state === "CONFIRMED" && (!it.evidence || it.evidence.marker !== it._id)) v.push({ code: "P3_CONFIRMED_WITHOUT_EVIDENCE", intent_id: it._id, detail: JSON.stringify(it.evidence) });
  }

  // P9: replaying the state-changing audit events reproduces the state, with no forbidden transition.
  // ObjectIds minted by two processes (a killed runner and its successor) need not sort in creation order within one second,
  // so the chain is rebuilt from the events themselves: start from no state, repeatedly take the earliest (by `at`, then _id)
  // event whose from_state is the current state. Every event must be consumed and every step must be an allowed transition.
  const events = await deps.db.audit.find({ run_id: runId, to_state: { $ne: null } }).toArray();
  const ts = (e: (typeof events)[number]): number => new Date(e.at as unknown as string | Date).getTime();
  events.sort((a, b) => ts(a) - ts(b) || String(a._id).localeCompare(String(b._id)));
  const perIntent = new Map<string, typeof events>();
  for (const e of events) if (e.intent_id) perIntent.set(e.intent_id, [...(perIntent.get(e.intent_id) ?? []), e]);
  for (const it of intents) {
    let state: IntentState | null = null;
    const pending = [...(perIntent.get(it._id) ?? [])];
    while (pending.length > 0) {
      const i = pending.findIndex((e) => e.from_state === state);
      if (i < 0) {
        const e = pending[0]!;
        v.push({ code: "P9_FORBIDDEN_OR_BROKEN_CHAIN", intent_id: it._id, detail: `${e.type} ${e.from_state} -> ${e.to_state} while replayed state is ${state}` });
        break;
      }
      const e = pending.splice(i, 1)[0]!;
      if (allowedTransition(e.from_state, e.to_state!) === null) {
        v.push({ code: "P9_FORBIDDEN_OR_BROKEN_CHAIN", intent_id: it._id, detail: `${e.type} ${e.from_state} -> ${e.to_state} is not an allowed transition` });
      }
      state = e.to_state;
    }
    if (state !== it.state) v.push({ code: "P9_REPLAY_MISMATCH", intent_id: it._id, detail: `replayed ${state}, stored ${it.state}` });
  }

  // Provider objects carrying the run's id and no intent with their marker.
  // Every configured provider is listed (two simulator clients on one account return the same objects; deduplicated by id).
  const objects = new Map<string, ProviderObject>();
  for (const [id, p] of Object.entries(deps.providers)) {
    if (!p) continue;
    const account = id === "stripe_refund" ? "stripe" : simAccountOf(runId);
    try {
      for await (const o of p.listOperations({ account })) objects.set(o.id, o);
    } catch (e) {
      v.push({ code: "PROVIDER_LIST_INCOMPLETE", intent_id: null, detail: `${id} ${account}: ${(e as Error).message}` });
    }
  }
  {
    for (const o of objects.values()) {
      if (o.metadata["nt_run_id"] !== runId) continue;
      const marker = o.metadata["nt_marker"];
      if (marker && byId.has(marker)) continue;
      v.push({ code: "UNMATCHED_PROVIDER_OBJECT", intent_id: null, detail: `${o.id} marker ${marker ?? "none"}` });
      const already = await deps.db.audit.findOne({ run_id: runId, type: "ANOMALY", "detail.provider_object_id": o.id });
      if (!already) {
        await deps.db.audit.insertOne(
          auditEvent("ANOMALY", null, {
            _id: new ObjectId(), run_id: runId, effect_key: o.metadata["nt_effect_key"] ?? null, actor: { kind: "gateway", id: deps.workerId },
            detail: { kind: "UNMATCHED_PROVIDER_OBJECT", provider_object_id: o.id, marker: marker ?? null, amount_minor: o.amount_minor, payee_ref: o.payee_ref },
          }),
          { writeConcern: { w: "majority" } },
        );
      }
    }
  }
  return { ok: v.length === 0, run_id: runId, intents: intents.length, violations: v };
}
