// T1: propose() — the reserve transaction (HANDOVER.md §10.3, authoritative; ARCHITECTURE.md §3.4 T1). Mutation site M5.
import { ObjectId } from "mongodb";
import {
  ProposedPayment,
  hashFrozenRequest,
  marker,
  type Actor,
  type Intent,
  type Obligation,
  type ProposalRefusal,
  type ProposeResult,
} from "@nt/contracts";
import { majorityReader, tryTxn } from "@nt/db";
import { adoptExisting } from "./adopt.ts";
import { auditEvent } from "./audit.ts";
import { goodwillGrantId, holdGoodwill } from "./authority.ts";
import { BudgetRefused, ProgrammerError } from "./errors.ts";
import { buildFrozenRequest, idempotencyKeyFor, providerFor } from "./frozen.ts";
import { capabilitiesOf, hooksOf, type GatewayDeps } from "./types.ts";

const MAX_RESERVE_ATTEMPTS = 3; // after an unknown commit result with no intent found (ARCHITECTURE.md §3.4 T1)

/** Builds the intent document of HANDOVER.md §8.1 from the obligation. Deterministic apart from the informational timestamps. */
export async function buildIntent(deps: GatewayDeps, ob: Obligation): Promise<Intent> {
  const provider = providerFor(ob, deps.config.stripeEnabled);
  let ticketPaymentRef: string | null = null;
  if (provider === "stripe_refund") {
    const booking = await deps.db.bookings.findOne({ _id: `${ob.run_id}:${ob.booking_ref}:${ob.passenger_id}` });
    ticketPaymentRef = booking?.ticket_payment_ref ?? null;
  }
  const frozen = buildFrozenRequest(ob, provider, { runId: deps.runId, ticketPaymentRef });
  const m = marker(deps.runId, ob.effect_key);
  const hooks = hooksOf(deps);
  let id = m;
  if (hooks.mutation("M5")) {
    // M5: a second intent for one key becomes possible. effect_key and idempotency_key stay unchanged.
    id = `${m}#${new ObjectId().toHexString().slice(-8)}`;
    frozen.metadata.nt_marker = id;
  }
  const now = new Date();
  return {
    _id: id,
    run_id: deps.runId,
    effect_key: ob.effect_key,
    obligation_id: ob._id,
    entitlement_type: ob.entitlement_type,
    amount_minor: ob.amount_minor,
    currency: "CAD",
    payee_ref: ob.payee_ref,
    provider,
    idempotency_key: idempotencyKeyFor(m, capabilitiesOf(deps, provider)),
    frozen_request: frozen,
    frozen_request_sha256: hashFrozenRequest(frozen),
    draws_on: ob.entitlement_type === "GOODWILL" ? goodwillGrantId(deps.runId) : null,
    state: "RESERVED",
    lease: null,
    lease_epoch: 0,
    first_dispatch_at: null,
    last_send_at: null,
    key_expires_at: null,
    next_attempt_at: null,
    attempts: [],
    evidence: null,
    rejection: null,
    quarantine: null,
    policy_version: ob.policy_version,
    rule_citation: ob.rule_citation,
    created_at: now,
    updated_at: now,
  };
}

async function refuse(deps: GatewayDeps, p: ProposedPayment, reason: ProposalRefusal, detail: Record<string, unknown>): Promise<ProposeResult> {
  const actor: Actor = { kind: "gateway", id: deps.workerId };
  const type = reason === "AWAITING_BUDGET" ? "BUDGET_REFUSED" : "ANOMALY";
  await deps.db.audit.insertOne(
    auditEvent(type, null, {
      run_id: p.run_id,
      effect_key: p.effect_key,
      actor,
      claim_id: p.claim_ids[0] ?? null,
      detail: { kind: "PROPOSAL_REFUSED", reason, proposed_by: p.proposed_by, ...detail },
    }),
    { writeConcern: { w: "majority" } },
  );
  return { kind: "REFUSED", reason };
}

/**
 * Reserve an OWED obligation. The frozen request is built from the obligation; a proposal whose amount or payee differs
 * is refused (property P10). Goodwill only: the guarded pool update. One intent per key: the _id is the guard.
 */
export async function propose(deps: GatewayDeps, input: ProposedPayment): Promise<ProposeResult> {
  const p = ProposedPayment.parse(input);
  if (p.run_id !== deps.runId) throw new ProgrammerError(`proposal for run ${p.run_id} sent to the gateway of run ${deps.runId}`);
  const hooks = hooksOf(deps);
  const claimId = p.claim_ids[0] ?? null;

  for (let attempt = 1; attempt <= MAX_RESERVE_ATTEMPTS; attempt++) {
    const ob = await deps.db.obligations.findOne({ _id: marker(p.run_id, p.effect_key) });
    if (!ob || ob.status !== "OWED") return refuse(deps, p, "OBLIGATION_NOT_OWED", { status: ob?.status ?? null });
    if (ob.amount_minor !== p.amount_minor || ob.payee_ref !== p.payee_ref || ob.currency !== p.currency) {
      return refuse(deps, p, "PROPOSAL_MISMATCH", {
        proposed: { amount_minor: p.amount_minor, payee_ref: p.payee_ref, currency: p.currency },
      });
    }

    const intent = await buildIntent(deps, ob);
    const eventId = new ObjectId(); // minted outside the callback: a re-run inserts the same event; it answers "did T1 commit?"
    const event = auditEvent("INTENT_RESERVED", intent, {
      _id: eventId,
      actor: { kind: "gateway", id: deps.workerId },
      from_state: null,
      to_state: "RESERVED",
      claim_id: claimId,
      detail: { transition: "T1", proposed_by: p.proposed_by, frozen_request_sha256: intent.frozen_request_sha256 },
    });

    let out;
    try {
      out = await tryTxn(deps.db, async (session) => {
        // callback may re-run: database writes and the barrier only
        if (intent.draws_on) await holdGoodwill(deps.db, session, intent.draws_on, intent.amount_minor, hooks);
        await deps.db.intents.insertOne(intent, { session }); // duplicate _id → 11000 → abort (and the $inc with it)
        await deps.db.audit.insertOne(event, { session });
        hooks.barrier("BR_RESERVE_BEFORE_COMMIT", intent.effect_key);
      });
    } catch (e) {
      if (e instanceof BudgetRefused) {
        return refuse(deps, p, "AWAITING_BUDGET", { amount_minor: intent.amount_minor, grant_id: intent.draws_on });
      }
      throw e;
    }

    if (out.kind === "COMMITTED") {
      hooks.barrier("BR_RESERVE_AFTER_COMMIT", intent.effect_key);
      return { kind: "RESERVED", intent };
    }
    if (out.kind === "UNKNOWN_COMMIT_RESULT") {
      const ours = await majorityReader(deps.db.db, "audit").findOne({ _id: eventId });
      if (ours) {
        const committed = await majorityReader(deps.db.db, "intents").findOne({ _id: intent._id });
        if (committed) return { kind: "RESERVED", intent: committed };
      }
    }
    // DUPLICATE_KEY, or an unknown commit that was not ours: adopt what is there.
    const adopted = await adoptExisting(deps, intent._id, intent.frozen_request_sha256, claimId);
    if (adopted) return adopted;
    if (out.kind === "DUPLICATE_KEY") throw out.error; // 11000 on something other than the intent _id: surface it
    // unknown commit, nothing committed: propose again (safe: the _id deduplicates and a failed insert aborts its own $inc)
  }
  throw new Error(`propose: reserve of ${p.effect_key} did not commit after ${MAX_RESERVE_ATTEMPTS} attempts`);
}
