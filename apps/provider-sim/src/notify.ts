// NotifySim (Tier 3, task C4; HANDOVER.md §11.4, §12.2): a KEYLESS tool that sends the written decision letter.
// Same conventions as the payout routes: Bearer auth (write key for POST, read key for GET), the per-account virtual clock for
// created_at and search lag, the per-account append-only ledger, the deterministic fault schedule, the request log.
//   POST /v1/messages                 write key   body { account, recipient, template, amount_minor?, currency?, metadata? }
//                                                 Idempotency-Key is IGNORED: every request that executes creates a new message.
//   GET  /v1/messages/:id             read key    one message or 404
//   GET  /v1/messages?account=&recipient=&created_gte=&starting_after=&limit=
//                                     read key    strongly consistent, creation order, cursor paginated, default limit 10, MAX 20
//   GET  /v1/search/messages?account=&marker=&recipient=
//                                     read key    lags by the account's search_lag_ms: recent messages are missing
// Faults (matched on recipient as payee_ref, metadata.nt_marker as marker, a message ordinal): DROP_REQUEST, IN_PROGRESS, REJECT,
// DROP_RESPONSE_AFTER_APPLY, SERVER_ERROR_AFTER_APPLY, HOLD_RESPONSE_MS. LATE_COMMIT_* do not apply to messages and are not consumed.
import type { Hono } from "hono";
import type { Ctx, Env } from "./http.ts";
import { fail, hang, sleep } from "./http.ts";
import type { AccountState, Store } from "./ledger.ts";
import { consumeFault } from "./faults.ts";

export const MESSAGES_DEFAULT_LIMIT = 10;
export const MESSAGES_MAX_LIMIT = 20;

type ParsedMessage = {
  account: string;
  recipient: string;
  template: string;
  amount_minor: number | null;
  currency: string | null;
  metadata: Record<string, string>;
};

function validate(body: unknown, store: Store): { error: { code: string; message: string } } | { req: ParsedMessage } {
  const bad = (message: string) => ({ error: { code: "invalid_request", message } });
  if (body === null || typeof body !== "object" || Array.isArray(body)) return bad("body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.account !== "string" || b.account === "") return bad("account is required");
  if (!store.get(b.account)) return bad(`unknown account ${b.account}`);
  if (typeof b.recipient !== "string" || b.recipient === "") return bad("recipient is required");
  if (typeof b.template !== "string" || b.template === "") return bad("template is required");
  const amount = b.amount_minor === undefined ? null : b.amount_minor;
  if (amount !== null && (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0)) return bad("amount_minor must be an integer >= 0 or absent");
  const currency = b.currency === undefined ? null : b.currency;
  if (currency !== null && typeof currency !== "string") return bad("currency must be a string or absent");
  const md = b.metadata === undefined ? {} : b.metadata;
  if (md === null || typeof md !== "object" || Array.isArray(md)) return bad("metadata must be an object");
  for (const v of Object.values(md as Record<string, unknown>)) {
    if (typeof v !== "string") return bad("metadata values must be strings");
  }
  return {
    req: { account: b.account, recipient: b.recipient, template: b.template, amount_minor: amount as number | null, currency: currency as string | null, metadata: md as Record<string, string> },
  };
}

async function sendMessage(c: Ctx): Promise<Response> {
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
  acct.msgOrdinal += 1;
  const marker = req.metadata.nt_marker ?? null;
  // Keyless: there is never a stored key record, so every request is "fresh". Late commits are not modelled for messages.
  const eligible = acct.faults.filter((f) => f.fault !== "LATE_COMMIT_ON_RELEASE" && f.fault !== "LATE_COMMIT_AFTER_MS");
  const fault = consumeFault(eligible, { account: acct.config.account, payee_ref: req.recipient, marker, ordinal: acct.msgOrdinal }, true);
  const faultName = fault?.fault ?? null;

  if (fault?.fault === "DROP_REQUEST") {
    rc.log("DROPPED", null, faultName);
    return hang();
  }
  if (fault?.fault === "IN_PROGRESS") {
    rc.log("CONFLICT", 409, faultName);
    return fail(c, 409, "request_in_progress", "a request is executing");
  }
  if (fault?.fault === "REJECT") {
    rc.log("REJECTED", 400, faultName);
    return fail(c, 400, fault.code!, `rejected: ${fault.code!}`);
  }
  const msg = acct.commitMessage(req);
  if (fault?.fault === "DROP_RESPONSE_AFTER_APPLY") {
    rc.log("EXECUTED", null, faultName);
    return hang();
  }
  if (fault?.fault === "SERVER_ERROR_AFTER_APPLY") {
    rc.log("EXECUTED", 500, faultName);
    return fail(c, 500, "internal", "simulated server error");
  }
  rc.log("EXECUTED", 201, faultName);
  if (fault?.fault === "HOLD_RESPONSE_MS") await sleep(fault.ms!);
  return c.json(msg, 201);
}

function accountOr404(c: Ctx, name: string | undefined): AccountState | Response {
  if (!name) return fail(c, 400, "invalid_request", "account is required");
  const acct = c.get("store").get(name);
  if (!acct) return fail(c, 404, "not_found", `unknown account ${name}`);
  c.get("rc").acct = acct;
  return acct;
}

export function mountNotify(app: Hono<Env>, _ctx: { store: Store }): void {
  app.post("/v1/messages", sendMessage);

  app.get("/v1/messages/:id", (c) => {
    const found = c.get("store").findMessage(c.req.param("id"));
    if (!found) return fail(c, 404, "not_found", "no such message");
    c.get("rc").acct = found.acct;
    return c.json(found.sm.msg);
  });

  // Strongly consistent list, creation order. Limit is capped at 20, so a long history needs the cursor.
  app.get("/v1/messages", (c) => {
    const q = c.req.query();
    const acct = accountOr404(c, q.account);
    if (acct instanceof Response) return acct;
    let limit = MESSAGES_DEFAULT_LIMIT;
    if (q.limit !== undefined) {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1) return fail(c, 400, "invalid_request", "limit must be an integer >= 1");
      limit = Math.min(limit, MESSAGES_MAX_LIMIT);
    }
    let gte: number | undefined;
    if (q.created_gte !== undefined && q.created_gte !== "") {
      gte = Date.parse(q.created_gte);
      if (Number.isNaN(gte)) return fail(c, 400, "invalid_request", "created_gte must be an ISO-8601 time");
    }
    let afterSeq = 0;
    if (q.starting_after !== undefined && q.starting_after !== "") {
      const cur = acct.msgById.get(q.starting_after);
      if (!cur) return fail(c, 400, "invalid_request", "starting_after is not a message of this account");
      afterSeq = cur.seq;
    }
    const matching = acct.messages.filter(
      (m) => m.seq > afterSeq && (q.recipient === undefined || m.msg.recipient === q.recipient) && (gte === undefined || Date.parse(m.msg.created_at) >= gte),
    );
    const page = matching.slice(0, limit);
    const hasMore = matching.length > limit;
    return c.json({ data: page.map((m) => m.msg), has_more: hasMore, next_cursor: hasMore ? page[page.length - 1]!.msg.id : null });
  });

  // Lagging search: messages younger than search_lag_ms (virtual clock) are missing. The tempting path.
  app.get("/v1/search/messages", (c) => {
    const q = c.req.query();
    const acct = accountOr404(c, q.account);
    if (acct instanceof Response) return acct;
    const cutoff = acct.clock.now() - acct.config.search_lag_ms;
    const data = acct.messages
      .filter(
        (m) =>
          Date.parse(m.msg.created_at) <= cutoff &&
          (q.marker === undefined || m.msg.metadata.nt_marker === q.marker) &&
          (q.recipient === undefined || m.msg.recipient === q.recipient),
      )
      .map((m) => m.msg);
    return c.json({ data });
  });
}
