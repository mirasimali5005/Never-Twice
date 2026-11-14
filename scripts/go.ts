// pnpm demo:go -- --kill-at P02 [--group g...] [--no-watch]  writes .nt/go-<group_id>.json; runners paused before payout then proceed.
// Then watches the runners for up to 30 s: one line per dispatch, and `KILLED <arm> at <barrier>@<effect_key>` when a runner dies.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, runMain, UsageError } from "./lib/args.ts";
import { NT_DIR } from "./lib/paths.ts";
import { isAlive, listPids } from "./lib/proc.ts";
import { KILL_TARGETS, readCurrent, writeGoFile } from "./lib/state.ts";
import { LOG_DIR, secs, sleep } from "./demo/lib.ts";

const SHOW = /dispatch |attempt \d|INDETERMINATE|OUTCOME_UNKNOWN|kill armed|kill_at_passenger/;

await runMain(async () => {
  const a = parseArgs(process.argv.slice(2), ["kill-at", "group"]);
  const cur = readCurrent(NT_DIR);
  const group = a.values.get("group") ?? cur?.group_id;
  if (!group) throw new UsageError("no current group: run `pnpm demo:reset -- --scenario S0|S1` first (or pass --group)");
  const scenario = cur && cur.group_id === group ? cur.scenario : (a.values.get("scenario") ?? "S1");
  const kill = a.values.get("kill-at") ?? null;
  if (kill !== null) {
    const allowed = KILL_TARGETS[scenario] ?? [];
    if (!allowed.includes(kill)) throw new UsageError(`--kill-at ${kill} is not a valid kill target for ${scenario}; choose one of ${allowed.join(", ")}`);
  } else {
    console.error("warning: no --kill-at: payouts run with no kill (rehearsal only)");
  }
  const runners = listPids(NT_DIR).filter((p) => p.name.startsWith("runner-"));
  const offsets = new Map(runners.map((r) => [r.name, existsSync(join(LOG_DIR, `${r.name}.log`)) ? statSync(join(LOG_DIR, `${r.name}.log`)).size : 0]));
  const t0 = Date.now();
  const path = writeGoFile(NT_DIR, group, kill);
  console.log(`wrote ${path}${kill ? `  kill_at_passenger ${kill}` : "  (no kill)"}`);
  console.log(runners.length ? `runners: ${runners.map((r) => `${r.name}${r.alive ? "" : " (dead)"}`).join(", ")}` : "no runner pid files: start runners with `pnpm demo:start` (the go file waits for them)");
  if (a.flags.has("no-watch") || runners.length === 0) return;

  const specs = new Map<string, string>();
  const gone = new Set<string>();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && gone.size < runners.length) {
    for (const r of runners) {
      const file = join(LOG_DIR, `${r.name}.log`);
      if (existsSync(file)) {
        const text = readFileSync(file, "utf8");
        const from = offsets.get(r.name) ?? 0;
        const chunk = text.slice(from);
        const lastNl = chunk.lastIndexOf("\n");
        if (lastNl >= 0) {
          offsets.set(r.name, from + lastNl + 1);
          for (const line of chunk.slice(0, lastNl).split("\n")) {
            const m = /(?:NT_CRASH_AT=|kill armed: )(\S+)/.exec(line);
            if (m) specs.set(r.name, m[1]!);
            if (SHOW.test(line)) console.log(`${r.name.replace("runner-", "").padEnd(9)} ${line.replace(/^\[[^\]]*\]\s*/, "")}`);
          }
        }
      }
      if (!gone.has(r.name) && !isAlive(r.pid)) {
        gone.add(r.name);
        const arm = r.name.replace("runner-", "");
        const spec = specs.get(r.name);
        console.log(spec && kill ? `\n  KILLED ${arm} at ${spec}   (${secs(Date.now() - t0)} after Enter)\n` : `${arm}: runner exited (${secs(Date.now() - t0)} after Enter)`);
      }
    }
    await sleep(200);
  }
  if (gone.size < runners.length) console.log(`warning: ${runners.length - gone.size} runner(s) still alive after 30 s`);
  else if (kill) console.log(`all ${runners.length} runners down; next: pnpm demo:resume`);
});
