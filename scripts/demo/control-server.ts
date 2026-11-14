// pnpm demo:control  -> a tiny local HTTP server (127.0.0.1:4030) that lets the presenter trigger the existing demo scripts from the desk page.
// It only spawns the same `pnpm demo:*` scripts a presenter types in a terminal; it reads nothing from the database and never changes a result.
// One action at a time (a second POST while one runs gets 409). CORS only for the desk UI on port 5173.
// Output tails never carry a line that looks like a connection string or a Stripe key.
//
//   POST /control/go {passenger:"P02"}  -> pnpm demo:go -- --kill-at P02
//   POST /control/resume                -> pnpm demo:resume
//   POST /control/audit                 -> pnpm demo:audit
//   POST /control/late-commit           -> pnpm demo:late-commit
//   POST /control/reset                 -> pnpm demo:reset -- --scenario S0, then pnpm demo:start; returns the new group_id
//   GET  /control/status                -> { running, started_at, last }
//
// NT_CONTROL_ROOT (optional) points at the checkout whose scripts and `.nt/` to use; it defaults to this repository's root.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Action = "go" | "resume" | "audit" | "late-commit" | "reset";
export type Spawner = (args: string[], onLine: (line: string) => void) => Promise<number>;
export type LastRun = { action: Action; ok: boolean; exit_code: number | null; started_at: string; ended_at: string; tail: string[]; group_id?: string | null };

export const PORT = 4030;
export const ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const PASSENGER = /^P\d{2}$/;
const SECRETISH = /mongodb(\+srv)?:\/\/|sk_test|rk_test|sk_live|rk_live/i;
const TAIL = 20;

/** Validates a request and returns the pnpm argument lists to run in order, or an error message. */
export function plan(action: string, body: unknown): { steps: string[][] } | { error: string } {
  switch (action) {
    case "go": {
      const p = body && typeof body === "object" ? (body as { passenger?: unknown }).passenger : undefined;
      if (typeof p !== "string" || !PASSENGER.test(p)) return { error: "passenger must match /^P\\d{2}$/" };
      return { steps: [["demo:go", "--", "--kill-at", p]] };
    }
    case "resume":
      return { steps: [["demo:resume"]] };
    case "audit":
      return { steps: [["demo:audit"]] };
    case "late-commit":
      return { steps: [["demo:late-commit"]] };
    case "reset":
      return { steps: [["demo:reset", "--", "--scenario", "S0"], ["demo:start"]] };
    default:
      return { error: `unknown action ${action}` };
  }
}

export function cleanLine(line: string): string | null {
  const l = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\s+$/, "");
  if (l.length === 0 || SECRETISH.test(l)) return null;
  return l;
}

export const pnpmSpawner = (root: string): Spawner => (args, onLine) =>
  new Promise((done) => {
    const child = spawn("pnpm", args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = { out: "", err: "" };
    const feed = (k: "out" | "err") => (chunk: Buffer) => {
      buf[k] += chunk.toString("utf8");
      const parts = buf[k].split(/\r?\n/);
      buf[k] = parts.pop() ?? "";
      for (const p of parts) onLine(p);
    };
    child.stdout.on("data", feed("out"));
    child.stderr.on("data", feed("err"));
    child.on("error", (e) => {
      onLine(`spawn failed: ${e.message}`);
      done(127);
    });
    child.on("close", (code) => {
      if (buf.out) onLine(buf.out);
      if (buf.err) onLine(buf.err);
      buf = { out: "", err: "" };
      done(code ?? 1);
    });
  });

export function readGroupId(root: string): string | null {
  try {
    const cur = JSON.parse(readFileSync(join(root, ".nt", "current.json"), "utf8")) as { group_id?: unknown };
    return typeof cur.group_id === "string" ? cur.group_id : null;
  } catch {
    return null;
  }
}

export function createControl(opts: { spawner: Spawner; groupId: () => string | null; now?: () => Date }) {
  const now = opts.now ?? (() => new Date());
  let running: { action: Action; started_at: string; tail: string[] } | null = null;
  let last: LastRun | null = null;

  /** Starts an action. Returns 409 while another runs; otherwise resolves when the scripts end. */
  async function run(action: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const p = plan(action, body);
    if ("error" in p) return { status: 400, body: { error: p.error } };
    if (running) return { status: 409, body: { error: `busy: ${running.action} is running`, running: running.action } };
    const cur = { action: action as Action, started_at: now().toISOString(), tail: [] as string[] };
    running = cur;
    let code = 0;
    try {
      for (const step of p.steps) {
        cur.tail.push(`$ pnpm ${step.join(" ")}`);
        code = await opts.spawner(step, (line) => {
          const l = cleanLine(line);
          if (l === null) return;
          cur.tail.push(l);
          if (cur.tail.length > 200) cur.tail.splice(0, cur.tail.length - 200);
        });
        if (code !== 0) break;
      }
    } catch (e) {
      cur.tail.push(`failed: ${(e as Error).message}`);
      code = 1;
    } finally {
      running = null;
    }
    last = {
      action: cur.action,
      ok: code === 0,
      exit_code: code,
      started_at: cur.started_at,
      ended_at: now().toISOString(),
      tail: cur.tail.slice(-TAIL),
      ...(cur.action === "reset" ? { group_id: code === 0 ? opts.groupId() : null } : {}),
    };
    return { status: 200, body: last };
  }

  function status() {
    return { running: running?.action ?? null, started_at: running?.started_at ?? null, running_tail: running ? running.tail.slice(-TAIL) : [], last };
  }
  return { run, status };
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export function makeServer(control: ReturnType<typeof createControl>): Server {
  return createServer((req, res) => {
    const origin = req.headers.origin;
    const token = process.env["NT_CONTROL_TOKEN"] ?? "";
    const keyed = token.length >= 16 && req.headers["x-nt-control-key"] === token;
    // Requests arriving through the public tunnel (proxied, no local origin) must carry the secret key.
    const viaProxy = Boolean(req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"]) || (origin !== undefined && !ALLOWED_ORIGINS.has(origin));
    if (viaProxy && !keyed) return send(req, res, 403, { error: "control key required" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") {
      if (origin) {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-NT-Control-Key");
        res.setHeader("Access-Control-Max-Age", "600");
      }
      return send(req, res, 204, {});
    }
    if (req.method === "GET" && url.pathname === "/control/status") return send(req, res, 200, control.status());
    const m = /^\/control\/([a-z-]+)$/.exec(url.pathname);
    if (req.method !== "POST" || !m) return send(req, res, req.method === "POST" || req.method === "GET" ? 404 : 405, { error: "not found" });
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString("utf8");
      if (raw.length > 4096) req.destroy();
    });
    req.on("end", () => {
      let body: unknown = {};
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          return send(req, res, 400, { error: "body is not JSON" });
        }
      }
      void control.run(m[1]!, body).then((r) => send(req, res, r.status, r.body));
    });
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = process.env.NT_CONTROL_ROOT ? resolve(process.env.NT_CONTROL_ROOT) : join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const control = createControl({ spawner: pnpmSpawner(root), groupId: () => readGroupId(root) });
  const server = makeServer(control);
  server.requestTimeout = 0; // an action can run for a minute or more; the response waits for it
  server.listen(PORT, "127.0.0.1", () => console.log(`demo controls on http://127.0.0.1:${PORT}/control/status (scripts run in ${root})`));
}
