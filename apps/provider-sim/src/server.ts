// Never Twice provider SIMULATOR. Not a real payment processor; labelled as a simulator in every response.
// Binds 127.0.0.1 on NT_SIM_PORT (default 4010). Keys: NT_SIM_WRITE_KEY, NT_SIM_READ_KEY,
// NT_SIM_EVAL_READ_KEY, NT_SIM_ADMIN_KEY (the process refuses to start if any is missing).
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "./canonical.ts";
import { authorized, classify, loadKeysFromEnv } from "./auth.ts";
import type { SimKeys } from "./auth.ts";
import { Store } from "./ledger.ts";
import type { AccountState } from "./ledger.ts";
import { SIM_HEADER, fail } from "./http.ts";
import type { Env, RC } from "./http.ts";
import { mountV1 } from "./payouts.ts";
import { mountAdmin } from "./admin.ts";
import { mountNotify } from "./notify.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = path.resolve(HERE, "..", "data");

/** Best-effort account for the request log: query, /v1/accounts/:a, object id, or the JSON body's account. */
function resolveAccount(rc: RC, store: Store): AccountState | null {
  if (rc.acct) return rc.acct;
  const q = new URLSearchParams(rc.search).get("account");
  if (q) return store.get(q) ?? null;
  const m = /^\/v1\/accounts\/([^/]+)$/.exec(rc.pathname);
  if (m) return store.get(decodeURIComponent(m[1]!)) ?? null;
  const o = /^\/v1\/payouts\/([^/]+)$/.exec(rc.pathname);
  if (o) return store.findObject(decodeURIComponent(o[1]!))?.acct ?? null;
  if (rc.raw) {
    try {
      const b = JSON.parse(Buffer.from(rc.raw).toString("utf8")) as { account?: unknown };
      if (b && typeof b.account === "string") return store.get(b.account) ?? null;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

export function createApp(opts: { store: Store; keys: SimKeys }): Hono<Env> {
  const { store, keys } = opts;
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    c.header("X-Simulator", SIM_HEADER);
    c.set("store", store);
    const url = new URL(c.req.url);
    const method = c.req.method;
    let raw: Uint8Array | null = null;
    if (method !== "GET" && method !== "HEAD") {
      const buf = new Uint8Array(await c.req.arrayBuffer());
      raw = buf.length > 0 ? buf : null;
    }
    const rc: RC = {
      method,
      pathname: url.pathname,
      search: url.search,
      key: c.req.header("Idempotency-Key") ?? null,
      raw,
      bodySha: raw ? sha256Hex(raw) : null,
      acct: null,
      logged: false,
      log(outcome, status, fault = null) {
        if (rc.logged) return;
        rc.logged = true;
        if (!rc.pathname.startsWith("/v1/")) return; // healthz and admin calls are not logged
        const acct = resolveAccount(rc, store);
        if (!acct) return;
        acct.appendRequest({
          method: rc.method,
          path: rc.pathname + (rc.method === "GET" ? rc.search : ""),
          idempotency_key: rc.key,
          body_sha256: rc.bodySha,
          fault,
          outcome,
          status,
        });
      },
    };
    c.set("rc", rc);

    if (!authorized(keys, classify(method, url.pathname), c.req.header("Authorization"))) {
      rc.log("UNAUTHORIZED", 401);
      return fail(c, 401, "unauthorized", "missing or invalid credential for this endpoint");
    }
    await next();
    if (!rc.logged) rc.log(method === "GET" || method === "HEAD" ? "READ" : "READ", c.res.status);
  });

  app.get("/healthz", (c) => c.json({ ok: true, simulator: true }));
  mountV1(app);
  mountAdmin(app);
  mountNotify(app, { store });

  app.notFound((c) => fail(c, 404, "not_found", "no such route"));
  app.onError((err, c) => {
    console.error("provider-sim internal error:", err instanceof Error ? err.message : String(err));
    return fail(c, 500, "internal", "simulator internal error");
  });
  return app;
}

export type RunningSim = { server: ServerType; port: number; store: Store; close(): Promise<void> };

export function startServer(opts: { port?: number; hostname?: string; dataDir?: string; keys: SimKeys }): Promise<RunningSim> {
  const store = new Store(opts.dataDir ?? DEFAULT_DATA_DIR);
  const app = createApp({ store, keys: opts.keys });
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 4010, hostname: opts.hostname ?? "127.0.0.1" }, (info) => {
      resolve({
        server,
        port: info.port,
        store,
        close: () =>
          new Promise<void>((res) => {
            for (const a of store.accounts.values()) {
              for (const h of a.held) if (h.timer) clearTimeout(h.timer);
            }
            // Requests deliberately left unanswered must not keep the process alive.
            (server as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
    server.on("error", reject);
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let keys: SimKeys;
  try {
    keys = loadKeysFromEnv();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  // Port: NT_SIM_PORT, else the port of NT_SIM_URL, else 4010.
  let port = Number(process.env.NT_SIM_PORT ?? "");
  if (!Number.isInteger(port) || port <= 0) {
    try {
      port = Number(new URL(process.env.NT_SIM_URL ?? "").port) || 4010;
    } catch {
      port = 4010;
    }
  }
  const dataDir = process.env.NT_SIM_DATA_DIR ? path.resolve(process.env.NT_SIM_DATA_DIR) : DEFAULT_DATA_DIR;
  const sim = await startServer({ port, dataDir, keys });
  console.log(`never-twice provider SIMULATOR (not a real processor) listening on http://127.0.0.1:${sim.port}; data ${dataDir}; accounts rebuilt: ${sim.store.accounts.size}`);
  const stop = () => void sim.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
