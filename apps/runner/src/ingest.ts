// Ingest and adjudicate (HANDOVER.md §13 "Ingest barrier"; AGENT_TASKS.md E field 12).
// ingest: every claim RECEIVED → EXTRACTED → RESOLVED | HELD (model calls outside any transaction).
// adjudicate: group resolved claims by entitlement, compute obligations once per group, insert-once by _id, append claim ids, and move an
// OWED obligation to HELD when a later claim asks for a payee change. Every step is idempotent on restart.
import { extractClaim, INTAKE_PROMPT_VERSION, nameSimilarity, resolve } from "@nt/agents";
import type { Booking, Claim, GoodwillKind, ModelClient, Obligation, ObligationDecision, PolicyBundle } from "@nt/contracts";
import { tryTxn, withTxn, type NtDb } from "@nt/db";
import { computeObligations } from "@nt/rules";
import { runAudit } from "./audit.ts";

type Db = Pick<NtDb, "bookings" | "claims" | "obligations" | "audit" | "client">;
type Log = (msg: string) => void;
const noLog: Log = () => {};

export class BarrierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BarrierError";
  }
}

export type IngestSummary = { extracted: number; resolved: number; held: number; skipped: number };

export async function ingest(deps: { db: Db; runId: string; model: ModelClient; log?: Log }): Promise<IngestSummary> {
  const { db, runId, model } = deps;
  const log = deps.log ?? noLog;
  const summary: IngestSummary = { extracted: 0, resolved: 0, held: 0, skipped: 0 };
  summary.skipped = await db.claims.countDocuments({ run_id: runId, status: { $in: ["RESOLVED", "HELD"] } });
  const bookings = await db.bookings.find({ run_id: runId }).toArray();
  const pending = await db.claims.find({ run_id: runId, status: { $in: ["RECEIVED", "EXTRACTED"] } }).sort({ received_at: 1, claim_id: 1 }).toArray();

  for (const claim of pending) {
    let extraction = claim.extraction;
    if (claim.status === "RECEIVED" || extraction === null) {
      const r = await extractClaim(model, { claim_id: claim.claim_id, channel: claim.channel, text: claim.raw_text });
      if (r.kind === "HELD") {
        await holdClaim(db, claim, "EXTRACTION_FAILED", { cause: r.cause, attempts: r.attempts });
        summary.held++;
        log(`claim ${claim.claim_id}: HELD EXTRACTION_FAILED`);
        continue;
      }
      extraction = r.extraction;
      const meta = { model: model.model, prompt_version: INTAKE_PROMPT_VERSION, mode: model.mode, request_sha256: r.requestSha256, attempts: r.attempts };
      await db.claims.updateOne(
        { _id: claim._id, status: "RECEIVED" },
        { $set: { status: "EXTRACTED", extraction, extraction_meta: meta, updated_at: new Date() } },
      );
      summary.extracted++;
    }

    const res = resolve(extraction, bookings, { claim_id: claim.claim_id, channel: claim.channel, received_at: claim.received_at.toISOString() });
    if (res.kind === "HELD") {
      await holdClaim(db, claim, res.reason_code, { detail: res.detail });
      summary.held++;
      log(`claim ${claim.claim_id}: HELD ${res.reason_code}`);
      continue;
    }
    const claimed = extraction.passengers_claimed_for.length > 0 ? extraction.passengers_claimed_for.map((p) => p.name) : extraction.claimant_names;
    const onBooking = bookings.filter((b) => b.booking_ref === res.booking_ref && res.passenger_ids.includes(b.passenger_id));
    const similarity = Math.min(1, ...claimed.map((n) => Math.max(0, ...onBooking.map((b) => nameSimilarity(n, b.passenger.name)))));
    await db.claims.updateOne(
      { _id: claim._id, status: "EXTRACTED" },
      {
        $set: {
          status: "RESOLVED",
          hold_reason: null,
          resolution: { booking_ref: res.booking_ref, passenger_ids: res.passenger_ids, method: res.method, similarity },
          flags: res.flags,
          updated_at: new Date(),
        },
      },
    );
    summary.resolved++;
  }
  return summary;
}

async function holdClaim(db: Db, claim: Claim, reason: NonNullable<Claim["hold_reason"]>, detail: Record<string, unknown>): Promise<void> {
  const event = runAudit("CLAIM_HELD", claim.run_id, { claim_id: claim.claim_id, detail: { reason_code: reason, ...detail } });
  await withTxn(db, async (session) => {
    await db.claims.updateOne(
      { _id: claim._id, status: { $in: ["RECEIVED", "EXTRACTED"] } },
      { $set: { status: "HELD", hold_reason: reason, updated_at: new Date() } },
      { session },
    );
    await db.audit.insertOne(event, { session });
  });
}

/** The barrier: no claim of the run may be RECEIVED or EXTRACTED when the first proposal is made. */
export async function assertIngestBarrier(db: Pick<NtDb, "claims">, runId: string): Promise<void> {
  const open = await db.claims.countDocuments({ run_id: runId, status: { $in: ["RECEIVED", "EXTRACTED"] } });
  if (open > 0) throw new BarrierError(`ingest barrier: ${open} claim(s) of ${runId} are not yet RESOLVED or HELD; no proposal may be made`);
}

type Group = {
  key: string;
  booking: Booking;
  claims: Claim[]; // in received order
  claimReceivedAt: Date;
  payeeChangeRequested: boolean;
  goodwillProposed: GoodwillKind | null;
};

export type AdjudicateSummary = { groups: number; inserted: number; appended: number; held: number };

export async function adjudicate(deps: { db: Db; runId: string; policy: PolicyBundle; log?: Log }): Promise<AdjudicateSummary> {
  const { db, runId, policy } = deps;
  const log = deps.log ?? noLog;
  const summary: AdjudicateSummary = { groups: 0, inserted: 0, appended: 0, held: 0 };
  const bookings = await db.bookings.find({ run_id: runId }).toArray();
  const bookingBy = new Map(bookings.map((b) => [`${b.booking_ref}.${b.passenger_id}`, b] as const));
  const claims = await db.claims.find({ run_id: runId, status: "RESOLVED" }).sort({ received_at: 1, claim_id: 1 }).toArray();

  const groups = new Map<string, Group>();
  for (const c of claims) {
    if (c.resolution === null) throw new Error(`claim ${c.claim_id} is RESOLVED without a resolution`);
    for (const pid of c.resolution.passenger_ids) {
      const booking = bookingBy.get(`${c.resolution.booking_ref}.${pid}`);
      if (!booking) throw new Error(`claim ${c.claim_id} resolved to ${c.resolution.booking_ref}/${pid}, which is not in the bookings of ${runId}`);
      const key = `${booking.booking_ref}.${booking.passenger_id}.${booking.disruption.disruption_id}`;
      const g = groups.get(key);
      if (!g) {
        groups.set(key, {
          key,
          booking,
          claims: [c],
          claimReceivedAt: c.received_at,
          payeeChangeRequested: c.flags.payeeChangeRequested,
          goodwillProposed: c.flags.goodwillProposed,
        });
      } else {
        g.claims.push(c); // claims are iterated in received order
        if (c.received_at < g.claimReceivedAt) g.claimReceivedAt = c.received_at;
        if (c.flags.payeeChangeRequested) g.payeeChangeRequested = true;
        if (g.goodwillProposed === null) g.goodwillProposed = c.flags.goodwillProposed;
      }
    }
  }

  for (const g of [...groups.values()].sort((a, b) => a.claimReceivedAt.getTime() - b.claimReceivedAt.getTime() || (a.key < b.key ? -1 : 1))) {
    const decisions = computeObligations({
      booking: g.booking,
      passenger: g.booking.passenger,
      disruption: g.booking.disruption,
      claimReceivedAt: g.claimReceivedAt,
      flags: { payeeChangeRequested: g.payeeChangeRequested, goodwillProposed: g.goodwillProposed },
      policy,
    });
    summary.groups++;
    await persistGroup(db, runId, g, decisions, summary, log);
  }
  return summary;
}

async function persistGroup(db: Db, runId: string, g: Group, decisions: ObligationDecision[], summary: AdjudicateSummary, log: Log): Promise<void> {
  const claimIds = g.claims.map((c) => c.claim_id);
  const claimDocIds = g.claims.map((c) => c._id);
  const idOf = (d: ObligationDecision) => `${runId}:${d.effect_key}`;

  let done = false;
  for (let attempt = 1; attempt <= 3 && !done; attempt++) {
    const existing = new Map((await db.obligations.find({ _id: { $in: decisions.map(idOf) } }).toArray()).map((o) => [o._id, o] as const));
    const missing = decisions.filter((d) => !existing.has(idOf(d)));
    if (missing.length === 0) {
      for (const d of decisions) await appendToExisting(db, runId, existing.get(idOf(d)) as Obligation, d, claimIds, summary, log);
      done = true;
      break;
    }
    const decidedAt = new Date();
    const docs: Obligation[] = missing.map((d) => ({ ...d, _id: idOf(d), run_id: runId, claim_ids: claimIds, decided_at: decidedAt }));
    const events = docs.map((o) =>
      runAudit("OBLIGATION_DECIDED", runId, {
        effect_key: o.effect_key,
        claim_id: claimIds[0] ?? null,
        rule_citation: o.rule_citation,
        policy_version: o.policy_version,
        detail: { status: o.status, reason_code: o.reason_code, amount_minor: o.amount_minor, entitlement_type: o.entitlement_type, claim_ids: claimIds },
      }),
    );
    const out = await tryTxn(db, async (session) => {
      await db.obligations.insertMany(docs, { session });
      await db.audit.insertMany(events, { session });
    });
    if (out.kind === "DUPLICATE_KEY" || out.kind === "UNKNOWN_COMMIT_RESULT") continue; // re-read: the obligation exists (or the commit landed)
    if (out.kind !== "COMMITTED") throw new Error(`obligation insert for ${g.key} ended ${out.kind}`);
    summary.inserted += docs.length;
    for (const o of docs) log(`obligation ${o.effect_key}: ${o.status}${o.reason_code ? ` ${o.reason_code}` : ""} ${o.amount_minor}`);
    // the rest of the group (decisions that already existed) is handled on the next pass of the loop
    if (missing.length === decisions.length) done = true;
  }
  if (!done) throw new Error(`obligations for ${g.key} could not be inserted or found after 3 attempts`);
  await db.claims.updateMany({ _id: { $in: claimDocIds } }, { $addToSet: { effect_keys: { $each: decisions.map((d) => d.effect_key) } } });
}

/** An obligation that already exists: append claim ids; the only change allowed is OWED → HELD when the engine now says PAYEE_CHANGE_REQUESTED. */
async function appendToExisting(db: Db, runId: string, existing: Obligation, d: ObligationDecision, claimIds: string[], summary: AdjudicateSummary, log: Log): Promise<void> {
  const fresh = claimIds.filter((c) => !existing.claim_ids.includes(c));
  if (fresh.length > 0) {
    await db.obligations.updateOne({ _id: existing._id }, { $addToSet: { claim_ids: { $each: fresh } } });
    summary.appended++;
  }
  if (existing.status === "OWED" && d.status === "HELD" && d.reason_code === "PAYEE_CHANGE_REQUESTED") {
    const event = runAudit("OBLIGATION_HELD", runId, {
      effect_key: existing.effect_key,
      claim_id: claimIds[0] ?? null,
      rule_citation: existing.rule_citation,
      policy_version: existing.policy_version,
      detail: { from: "OWED", to: "HELD", reason_code: "PAYEE_CHANGE_REQUESTED", claim_ids: claimIds },
    });
    const out = await tryTxn(db, async (session) => {
      const r = await db.obligations.updateOne({ _id: existing._id, status: "OWED" }, { $set: { status: "HELD", reason_code: "PAYEE_CHANGE_REQUESTED" } }, { session });
      if (r.modifiedCount === 1) await db.audit.insertOne(event, { session });
      return r.modifiedCount;
    });
    if (out.kind === "COMMITTED" && out.value === 1) {
      summary.held++;
      log(`obligation ${existing.effect_key}: OWED -> HELD PAYEE_CHANGE_REQUESTED`);
    }
  }
}
