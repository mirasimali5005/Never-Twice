// Shared HTTP helpers: the per-request context, error bodies, and the "no response" behaviour.
import type { Context } from "hono";
import type { AccountState, Store } from "./ledger.ts";

export const SIM_HEADER = "never-twice-provider-sim";

export type RC = {
  method: string;
  pathname: string;
  search: string;
  key: string | null; // Idempotency-Key header as received
  raw: Uint8Array | null;
  bodySha: string | null;
  acct: AccountState | null;
  logged: boolean;
  /** Write the request-log line (once). status null = no response was sent. */
  log(outcome: string, status: number | null, fault?: string | null): void;
};

export type Env = { Variables: { rc: RC; store: Store } };
export type Ctx = Context<Env>;

export function fail(c: Ctx, status: number, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status as 400);
}

/**
 * "No response": the handler leaves the request unanswered and keeps the socket open until the client gives up
 * (the client times out; if it aborts, the connection is closed by the client). The promise never resolves.
 */
export function hang(): Promise<Response> {
  return new Promise<Response>(() => {});
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
