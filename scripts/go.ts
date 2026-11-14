// pnpm demo:go -- --kill-at P02 [--group g...]  writes .nt/go-<group_id>.json; runners paused before payout then proceed.
import { parseArgs, runMain, UsageError } from "./lib/args.ts";
import { NT_DIR } from "./lib/paths.ts";
import { listPids } from "./lib/proc.ts";
import { KILL_TARGETS, readCurrent, writeGoFile } from "./lib/state.ts";

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
  const path = writeGoFile(NT_DIR, group, kill);
  const runners = listPids(NT_DIR).filter((p) => p.name.startsWith("runner-"));
  console.log(`wrote ${path}${kill ? `  kill_at_passenger ${kill}` : "  (no kill)"}`);
  console.log(runners.length ? `runners: ${runners.map((r) => `${r.name}${r.alive ? "" : " (dead)"}`).join(", ")}` : "no runner pid files: start runners with `pnpm demo:start` (the go file waits for them)");
});
