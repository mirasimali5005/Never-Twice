// pnpm demo:replay [--group g...] [--speed 1] [--take-over]
// Serves a run recorded by `pnpm demo:record` (out/recordings/<group_id>/desk.jsonl) on 127.0.0.1:4020 with the desk API's routes, read-only,
// with the group view marked recorded: true (the UI's "Recorded run" label; same effect as NT_DESK_RECORDED=true). Needs no database,
// simulator, model call or network. The recorded timeline plays from the first request for the group view (the UI loading); GET /replay/restart
// starts it again. `--take-over` stops the `pnpm desk` that demo:start launched (API and UI), then starts the UI against this server.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs, runMain, UsageError } from "../lib/args.ts";
import { NT_DIR, ROOT } from "../lib/paths.ts";
import { isAlive, listPids, removePid, startDetached } from "../lib/proc.ts";
import { DESK_API, DESK_URL, LOG_DIR, sleep } from "./lib.ts";

type Rec = { t: number; path: string; status: number; body: unknown };

function latestGroup(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const groups = readdirSync(dir)
    .filter((g) => existsSync(join(dir, g, "desk.jsonl")))
    .sort((x, y) => statSync(join(dir, y, "desk.jsonl")).mtimeMs - statSync(join(dir, x, "desk.jsonl")).mtimeMs);
  return groups[0] ?? null;
}

async function busy(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

await runMain(async () => {
  const a = parseArgs(process.argv.slice(2), ["group", "speed", "port"]);
  const root = join(ROOT, "out", "recordings");
  const group = a.values.get("group") ?? latestGroup(root);
  if (!group) throw new UsageError("no recording under out/recordings/: run `pnpm demo:record` (or `demo:record -- --drive`) during a run first");
  const file = join(root, group, "desk.jsonl");
  if (!existsSync(file)) throw new UsageError(`no recording for group ${group} (${file})`);
  const speed = Number(a.values.get("speed") ?? 1);
  const port = Number(a.values.get("port") ?? 4020);
  const meta = existsSync(join(root, group, "meta.json")) ? (JSON.parse(readFileSync(join(root, group, "meta.json"), "utf8")) as { recorded_at?: string; scenario?: string }) : {};

  const byPath = new Map<string, Rec[]>();
  let lastT = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Rec;
    (byPath.get(r.path) ?? byPath.set(r.path, []).get(r.path)!).push(r);
    lastT = Math.max(lastT, r.t);
  }
  if (byPath.size === 0) throw new UsageError(`${file} is empty`);

  if (await busy(`http://127.0.0.1:${port}/`)) {
    if (!a.flags.has("take-over")) {
      throw new UsageError(`port ${port} is in use (the live desk API?). Stop \`pnpm desk\` (Ctrl-C in its terminal; the UI stops with it), or re-run with --take-over to stop the one demo:start launched`);
    }
    const desk = listPids(NT_DIR).find((p) => p.name === "desk");
    if (!desk || !isAlive(desk.pid)) throw new UsageError(`port ${port} is in use by a process this script did not start: stop it yourself`);
    try {
      process.kill(-desk.pid, "SIGTERM"); // the whole process group: pnpm, concurrently, API, UI
    } catch {
      process.kill(desk.pid, "SIGTERM");
    }
    removePid(NT_DIR, "desk");
    for (let i = 0; i < 30 && (await busy(`http://127.0.0.1:${port}/`)); i++) await sleep(200);
    if (await busy(`http://127.0.0.1:${port}/`)) throw new UsageError(`port ${port} is still in use after stopping the desk`);
  }

  let clock: number | null = null; // wall time of the replay's t = 0
  const elapsed = () => (clock === null ? 0 : (Date.now() - clock) * speed);
  const pick = (path: string): Rec | null => {
    const list = byPath.get(path);
    if (!list) return null;
    const e = elapsed();
    let found = list[0]!;
    for (const r of list) {
      if (r.t <= e) found = r;
      else break;
    }
    return found;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { error: "METHOD_NOT_ALLOWED" });
    if (path === "/replay/restart") {
      clock = Date.now();
      return send(200, { restarted: true, group, recorded_at: meta.recorded_at ?? null, duration_ms: lastT });
    }
    if (path === "/") return send(200, { replay: true, group, recorded_at: meta.recorded_at ?? null, elapsed_ms: Math.round(elapsed()), duration_ms: lastT });
    if (/^\/api\/runs\/[^/]+\/events$/.test(path)) {
      // SSE: an `audit` event whenever any recorded response for this run changed since the last tick: a signal to refetch.
      const runId = path.split("/")[3]!;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
      res.write(": replay\n\n");
      let seen = elapsed();
      let n = 0;
      const timer = setInterval(() => {
        const now = elapsed();
        const changed = [...byPath].some(([p, l]) => p.includes(`/runs/${runId}/`) && l.some((r) => r.t > seen && r.t <= now));
        seen = now;
        if (changed) res.write(`id: ${++n}\nevent: audit\ndata: ${JSON.stringify({ _id: "", at: new Date().toISOString(), type: "REPLAY" })}\n\n`);
      }, 500);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (path.startsWith(`/api/groups/`) && clock === null) clock = Date.now();
    const rec = pick(path);
    if (!rec) return send(404, { error: "NOT_RECORDED" });
    let body = rec.body;
    if (/^\/api\/groups\/[^/]+$/.test(path) && body && typeof body === "object") body = { ...(body as object), recorded: true, recorded_at: meta.recorded_at ?? null };
    // An investigation record that was still open when it was captured (decision null) makes the desk UI's trail renderer throw and blank the
    // page (apps/desk-ui/src/trailSteps.ts decisionWords). Drop open records from the replayed trails; closed ones are served unchanged.
    if (/^\/api\/runs\/[^/]+\/payments\/[^/]+$/.test(path) && body && typeof body === "object" && Array.isArray((body as { investigations?: unknown }).investigations)) {
      const b = body as { investigations: { decision?: unknown }[] };
      body = { ...b, investigations: b.investigations.filter((i) => i.decision != null) };
    }
    return send(rec.status, body);
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok());
  });

  console.log(`RECORDED ${meta.recorded_at ?? "(time unknown)"}  group ${group}  scenario ${meta.scenario ?? "?"}  ${byPath.size} paths, ${(lastT / 1000).toFixed(0)} s of timeline, speed ${speed}x`);
  console.log(`serving the recording on http://127.0.0.1:${port} (read-only; no database, simulator or model)`);
  if (port === 4020 && !(await busy(`${DESK_URL}/`))) {
    const pid = startDetached({ ntDir: NT_DIR, name: "replay-ui", command: "pnpm", args: ["--filter", "@nt/desk-ui", "dev"], cwd: ROOT, logDir: LOG_DIR });
    console.log(`desk UI: started (pid ${pid})`);
    for (let i = 0; i < 60 && !(await busy(`${DESK_URL}/`)); i++) await sleep(250);
  }
  console.log(`\nDESK  ${DESK_URL}/?group=${group}   (the timeline starts when the page loads; ${DESK_API}/replay/restart starts it again)`);
  console.log("Ctrl-C stops the replay.");
  const done = new Promise<void>((r) => {
    process.on("SIGINT", r);
    process.on("SIGTERM", r);
  });
  await done;
  server.close();
  const ui = listPids(NT_DIR).find((p) => p.name === "replay-ui");
  if (ui && isAlive(ui.pid)) {
    try {
      process.kill(-ui.pid, "SIGTERM");
    } catch {
      /* gone */
    }
    removePid(NT_DIR, "replay-ui");
  }
});
