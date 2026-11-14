// /v1/* routes: accounts, create payout/refund (idempotency + faults), get, list, search, events.
import type { Hono } from "hono";
import type { Ctx, Env } from "./http.ts";
import { fail, hang, sleep } from "./http.ts";
import type { AccountState, HeldRequest, PayoutObject, Store } from "./ledger.ts";
import { consumeFault } from "./faults.ts";
import type { FaultEntry } from "./faults.ts";

type ParsedRequest = {
  account: string;
  rail: "instant" | "legacy";
  operation: "PAYOUT" | "REFUND";
  amount_minor: number;
  currency: string;
  payee_ref: string;
  parent_ref: string | null;
  metadata: Record<string, string>;
};

type Resp = { status: number; body: unknown; replayed: boolean | null; label: string };

function validate(body: unknown, store: Store): { error: { code: string; message: string } } | { req: ParsedRequest } {
  const bad = (message: string) => ({ error: { code: "invalid_request", message } });
  if (body === null || typeof body !== "object" || Array.isArray(body)) return bad("body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.account !== "string" || b.account === "") return bad("account is required");
  if (!store.get(b.account)) return bad(`unknown account ${b.account}`);
  if (b.rail !== "instant" && b.rail !== "legacy") return bad('rail must be "instant" or "legacy"');
  if (b.operation !== "PAYOUT" && b.operation !== "REFUND") return bad('operation must be "PAYOUT" or "REFUND"');
  if (b.amount_minor === undefined) return bad("amount_minor is required");
  if (b.currency === undefined) return bad("currency is required");
  if (typeof b.payee_ref !== "string" || b.payee_ref === "") return bad("payee_ref is required");
  if (b.parent_ref !== undefined && b.parent_ref !== null && typeof b.parent_ref !== "string") return bad("parent_ref must be a string or null");
  const md = b.metadata;
  if (md === null || typeof md !== "object" || Array.isArray(md)) return bad("metadata must be an object");
  for (const v of Object.values(md as Record<string, unknown>)) {
    if (typeof v !== "string") return bad("metadata values must be strings");
  }
  if (typeof b.amount_minor !== "number" || !Number.isSafeInteger(b.amount_minor) || b.amount_minor < 1 || b.currency !== "CAD") {
    return { error: { code: "amount_invalid", message: "amount_minor must be an integer >= 1 and currency CAD" } };
  }
  return {
    req: {
      account: b.account,
      rail: b.rail,
      operation: b.operation,
      amount_minor: b.amount_minor,
      currency: b.currency,
      payee_ref: b.payee_ref,
      parent_ref: (b.parent_ref ?? null) as string | null,
      metadata: md as Record<string, string>,
    },
  };
}

function rejectMessage(code: string): string {
  return code === "payee_closed" ? "payee account closed" : `rejected: ${code}`;
}

/** Commit a held late commit (released, or its timer fired). Returns the object, or null if already committed. */
export function commitHeld(acct: AccountState, held: HeldRequest): PayoutObject | null {
  if (held.committed) return null;
  held.committed = true;
  if (held.timer) clearTimeout(held.timer);
  acct.held = acct.held.filter((h) => h !== held);
  return acct.commitObject({
    kind: held.kind,
    amount_minor: held.amount_minor,
    currency: held.currency,
    payee_ref: held.payee_ref,
    parent_ref: held.parent_ref,
    metadata: held.metadata,
    key: held.key,
    body_sha256: held.body_sha256,
  });
}

export function releaseHeld(acct: AccountState, filter: { payee_ref?: string; marker?: string }): Array<{ id: string; marker: string | null }> {
  const out: Array<{ id: string; marker: string | null }> = [];
  for (const h of [...acct.held]) {
    if (filter.payee_ref !== undefined && h.payee_ref !== filter.payee_ref) continue;
    if (filter.marker !== undefined && h.marker !== filter.marker) continue;
    const obj = commitHeld(acct, h);
    if (obj) out.push({ id: obj.id, marker: h.marker });
  }
  return out;
}

async function createPayout(c: Ctx): Promise<Response> {
  const rc = c.get("rc");
  const store = c.get("store");
  let parsed: unknown;
  try {
    if (rc.raw === null) throw new Error("empty");
    parsed = JSON.parse(Buffer.from(rc.raw).toString("utf8"));
  } catch {
    rc.log("INVALID", 400);
    return fail(c, 400, "invalid_request", "body must be valid JSON");
  }
  const v = validate(parsed, store);
  if ("error" in v) {
    rc.log("INVALID", 400);
    return fail(c, 400, v.error.code, v.error.message);
  }
  const req = v.req;
  const acct = store.get(req.account)!;
  rc.acct = acct;
  const bodySha = rc.bodySha!;
  const marker = req.metadata.nt_marker ?? null;

  acct.ordinal += 1;
  const keyed = req.rail === "instant" && rc.key !== null;
  const key = keyed ? rc.key! : null;
  const now = acct.clock.now();
  const rec = key !== null ? acct.keys.lookup(key, now, acct.config.retention_ms) : undefined;
  const fresh = rec === undefined;
  const fault: FaultEntry | null = consumeFault(
    acct.faults,
    { account: acct.config.account, payee_ref: req.payee_ref, marker, ordinal: acct.ordinal },
    fresh,
  );
  const faultName = fault?.fault ?? null;
  const kind = req.operation === "REFUND" ? "refund" : "payout";

  // Transport faults that stop the request before anything is looked at or executed.
  if (fault?.fault === "DROP_REQUEST") {
    rc.log("DROPPED", null, faultName);
    return hang();
  }
  if (fault?.fault === "IN_PROGRESS") {
    rc.log("CONFLICT", 409, faultName);
    return fail(c, 409, "request_in_progress", "a request with this key is executing");
  }

  let r: Resp;
  if (rec) {
    if (rec.body_sha256 !== bodySha) {
      r = { status: 422, body: { error: { code: "idempotency_key_reuse", message: "body hash differs from the stored request" } }, replayed: null, label: "KEY_REUSE" };
    } else if (rec.state === "IN_PROGRESS") {
      r = { status: 409, body: { error: { code: "request_in_progress", message: "a request with this key is executing" } }, replayed: null, label: "CONFLICT" };
    } else if (rec.result && rec.result.status === 201) {
      const so = acct.byId.get(rec.result.object_id);
      if (!so) {
        rc.log("EXECUTED", 500, faultName);
        return fail(c, 500, "internal", "stored object missing");
      }
      r = { status: 201, body: so.obj, replayed: true, label: "REPLAYED" };
    } else if (rec.result && rec.result.status === 400) {
      r = { status: 400, body: { error: rec.result.error }, replayed: true, label: "REPLAYED" };
    } else {
      rc.log("EXECUTED", 500, faultName);
      return fail(c, 500, "internal", "corrupt key record");
    }
  } else if (fault?.fault === "LATE_COMMIT_ON_RELEASE" || fault?.fault === "LATE_COMMIT_AFTER_MS") {
    // Held: nothing is committed now. On rail instant the key is IN_PROGRESS (a same-key request gets 409).
    const held: HeldRequest = {
      account: acct.config.account,
      payee_ref: req.payee_ref,
      marker,
      key,
      body_sha256: bodySha,
      kind,
      amount_minor: req.amount_minor,
      currency: req.currency,
      parent_ref: req.parent_ref,
      metadata: req.metadata,
      fault: fault.fault,
      timer: null,
      committed: false,
    };
    if (key !== null) acct.keys.beginInProgress(key, bodySha, now);
    if (fault.fault === "LATE_COMMIT_AFTER_MS") {
      held.timer = setTimeout(() => commitHeld(acct, held), fault.ms!);
    }
    acct.held.push(held);
    rc.log("HELD", null, faultName);
    return hang();
  } else if (fault?.fault === "REJECT") {
    const error = { code: fault.code!, message: rejectMessage(fault.code!) };
    if (key !== null) acct.storeRejection(key, bodySha, error);
    r = { status: 400, body: { error }, replayed: false, label: "REJECTED" };
  } else {
    const obj = acct.commitObject({
      kind,
      amount_minor: req.amount_minor,
      currency: req.currency,
      payee_ref: req.payee_ref,
      parent_ref: req.parent_ref,
      metadata: req.metadata,
      key,
      body_sha256: bodySha,
    });
    r = { status: 201, body: obj, replayed: false, label: "EXECUTED" };
  }

  // Transport faults applied after the operation (their effect on the key store is already done).
  if (fault?.fault === "DROP_RESPONSE_AFTER_APPLY") {
    rc.log(r.label, null, faultName);
    return hang();
  }
  if (fault?.fault === "SERVER_ERROR_AFTER_APPLY") {
    rc.log(r.label, 500, faultName);
    return fail(c, 500, "internal", "simulated server error");
  }
  rc.log(r.label, r.status, faultName);
  if (fault?.fault === "HOLD_RESPONSE_MS") await sleep(fault.ms!);
  if (req.rail === "instant" && r.replayed !== null) c.header("Idempotent-Replayed", String(r.replayed));
  return c.json(r.body, r.status as 200);
}

function accountOr404(c: Ctx, name: string | undefined): AccountState | Response {
  if (!name) return fail(c, 400, "invalid_request", "account is required");
  const acct = c.get("store").get(name);
  if (!acct) return fail(c, 404, "not_found", `unknown account ${name}`);
  c.get("rc").acct = acct;
  return acct;
}

function parseTime(v: string | undefined): number | null | undefined {
  if (v === undefined || v === "") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export function mountV1(app: Hono<Env>): void {
  app.get("/v1/accounts/:account", (c) => {
    const acct = c.get("store").get(c.req.param("account"));
    if (!acct) return fail(c, 404, "not_found", `unknown account ${c.req.param("account")}`);
    c.get("rc").acct = acct;
    const { account, retention_ms, max_in_flight_ms, search_lag_ms } = acct.config;
    return c.json({ account, retention_ms, max_in_flight_ms, search_lag_ms });
  });

  app.post("/v1/payouts", createPayout);

  app.get("/v1/payouts/:id", (c) => {
    const found = c.get("store").findObject(c.req.param("id"));
    if (!found) return fail(c, 404, "not_found", "no such object");
    c.get("rc").acct = found.acct;
    return c.json(found.so.obj);
  });

  // Strongly consistent list: every committed object is visible at once. Ordered by creation sequence.
  app.get("/v1/payouts", (c) => {
    const q = c.req.query();
    const acct = accountOr404(c, q.account);
    if (acct instanceof Response) return acct;
    let limit = 10;
    if (q.limit !== undefined) {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1) return fail(c, 400, "invalid_request", "limit must be an integer >= 1");
      limit = Math.min(limit, 100);
    }
    const gte = parseTime(q.created_gte);
    if (gte === null) return fail(c, 400, "invalid_request", "created_gte must be an ISO-8601 time");
    let afterSeq = 0;
    if (q.starting_after !== undefined && q.starting_after !== "") {
      const cur = acct.byId.get(q.starting_after);
      if (!cur) return fail(c, 400, "invalid_request", "starting_after is not an object of this account");
      afterSeq = cur.seq;
    }
    const matching = acct.objects.filter(
      (so) =>
        so.seq > afterSeq &&
        (q.payee_ref === undefined || so.obj.payee_ref === q.payee_ref) &&
        (gte === undefined || Date.parse(so.obj.created_at) >= gte),
    );
    const page = matching.slice(0, limit);
    const hasMore = matching.length > limit;
    return c.json({ data: page.map((s) => s.obj), has_more: hasMore, next_cursor: hasMore ? page[page.length - 1]!.obj.id : null });
  });

  // Lagging search: objects younger than search_lag_ms (virtual clock) are missing.
  app.get("/v1/search/payouts", (c) => {
    const q = c.req.query();
    const acct = accountOr404(c, q.account);
    if (acct instanceof Response) return acct;
    const cutoff = acct.clock.now() - acct.config.search_lag_ms;
    const data = acct.objects
      .filter(
        (so) =>
          Date.parse(so.obj.created_at) <= cutoff &&
          (q.marker === undefined || so.obj.metadata.nt_marker === q.marker) &&
          (q.payee_ref === undefined || so.obj.payee_ref === q.payee_ref),
      )
      .map((s) => s.obj);
    return c.json({ data });
  });

  // Tier 2: delayed by the search lag and returned in an order that is not creation order (newest first).
  app.get("/v1/events", (c) => {
    const q = c.req.query();
    const acct = accountOr404(c, q.account);
    if (acct instanceof Response) return acct;
    const since = parseTime(q.since);
    if (since === null) return fail(c, 400, "invalid_request", "since must be an ISO-8601 time");
    const cutoff = acct.clock.now() - acct.config.search_lag_ms;
    const data = acct.objects
      .filter((so) => Date.parse(so.obj.created_at) <= cutoff && (since === undefined || Date.parse(so.obj.created_at) >= since))
      .slice()
      .reverse()
      .map((so) => ({
        id: `ev_${String(so.seq).padStart(4, "0")}`,
        type: `${so.obj.kind}.paid`,
        object_id: so.obj.id,
        created_at: so.obj.created_at,
      }));
    return c.json({ data });
  });
}
