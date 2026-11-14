// NotifySim (Tier 3, task C4). Stub: mounts no routes. Passes to C4.
import type { Hono } from "hono";
import type { Env } from "./http.ts";
import type { Store } from "./ledger.ts";

export function mountNotify(_app: Hono<Env>, _ctx: { store: Store }): void {}
