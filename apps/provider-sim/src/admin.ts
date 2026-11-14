// /admin/* routes (admin key only): accounts, fault schedule, release, virtual clock, reset, state hash, request log.
import type { Hono } from "hono";
import type { Ctx, Env } from "./http.ts";
import { fail } from "./http.ts";
import { ACCOUNT_NAME } from "./ledger.ts";
import type { AccountState } from "./ledger.ts";
import { parseFaults } from "./faults.ts";
import { releaseHeld } from "./payouts.ts";

async function jsonBody(c: Ctx): Promise<Record<string, unknown> | Response> {
  const raw = c.get("rc").raw;
  if (raw === null) return fail(c, 400, "invalid_request", "JSON body required");
  try {
    const v = JSON.parse(Buffer.from(raw).toString("utf8"));
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    return fail(c, 400, "invalid_request", "body must be a JSON object");
  }
}

function acctFrom(c: Ctx, name: unknown): AccountState | Response {
  if (typeof name !== "string" || name === "") return fail(c, 400, "invalid_request", "account is required");
  const a = c.get("store").get(name);
  return a ?? fail(c, 404, "not_found", `unknown account ${name}`);
}

export function mountAdmin(app: Hono<Env>): void {
  app.post("/admin/accounts", async (c) => {
    const b = await jsonBody(c);
    if (b instanceof Response) return b;
    if (typeof b.account !== "string" || !ACCOUNT_NAME.test(b.account)) {
      return fail(c, 400, "invalid_request", "account must match [A-Za-z0-9_.-]{1,80}");
    }
    const retention_ms = b.retention_ms === undefined ? 86_400_000 : b.retention_ms;
    const max_in_flight_ms = b.max_in_flight_ms === undefined ? null : b.max_in_flight_ms;
    const search_lag_ms = b.search_lag_ms === undefined ? 5000 : b.search_lag_ms;
    if (typeof retention_ms !== "number" || !Number.isSafeInteger(retention_ms) || retention_ms < 1) {
      return fail(c, 400, "invalid_request", "retention_ms must be an integer >= 1");
    }
    if (max_in_flight_ms !== null && (typeof max_in_flight_ms !== "number" || !Number.isSafeInteger(max_in_flight_ms) || max_in_flight_ms < 1)) {
      return fail(c, 400, "invalid_request", "max_in_flight_ms must be null or an integer >= 1");
    }
    if (typeof search_lag_ms !== "number" || !Number.isSafeInteger(search_lag_ms) || search_lag_ms < 0) {
      return fail(c, 400, "invalid_request", "search_lag_ms must be an integer >= 0");
    }
    const config = { account: b.account, retention_ms, max_in_flight_ms, search_lag_ms };
    const existing = c.get("store").get(b.account);
    if (existing) {
      const e = existing.config;
      if (e.retention_ms === retention_ms && e.max_in_flight_ms === max_in_flight_ms && e.search_lag_ms === search_lag_ms) {
        return c.json(config, 200); // repeating the same call is harmless
      }
      return fail(c, 409, "account_exists", "account exists with a different configuration; reset does not change it");
    }
    c.get("store").createAccount(config);
    return c.json(config, 201);
  });

  app.post("/admin/faults", async (c) => {
    const b = await jsonBody(c);
    if (b instanceof Response) return b;
    const acct = acctFrom(c, b.account);
    if (acct instanceof Response) return acct;
    const parsed = parseFaults(b.faults);
    if (!parsed.ok) return fail(c, 400, "invalid_request", parsed.message);
    acct.faults = parsed.faults; // replaces the schedule; counters start at times
    return c.json({ account: acct.config.account, installed: parsed.faults.length });
  });

  app.post("/admin/faults/release", async (c) => {
    const b = await jsonBody(c);
    if (b instanceof Response) return b;
    const acct = acctFrom(c, b.account);
    if (acct instanceof Response) return acct;
    if (b.payee_ref !== undefined && typeof b.payee_ref !== "string") return fail(c, 400, "invalid_request", "payee_ref must be a string");
    if (b.marker !== undefined && typeof b.marker !== "string") return fail(c, 400, "invalid_request", "marker must be a string");
    const released = releaseHeld(acct, { payee_ref: b.payee_ref as string | undefined, marker: b.marker as string | undefined });
    return c.json({ account: acct.config.account, released });
  });

  // Tier 3 (provider-side reversal): a paid object is later undone at the provider. Body { account, id, status?: "reversed"|"failed" }.
  app.post("/admin/payouts/reverse", async (c) => {
    const b = await jsonBody(c);
    if (b instanceof Response) return b;
    const acct = acctFrom(c, b.account);
    if (acct instanceof Response) return acct;
    if (typeof b.id !== "string" || b.id === "") return fail(c, 400, "invalid_request", "id is required");
    const status = b.status === undefined ? "reversed" : b.status;
    if (status !== "reversed" && status !== "failed") return fail(c, 400, "invalid_request", "status must be \"reversed\" or \"failed\"");
    const r = acct.reverseObject(b.id, status);
    if (r === "not_found") return fail(c, 404, "not_found", `no object ${b.id} in account ${acct.config.account}`);
    if (r === "not_paid") return fail(c, 409, "not_paid", `object ${b.id} is not paid`);
    return c.json(r);
  });

  app.post("/admin/clock/advance", async (c) => {
    const b = await jsonBody(c);
    if (b instanceof Response) return b;
    const acct = acctFrom(c, b.account);
    if (acct instanceof Response) return acct;
    if (typeof b.ms !== "number" || !Number.isSafeInteger(b.ms) || b.ms < 1) {
      return fail(c, 400, "invalid_request", "ms must be an integer >= 1 (the clock only increases)");
    }
    acct.advanceClock(b.ms);
    return c.json({ account: acct.config.account, offset_ms: acct.clock.offsetMs, virtual_now: acct.clock.nowIso() });
  });

  app.post("/admin/reset", async (c) => {
    const b = await jsonBody(c);
    if (b instanceof Response) return b;
    const acct = acctFrom(c, b.account);
    if (acct instanceof Response) return acct;
    acct.reset();
    return c.json({ account: acct.config.account, reset: true });
  });

  // Probe admission (Tier 3): plant a NotifySim message as ground truth in a scratch account. Admin key only; the planted message
  // is an ordinary ledger entry (message_created), so it counts in the state hash and is visible to the list at once.
  app.post("/admin/messages", async (c) => {
    const b = await jsonBody(c);
    if (b instanceof Response) return b;
    const acct = acctFrom(c, b.account);
    if (acct instanceof Response) return acct;
    if (typeof b.recipient !== "string" || b.recipient === "") return fail(c, 400, "invalid_request", "recipient is required");
    const template = typeof b.template === "string" && b.template !== "" ? b.template : "planted";
    const md = b.metadata ?? {};
    if (md === null || typeof md !== "object" || Array.isArray(md) || Object.values(md).some((v) => typeof v !== "string")) {
      return fail(c, 400, "invalid_request", "metadata must be an object of strings");
    }
    const amount = typeof b.amount_minor === "number" && Number.isSafeInteger(b.amount_minor) ? b.amount_minor : null;
    const currency = typeof b.currency === "string" ? b.currency : null;
    const msg = acct.commitMessage({ recipient: b.recipient, template, amount_minor: amount, currency, metadata: md as Record<string, string> });
    return c.json(msg, 201);
  });

  app.get("/admin/state-hash", (c) => {
    const acct = acctFrom(c, c.req.query("account"));
    if (acct instanceof Response) return acct;
    return c.json({ account: acct.config.account, ...acct.stateHash() });
  });

  app.get("/admin/request-log", (c) => {
    const acct = acctFrom(c, c.req.query("account"));
    if (acct instanceof Response) return acct;
    return c.json({ data: acct.requestLog });
  });
}
