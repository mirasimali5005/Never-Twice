// pnpm demo:record [--for <seconds>] [--interval <ms>] [--group g...] [--drive [--late-commit]]
// Captures the desk API's GET responses for the current group into out/recordings/<group_id>/desk.jsonl while a run happens.
// One JSON line per CHANGED response: { t, path, status, body }, t = ms since the recording started. `pnpm demo:replay` serves them back.
//   plain:    start it after `demo:start`, run the demo in other terminals, press Ctrl-C (or wait for --for) when done.
//   --drive:  also runs `demo:go -- --kill-at P02`, `demo:resume`, `demo:audit` (and `demo:late-commit`) itself, then stops: a whole backup recording
//             from one command. Needs a freshly started group (`demo:reset`, `demo:start`).
// The recorder only issues GETs to the desk API; it reads no database and no key.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, runMain, UsageError } from "../lib/args.ts";
import { NT_DIR, ROOT } from "../lib/paths.ts";
import { readCurrent } from "../lib/state.ts";
import { DESK_API, TSX, runCmd, secs, sleep } from "./lib.ts";

type Json = Record<string, unknown> | unknown[] | null;

await runMain(async () => {
  const a = parseArgs(process.argv.slice(2), ["for", "interval", "group", "kill-at"]);
  const cur = readCurrent(NT_DIR);
  const group = a.values.get("group") ?? cur?.group_id;
  if (!group) throw new UsageError("no current group: run `pnpm demo:reset` and `pnpm demo:start` first");
  const intervalMs = Number(a.values.get("interval") ?? 1000);
  const maxMs = Number(a.values.get("for") ?? 900) * 1000;
  const drive = a.flags.has("drive");
  if (drive && cur?.group_id !== group) throw new UsageError("--drive works on the current group only");

  const dir = join(ROOT, "out", "recordings", group);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "desk.jsonl");
  const started = new Date();
  writeFileSync(file, "");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ group_id: group, scenario: cur?.scenario ?? null, recorded_at: started.toISOString(), source: "desk API " + DESK_API }, null, 2) + "\n");
  const t0 = Date.now();

  const last = new Map<string, string>();
  const known = { runs: [] as string[], claims: new Map<string, string[]>(), payments: new Map<string, string[]>() };
  let written = 0;
  async function capture(path: string): Promise<Json> {
    let status = 0;
    let body: Json = null;
    try {
      const res = await fetch(DESK_API + path, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
      status = res.status;
      const text = await res.text();
      try {
        body = JSON.parse(text) as Json;
      } catch {
        body = { _text: text.slice(0, 500) };
      }
    } catch (e) {
      status = 0;
      body = { error: e instanceof Error ? e.message : "NETWORK" };
    }
    if (status === 0) return null; // desk API unreachable: record nothing, try again next tick
    const sig = `${status}|${JSON.stringify(body)}`;
    if (last.get(path) !== sig) {
      last.set(path, sig);
      appendFileSync(file, JSON.stringify({ t: Date.now() - t0, path, status, body }) + "\n");
      written++;
    }
    return body;
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`recording group ${group} to ${file} (every ${intervalMs} ms; Ctrl-C to stop${drive ? "; driving the demo commands" : ""})`);

  let tick = 0;
  async function pollOnce(): Promise<void> {
    tick++;
    const g = (await capture(`/api/groups/${group}`)) as { runs?: { run_id: string }[] } | null;
    const runs = g?.runs?.map((r) => r.run_id) ?? known.runs;
    known.runs = runs;
    await Promise.all(
      runs.map(async (id) => {
        const base = `/api/runs/${id}`;
        const [claims, payments] = await Promise.all([capture(`${base}/claims`), capture(`${base}/payments`)]);
        await Promise.all([capture(`${base}/summary`), capture(`${base}/provider-statement`), capture(`${base}/pool`), capture(`${base}/certificate`)]);
        const claimIds = Array.isArray(claims) ? (claims as { claim_id?: string }[]).map((c) => c.claim_id).filter((x): x is string => !!x) : (known.claims.get(id) ?? []);
        const keys = Array.isArray(payments) ? (payments as { effect_key?: string }[]).map((c) => c.effect_key).filter((x): x is string => !!x) : (known.payments.get(id) ?? []);
        known.claims.set(id, claimIds);
        known.payments.set(id, keys);
        await Promise.all(keys.map((k) => capture(`${base}/payments/${k}`)));
        if (tick % 4 === 1) await Promise.all(claimIds.map((c) => capture(`${base}/claims/${c}`)));
      }),
    );
  }

  const loop = (async () => {
    while (!stopping && Date.now() - t0 < maxMs) {
      const s = Date.now();
      await pollOnce().catch(() => {});
      await sleep(Math.max(100, intervalMs - (Date.now() - s)));
    }
  })();

  if (drive) {
    const step = async (label: string, args: string[]) => {
      console.log(`\n--- ${label} ---`);
      await sleep(2000);
      await runCmd({ command: TSX, args: ["--env-file-if-exists=.env", ...args], prefix: "" });
    };
    await sleep(3000); // a few frames of the paused, pre-kill state
    await step("demo:go", ["scripts/go.ts", "--kill-at", a.values.get("kill-at") ?? "P02"]);
    await step("demo:resume", ["scripts/demo/resume.ts"]);
    await step("demo:audit", ["scripts/demo/audit.ts", "--brief"]);
    if (a.flags.has("late-commit")) await step("demo:late-commit", ["scripts/demo/late-commit.ts"]);
    await sleep(4000); // let the last certificate frames land
    stopping = true;
  }
  await loop;
  console.log(`\nrecorded ${written} changed responses over ${secs(Date.now() - t0)} -> ${file}`);
});
