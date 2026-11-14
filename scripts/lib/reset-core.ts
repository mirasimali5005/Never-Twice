// Reset: stop leftover runner and reconciler processes, delete go files, delete the documents of previous groups
// (never drops a database or a collection: the sandbox user may not), reset their simulator accounts.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NtDb } from "../../packages/db/src/index.ts";
import { REPORTS_DIR } from "./paths.ts";
import { stopProcesses } from "./proc.ts";
import type { SimAdmin } from "./sim-admin.ts";
import { readHistory, removeGoFiles, writeHistory } from "./state.ts";
import { simAccountOf } from "./ids.ts";

export type ResetResult = { stopped: string[]; go_files_removed: string[]; groups: string[]; run_ids: string[]; deleted: Record<string, number>; sim_reset: string[]; sim_errors: string[] };

export async function resetPrevious(deps: {
  db: NtDb;
  sim: SimAdmin | null;
  ntDir: string;
  reportsDir?: string;
  /** Delete every run-bearing document in the database, not only the groups this checkout seeded. */
  allGroups?: boolean;
  log?: (line: string) => void;
}): Promise<ResetResult> {
  const log = deps.log ?? (() => {});
  const stopped = await stopProcesses(deps.ntDir, (n) => /^(runner|reconciler)(-|$)/.test(n));
  const go = removeGoFiles(deps.ntDir);

  const history = readHistory(deps.ntDir);
  let groups = history.map((h) => h.group_id);
  let runIds = history.flatMap((h) => h.run_ids);
  if (deps.allGroups) {
    const all = await deps.db.runs.find({}, { projection: { group_id: 1 } }).toArray();
    groups = [...new Set([...groups, ...all.map((r) => r.group_id)])];
    runIds = [...new Set([...runIds, ...all.map((r) => r._id)])];
  } else {
    // Runs registered in the database under a recorded group but missing from the history file.
    const found = await deps.db.runs.find({ group_id: { $in: groups } }, { projection: { _id: 1 } }).toArray();
    runIds = [...new Set([...runIds, ...found.map((r) => r._id)])];
  }

  const deleted: Record<string, number> = {};
  if (runIds.length > 0) {
    const byRun = { run_id: { $in: runIds } };
    const c = deps.db;
    deleted.audit_events = (await c.audit.deleteMany(byRun)).deletedCount;
    deleted.investigation_records = (await c.investigations.deleteMany(byRun)).deletedCount;
    deleted.payment_intents = (await c.intents.deleteMany(byRun)).deletedCount;
    deleted.obligations = (await c.obligations.deleteMany(byRun)).deletedCount;
    deleted.claims = (await c.claims.deleteMany(byRun)).deletedCount;
    deleted.bookings = (await c.bookings.deleteMany(byRun)).deletedCount;
    deleted.authority_grants = (await c.grants.deleteMany(byRun)).deletedCount;
    deleted.execution_runs = (await c.runs.deleteMany({ $or: [{ _id: { $in: runIds } }, { group_id: { $in: groups } }] })).deletedCount;
  }
  log(`deleted documents of ${runIds.length} run(s) in ${groups.length} group(s): ${JSON.stringify(deleted)}`);

  const sim_reset: string[] = [];
  const sim_errors: string[] = [];
  if (deps.sim) {
    for (const id of runIds) {
      try {
        await deps.sim.resetAccount(simAccountOf(id));
        sim_reset.push(simAccountOf(id));
      } catch (e) {
        sim_errors.push(`${simAccountOf(id)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const reports = deps.reportsDir ?? REPORTS_DIR;
  for (const id of runIds) {
    const f = join(reports, `${id}.final-report.json`);
    if (existsSync(f)) rmSync(f, { force: true });
  }
  rmSync(join(deps.ntDir, "current.json"), { force: true });
  if (deps.allGroups) writeHistory(deps.ntDir, []);
  else writeHistory(deps.ntDir, history.filter((h) => !groups.includes(h.group_id)));

  return { stopped, go_files_removed: go, groups, run_ids: runIds, deleted, sim_reset, sim_errors };
}
