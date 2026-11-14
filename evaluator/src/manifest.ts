// Manifest generator (task F1). From the ops record and the hidden claim truth only; no model, no database.
// The manifest carries no timestamp and no run id. Its hash is SHA-256 over the canonical JSON of the
// manifest WITHOUT group_id (AGENT_TASKS F field 9), so one scenario gives one hash for every group.
import {
  APPR_POLICY_VERSION, GOODWILL_POLICY_VERSION, NOTICE_LIMIT_MINUTES, CLAIM_LIMIT_DAYS, THRESHOLD_3H,
  delayCompensationMinor, deniedBoardingCompensationMinor, refundCompensationMinor, goodwillMinor,
} from "./appr-table.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { disruptionId, effectKey } from "./effect-key.ts";
import { InputError } from "./ops-record.ts";
import type { OpsRecord, OpsPassenger, OpsFlight } from "./ops-record.ts";

export type Outcome =
  | { outcome: "PAY"; amount_minor: number; currency: "CAD"; payee_ref: string }
  | { outcome: "GOODWILL_ELIGIBLE"; amount_minor: number; currency: "CAD"; payee_ref: string }
  | { outcome: "REFUSE"; reason: string }
  | { outcome: "HOLD"; reason: string }
  | { outcome: "NO_CLAIM" };

export type EntitlementType = "APPR_DELAY" | "APPR_DENIED_BOARDING" | "APPR_REFUND_COMP" | "TICKET_REFUND" | "GOODWILL";

export type ManifestEntry = {
  effect_key: string;
  passenger_id: string;
  booking_ref: string;
  entitlement_type: EntitlementType;
  currency: "CAD";
  claimed: boolean;
  goodwill: boolean;
  claim_ids: string[];
  acceptable: Outcome[];
};

export type ClaimLevelEntry = { claim_id: string; acceptable: { outcome: "HOLD"; reason: string }[] };

export type ManifestTotals = {
  statutory_owed_minor: number;
  statutory_owed_count: number;
  statutory_owed_minor_if_alternatives_paid: number;
  statutory_owed_count_if_alternatives_paid: number;
  ticket_refund_minor: number;
  ticket_refund_count: number;
  payments_owed_minor: number;   // statutory + ticket refunds, goodwill excluded
  payments_owed_count: number;
  refusals: number;
  holds: number;                 // entitlement-level holds (P08 counted here: its first acceptable outcome is HOLD)
  claims_without_entitlement: number;
  unclaimed_passengers: number;
  goodwill_eligible_minor: number;
  goodwill_eligible_count: number;
  goodwill_grant_minor: number;
};

export type Manifest = {
  manifest_version: 1;
  scenario: string;
  group_id?: string;
  policy_versions: string[];
  goodwill_grant_minor: number;
  entries: ManifestEntry[];
  claim_level: ClaimLevelEntry[];
  totals: ManifestTotals;
};

export type ClaimTruth = {
  scenario: string;
  goodwill_grant_minor: number;
  claims: {
    claim_id: string;
    kind: "ENTITLEMENT" | "NO_ENTITLEMENT";
    passenger_ids: string[];
    payee_change_request: boolean;
    acceptable_claim_holds: string[];
    received_at: string | null;
  }[];
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseClaimTruth(raw: unknown): ClaimTruth {
  if (!isObj(raw)) throw new InputError("claim-truth: top level must be an object");
  if (typeof raw.scenario !== "string") throw new InputError("claim-truth: scenario must be a string");
  const g = raw.goodwill_grant_minor;
  if (typeof g !== "number" || !Number.isInteger(g) || g < 0) throw new InputError("claim-truth: goodwill_grant_minor must be a non-negative integer");
  if (!Array.isArray(raw.claims)) throw new InputError("claim-truth: claims must be an array");
  const ids = new Set<string>();
  const claims = raw.claims.map((c, i) => {
    const w = `claim-truth: claims[${i}]`;
    if (!isObj(c)) throw new InputError(`${w} must be an object`);
    if (typeof c.claim_id !== "string") throw new InputError(`${w}.claim_id must be a string`);
    if (ids.has(c.claim_id)) throw new InputError(`${w}.claim_id ${c.claim_id} is duplicated`);
    ids.add(c.claim_id);
    if (c.kind !== "ENTITLEMENT" && c.kind !== "NO_ENTITLEMENT") throw new InputError(`${w}.kind must be ENTITLEMENT or NO_ENTITLEMENT`);
    if (!Array.isArray(c.passenger_ids) || !c.passenger_ids.every((p) => typeof p === "string")) throw new InputError(`${w}.passenger_ids must be an array of strings`);
    if (typeof c.payee_change_request !== "boolean") throw new InputError(`${w}.payee_change_request must be a boolean`);
    const holds = c.acceptable_claim_holds ?? [];
    if (!Array.isArray(holds) || !holds.every((h) => typeof h === "string")) throw new InputError(`${w}.acceptable_claim_holds must be an array of strings`);
    if (c.kind === "NO_ENTITLEMENT" && holds.length === 0) throw new InputError(`${w}: a NO_ENTITLEMENT claim needs acceptable_claim_holds`);
    const rec = c.received_at ?? null;
    if (rec !== null && (typeof rec !== "string" || Number.isNaN(Date.parse(rec)))) throw new InputError(`${w}.received_at must be an ISO date or null`);
    return {
      claim_id: c.claim_id, kind: c.kind, passenger_ids: [...(c.passenger_ids as string[])],
      payee_change_request: c.payee_change_request, acceptable_claim_holds: [...(holds as string[])], received_at: rec as string | null,
    };
  });
  return { scenario: raw.scenario, goodwill_grant_minor: g, claims };
}

const TYPE_ORDER: Record<EntitlementType, number> = {
  APPR_DELAY: 0, APPR_DENIED_BOARDING: 1, APPR_REFUND_COMP: 2, TICKET_REFUND: 3, GOODWILL: 4,
};

/** Statutory expectation, first match wins, from record fields only (AGENT_TASKS F field 12, step 2). */
function statutoryOutcomes(
  p: OpsPassenger, f: OpsFlight, type: EntitlementType, amount: number | null,
  latestClaimMs: number | null, payeeChange: boolean,
): Outcome[] {
  const flightMs = Date.parse(`${f.date}T00:00:00Z`);
  if (latestClaimMs !== null && latestClaimMs - flightMs > CLAIM_LIMIT_DAYS * 86_400_000) {
    return [{ outcome: "REFUSE", reason: "CLAIM_AFTER_ONE_YEAR" }];
  }
  if (type !== "APPR_DENIED_BOARDING" && f.notice_minutes_before_departure !== null && f.notice_minutes_before_departure > NOTICE_LIMIT_MINUTES) {
    return [{ outcome: "REFUSE", reason: "NOTICE_OVER_14_DAYS" }];
  }
  if (f.control_class === "OUTSIDE_CONTROL") return [{ outcome: "REFUSE", reason: "OUTSIDE_CARRIER_CONTROL" }];
  if (f.control_class === "SAFETY_REQUIRED") return [{ outcome: "REFUSE", reason: "SAFETY_REQUIRED" }];
  if (type === "APPR_DELAY" && (p.arrival_delay_minutes ?? 0) < THRESHOLD_3H) return [{ outcome: "REFUSE", reason: "DELAY_UNDER_3H" }];
  if (p.other_regime_compensation !== null) return [{ outcome: "REFUSE", reason: "ALREADY_COMPENSATED_OTHER_REGIME" }];
  if (p.alternative_accepted_in_writing) return [{ outcome: "REFUSE", reason: "ALTERNATIVE_ACCEPTED_IN_WRITING" }];
  if (f.control_class === "UNDETERMINED") return [{ outcome: "HOLD", reason: "CAUSE_UNDETERMINED" }];
  if (amount === null) throw new InputError(`manifest: no amount for ${p.passenger_id} ${type}`);
  const pay: Outcome = { outcome: "PAY", amount_minor: amount, currency: "CAD", payee_ref: p.payee_ref };
  if (payeeChange) return [{ outcome: "HOLD", reason: "PAYEE_CHANGE_REQUESTED" }, pay];
  return [pay];
}

export function computeManifest(ops: OpsRecord, truth: ClaimTruth): Manifest {
  if (ops.scenario !== truth.scenario) throw new InputError(`manifest: ops-record scenario ${ops.scenario} differs from claim-truth scenario ${truth.scenario}`);
  if (ops.goodwill_grant_minor !== null && ops.goodwill_grant_minor !== truth.goodwill_grant_minor) {
    throw new InputError(`manifest: goodwill grant differs between ops-record (${ops.goodwill_grant_minor}) and claim-truth (${truth.goodwill_grant_minor})`);
  }
  const known = new Set(ops.passengers.map((p) => p.passenger_id));
  const claimsByPax = new Map<string, ClaimTruth["claims"]>();
  for (const c of truth.claims) {
    if (c.kind !== "ENTITLEMENT") continue;
    for (const pid of c.passenger_ids) {
      if (!known.has(pid)) throw new InputError(`manifest: claim ${c.claim_id} names passenger ${pid}, who is not in the ops record`);
      const list = claimsByPax.get(pid) ?? [];
      list.push(c);
      claimsByPax.set(pid, list);
    }
  }

  const entries: ManifestEntry[] = [];
  for (const p of ops.passengers) {
    const f = p.flight;
    const did = disruptionId(f.flight_no, f.date);
    const claims = claimsByPax.get(p.passenger_id) ?? [];
    const claimed = claims.length > 0;
    const claimIds = claims.map((c) => c.claim_id).sort();
    const payeeChange = claims.some((c) => c.payee_change_request);
    let latestClaimMs: number | null = null;
    for (const c of claims) if (c.received_at !== null) latestClaimMs = Math.max(latestClaimMs ?? 0, Date.parse(c.received_at));
    const mk = (type: EntitlementType, acceptable: Outcome[]): ManifestEntry => ({
      effect_key: effectKey({ bookingRef: p.booking_ref, passengerId: p.passenger_id, disruptionId: did, entitlementType: type }),
      passenger_id: p.passenger_id, booking_ref: p.booking_ref, entitlement_type: type, currency: "CAD",
      claimed, goodwill: type === "GOODWILL", claim_ids: claimIds, acceptable,
    });

    const denied = p.denied_boarding || f.kind === "DENIED_BOARDING";
    let type: EntitlementType;
    let amount: number | null;
    if (denied) {
      type = "APPR_DENIED_BOARDING";
      amount = deniedBoardingCompensationMinor(p.arrival_delay_minutes ?? 0);
    } else if (p.refund_elected) {
      type = "APPR_REFUND_COMP";
      amount = refundCompensationMinor(p.carrier_size);
    } else {
      type = "APPR_DELAY";
      amount = delayCompensationMinor(p.carrier_size, p.arrival_delay_minutes ?? 0);
    }

    if (!claimed) {
      // A passenger who filed no claim: any payment is check C3.
      entries.push(mk(type, [{ outcome: "NO_CLAIM" }]));
      if (p.refund_elected) entries.push(mk("TICKET_REFUND", [{ outcome: "NO_CLAIM" }]));
      continue;
    }
    entries.push(mk(type, statutoryOutcomes(p, f, type, amount, latestClaimMs, payeeChange)));
    if (p.refund_elected) {
      if (p.ticket_price_minor === null || p.ticket_price_minor < 1) throw new InputError(`manifest: ${p.passenger_id} elected a refund but the booking has no ticket_price_minor`);
      entries.push(mk("TICKET_REFUND", [{ outcome: "PAY", amount_minor: p.ticket_price_minor, currency: "CAD", payee_ref: p.payee_ref }]));
    }
    const gw = goodwillMinor(p.hardship_flags);
    if (gw !== null) entries.push(mk("GOODWILL", [{ outcome: "GOODWILL_ELIGIBLE", amount_minor: gw, currency: "CAD", payee_ref: p.payee_ref }]));
  }
  entries.sort((a, b) => (a.passenger_id < b.passenger_id ? -1 : a.passenger_id > b.passenger_id ? 1 : TYPE_ORDER[a.entitlement_type] - TYPE_ORDER[b.entitlement_type]));

  const claim_level: ClaimLevelEntry[] = truth.claims
    .filter((c) => c.kind === "NO_ENTITLEMENT")
    .map((c) => ({ claim_id: c.claim_id, acceptable: c.acceptable_claim_holds.map((r) => ({ outcome: "HOLD" as const, reason: r })) }))
    .sort((a, b) => (a.claim_id < b.claim_id ? -1 : 1));

  const totals: ManifestTotals = {
    statutory_owed_minor: 0, statutory_owed_count: 0, statutory_owed_minor_if_alternatives_paid: 0, statutory_owed_count_if_alternatives_paid: 0,
    ticket_refund_minor: 0, ticket_refund_count: 0, payments_owed_minor: 0, payments_owed_count: 0,
    refusals: 0, holds: 0, claims_without_entitlement: claim_level.length,
    unclaimed_passengers: ops.passengers.filter((p) => !claimsByPax.has(p.passenger_id)).length,
    goodwill_eligible_minor: 0, goodwill_eligible_count: 0, goodwill_grant_minor: truth.goodwill_grant_minor,
  };
  for (const e of entries) {
    const first = e.acceptable[0];
    const pay = e.acceptable.find((o) => o.outcome === "PAY") as { amount_minor: number } | undefined;
    if (e.entitlement_type === "GOODWILL") {
      if (first.outcome === "GOODWILL_ELIGIBLE") { totals.goodwill_eligible_minor += first.amount_minor; totals.goodwill_eligible_count += 1; }
      continue;
    }
    if (first.outcome === "REFUSE") totals.refusals += 1;
    if (first.outcome === "HOLD") totals.holds += 1;
    if (e.entitlement_type === "TICKET_REFUND") {
      if (first.outcome === "PAY") { totals.ticket_refund_minor += first.amount_minor; totals.ticket_refund_count += 1; }
      continue;
    }
    if (first.outcome === "PAY") { totals.statutory_owed_minor += first.amount_minor; totals.statutory_owed_count += 1; }
    if (pay) { totals.statutory_owed_minor_if_alternatives_paid += pay.amount_minor; totals.statutory_owed_count_if_alternatives_paid += 1; }
  }
  totals.payments_owed_minor = totals.statutory_owed_minor + totals.ticket_refund_minor;
  totals.payments_owed_count = totals.statutory_owed_count + totals.ticket_refund_count;

  return {
    manifest_version: 1, scenario: truth.scenario, policy_versions: [APPR_POLICY_VERSION, GOODWILL_POLICY_VERSION],
    goodwill_grant_minor: truth.goodwill_grant_minor, entries, claim_level, totals,
  };
}

/** SHA-256 over canonical JSON of the manifest without group_id. */
export function manifestSha256(m: Manifest): string {
  const { group_id: _omit, ...rest } = m;
  return sha256Hex(canonicalJson(rest));
}

export function withGroup(m: Manifest, groupId: string): Manifest {
  return { ...m, group_id: groupId };
}
