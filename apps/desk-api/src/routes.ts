// Every endpoint of ARCHITECTURE.md section 9. GET only: any other method is 405. Path parameters are validated against the
// identifier patterns first; an id that does not match is simply unknown (404). Errors never carry a stack, a query or a key.
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { EFFECT_KEY_RE, GROUP_ID_RE, RUN_ID_RE } from "@nt/contracts";
import { readCertificate, readCommitment } from "./certificate-file.ts";
import type { DatabaseKind } from "./env.ts";
import { ProviderUnreachable, readStatement, type ProviderStatement, type SimAccess } from "./provider-statement.ts";
import {
  BASELINE_ARMS,
  baselineTrail,
  claimCase,
  claimRows,
  getRun,
  groupView,
  paymentRows,
  paymentTrail,
  pool,
  runSummary,
  type DeskCollections,
  type RunRow,
} from "./read-model.ts";
import { auditStream, type SseOptions } from "./sse.ts";

export type DeskDeps = {
  cols: DeskCollections;
  sim: SimAccess;
  /** Directory holding <run_id>.certificate.json and <group_id>.commitment.json. */
  evaluatorOut: string;
  /** Banner "Recorded run": this process serves a recorded run from disk. */
  recorded: boolean;
  /** Which database this process reads (derived from the connection host; never the URI). Omitted: the group view does not say. */
  database?: DatabaseKind;
  now?: () => Date;
  sse?: SseOptions;
};
export type DepsSource = DeskDeps | (() => Promise<DeskDeps>);

export const CORS_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const CLAIM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

const notFound = (c: Context, error: string) => c.json({ error }, 404);

function isDatabaseError(e: unknown): boolean {
  const name = e instanceof Error ? e.name : "";
  return /^Mongo/.test(name) || /^(MongoServer|MongoNetwork|MongoNotConnected)/.test(name) || (e as { code?: unknown } | null)?.code === "ECONNREFUSED";
}

export function createApp(source: DepsSource): Hono {
  const app = new Hono();
  let cached: Promise<DeskDeps> | null = null;
  const deps = (): Promise<DeskDeps> => {
    if (typeof source !== "function") return Promise.resolve(source);
    cached ??= source().catch((e) => {
      cached = null; // a failed connect is retried on the next request
      throw e;
    });
    return cached;
  };

  app.use("*", cors({ origin: CORS_ORIGINS, allowMethods: ["GET"], maxAge: 600 }));
  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  });

  app.onError((e, c) => {
    // No stack, no message: a driver error can name a host or a user.
    if (isDatabaseError(e)) return c.json({ error: "DATABASE_UNAVAILABLE" }, 503);
    return c.json({ error: "INTERNAL_ERROR" }, 500);
  });

  /** Validates the run id, loads the run, hands both to the handler. Unknown run: 404 UNKNOWN_RUN. */
  const withRun =
    (handler: (c: Context, d: DeskDeps, run: RunRow) => Promise<Response> | Response) =>
    async (c: Context): Promise<Response> => {
      const runId = c.req.param("run_id") ?? "";
      if (!RUN_ID_RE.test(runId)) return notFound(c, "UNKNOWN_RUN");
      const d = await deps();
      const run = await getRun(d.cols, runId);
      if (!run) return notFound(c, "UNKNOWN_RUN");
      return handler(c, d, run);
    };

  app.get("/api/groups/:group_id", async (c) => {
    const groupId = c.req.param("group_id");
    if (!GROUP_ID_RE.test(groupId)) return notFound(c, "UNKNOWN_GROUP");
    const d = await deps();
    const view = await groupView(d.cols, groupId, d.recorded);
    if (!view) return notFound(c, "UNKNOWN_GROUP");
    // Addition to section 9: the pre-run commitment, so the screen can show the manifest hash before any audit exists.
    const commitment = await readCommitment(d.evaluatorOut, groupId);
    // Additions: `database` (the screen shows LOCAL DATABASE when it is not the Atlas sandbox) and, per run, `audited` (a certificate
    // file exists), so the screen asks for a certificate only when there is one instead of polling a 404.
    const runs = await Promise.all(
      view.runs.map(async (r) => ({ ...r, audited: (await readCertificate(d.evaluatorOut, r.run_id)).kind !== "absent" })),
    );
    const out = { ...view, runs, ...(d.database ? { database: d.database } : {}) };
    return c.json(commitment.kind === "found" ? { ...out, ...commitment.value } : out);
  });

  app.get("/api/runs/:run_id/summary", withRun(async (c, d, run) => c.json(await runSummary(d.cols, run))));

  app.get("/api/runs/:run_id/claims", withRun(async (c, d, run) => c.json(await claimRows(d.cols, run._id))));

  app.get(
    "/api/runs/:run_id/claims/:claim_id",
    withRun(async (c, d, run) => {
      const claimId = c.req.param("claim_id") ?? "";
      if (!CLAIM_ID_RE.test(claimId)) return notFound(c, "UNKNOWN_CLAIM");
      const found = await claimCase(d.cols, run._id, claimId);
      return found ? c.json(found) : notFound(c, "UNKNOWN_CLAIM");
    }),
  );

  app.get("/api/runs/:run_id/payments", withRun(async (c, d, run) => c.json(await paymentRows(d.cols, run))));

  app.get(
    "/api/runs/:run_id/payments/:effect_key",
    withRun(async (c, d, run) => {
      const effectKey = c.req.param("effect_key") ?? "";
      if (!EFFECT_KEY_RE.test(effectKey)) return notFound(c, "UNKNOWN_PAYMENT");
      if (BASELINE_ARMS.has(run.arm)) {
        let statement: ProviderStatement | null = null;
        try {
          statement = await readStatement(d.sim, run._id, run.sim_account, d.now ?? (() => new Date()));
        } catch (e) {
          if (!(e instanceof ProviderUnreachable)) throw e; // the trail is still built from the baseline's own records
        }
        const trail = await baselineTrail(d.cols, run, effectKey, statement);
        return trail ? c.json(trail) : notFound(c, "UNKNOWN_PAYMENT");
      }
      const trail = await paymentTrail(d.cols, run, effectKey);
      return trail ? c.json(trail) : notFound(c, "UNKNOWN_PAYMENT");
    }),
  );

  app.get(
    "/api/runs/:run_id/provider-statement",
    withRun(async (c, d, run) => {
      try {
        return c.json(await readStatement(d.sim, run._id, run.sim_account, d.now ?? (() => new Date())));
      } catch (e) {
        if (e instanceof ProviderUnreachable) return c.json({ error: "PROVIDER_UNREACHABLE" }, 502);
        throw e;
      }
    }),
  );

  app.get(
    "/api/runs/:run_id/pool",
    withRun(async (c, d, run) => {
      const p = await pool(d.cols, run);
      return p ? c.json(p) : notFound(c, "NO_POOL");
    }),
  );

  app.get(
    "/api/runs/:run_id/certificate",
    withRun(async (c, d, run) => {
      const r = await readCertificate(d.evaluatorOut, run._id);
      if (r.kind === "absent") return c.json({ status: "NOT_AUDITED" }, 404);
      if (r.kind === "unreadable") return c.json({ error: "CERTIFICATE_UNREADABLE" }, 503);
      return c.body(r.value, 200, { "Content-Type": "application/json; charset=UTF-8" }); // the file's own bytes, unchanged
    }),
  );

  app.get(
    "/api/runs/:run_id/events",
    withRun((c, d, run) => auditStream(c, d.cols, run._id, d.sse)),
  );

  app.all("*", (c) =>
    c.req.method === "GET" || c.req.method === "HEAD" ? c.json({ error: "NOT_FOUND" }, 404) : c.json({ error: "METHOD_NOT_ALLOWED" }, 405),
  );
  return app;
}
