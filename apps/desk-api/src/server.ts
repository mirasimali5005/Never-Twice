// Desk API process: Hono on 127.0.0.1:4020, read-only. Credentials held: NT_MONGODB_URI_DESK (the read-only nt_desk user) and
// NT_SIM_READ_KEY. Start: `pnpm desk` (with the UI) or `tsx --env-file-if-exists=.env apps/desk-api/src/server.ts`.
import { serve, type ServerType } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { connect } from "@nt/db";
import { DEFAULT_EVALUATOR_OUT } from "./certificate-file.ts";
import { DESK_HOST, DESK_PORT, databaseKind, loadDeskEnv, recordedFlag, type DeskEnv } from "./env.ts";
import { createApp, type DeskDeps } from "./routes.ts";

/** Deps from the validated environment; the database client opens on first use (a failed connect is retried per request). */
export function depsFromEnv(env: DeskEnv, recorded: boolean): () => Promise<DeskDeps> {
  return async () => {
    const db = await connect("desk", { NT_MONGODB_URI_DESK: env.NT_MONGODB_URI_DESK, NT_DB_NAME: env.NT_DB_NAME });
    return {
      cols: db,
      sim: { url: env.NT_SIM_URL, readKey: env.NT_SIM_READ_KEY },
      evaluatorOut: DEFAULT_EVALUATOR_OUT,
      recorded,
      database: databaseKind(env.NT_MONGODB_URI_DESK),
    };
  };
}

export function startServer(opts: { env: DeskEnv; recorded: boolean; port?: number; hostname?: string }): ServerType {
  const app = createApp(depsFromEnv(opts.env, opts.recorded));
  const hostname = opts.hostname ?? DESK_HOST;
  const port = opts.port ?? DESK_PORT;
  return serve({ fetch: app.fetch, port, hostname }, (info) => {
    process.stdout.write(`desk-api listening on http://${hostname}:${info.port} (read-only; db role desk; sim ${opts.env.NT_SIM_URL})\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer({ env: loadDeskEnv(), recorded: recordedFlag() });
}
