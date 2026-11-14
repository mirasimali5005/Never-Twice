// pnpm demo:reset -- --scenario S1 [--arms nt,control,nt_mutant] [--faults F-DEMO] [--no-seed] [--all-groups --yes-sandbox]
// Stops leftover runner/reconciler processes, deletes go files and the previous groups' documents, resets their simulator accounts, then seeds.
import { parseArgs, runMain, UsageError } from "./lib/args.ts";
import { dbLabel, openOwnerDb, openSimAdmin } from "./lib/env.ts";
import { NT_DIR } from "./lib/paths.ts";
import { resetPrevious } from "./lib/reset-core.ts";
import { parseArms } from "./lib/seed-core.ts";
import { readCurrent } from "./lib/state.ts";
import { printSeed, seedFromEnv } from "./seed.ts";

await runMain(async () => {
  const a = parseArgs(process.argv.slice(2), ["scenario", "arms", "faults"]);
  const scenario = a.values.get("scenario") ?? readCurrent(NT_DIR)?.scenario;
  if (!scenario && !a.flags.has("no-seed")) throw new UsageError("usage: pnpm demo:reset -- --scenario S0|S1");
  const allGroups = a.flags.has("all-groups");
  if (allGroups && process.env.NT_ENV === "sandbox" && !a.flags.has("yes-sandbox")) {
    throw new UsageError("--all-groups deletes every run in the sandbox database; add --yes-sandbox to confirm");
  }
  console.error(`database: ${dbLabel()}`);
  const sim = openSimAdmin();
  const simUp = await sim.healthy();
  if (!simUp) console.error("warning: provider simulator is not running: old accounts are not reset (new groups use new accounts)");
  const db = await openOwnerDb();
  try {
    const r = await resetPrevious({ db, sim: simUp ? sim : null, ntDir: NT_DIR, allGroups, log: (l) => console.error(l) });
    console.error(`stopped: ${r.stopped.join(", ") || "none"}; go files removed: ${r.go_files_removed.length}; simulator accounts reset: ${r.sim_reset.length}`);
    for (const e of r.sim_errors) console.error(`warning: ${e}`);
  } finally {
    await db.close();
  }
  if (a.flags.has("no-seed")) return;
  printSeed(await seedFromEnv({ scenario: scenario!, arms: parseArms(a.values.get("arms") ?? "nt,control,nt_mutant"), faults: a.values.get("faults") ?? "F-DEMO" }));
});
