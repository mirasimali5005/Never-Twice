// `.nt/` state: the current group, the history of seeded groups (what reset may delete), and the go file (HANDOVER §16).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goFile } from "./paths.ts";

export type CurrentGroup = {
  group_id: string;
  scenario: string;
  faults: string;
  runs: Record<string, string>; // arm -> run_id
  manifest_sha256: string;
  seeded_at: string;
};
export type GroupHistoryEntry = { group_id: string; scenario: string; run_ids: string[]; seeded_at: string };

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Atomic write (temp file then rename) so a process polling the file never reads half of it. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function readCurrent(ntDir: string): CurrentGroup | null {
  return readJson<CurrentGroup>(join(ntDir, "current.json"));
}
export function readHistory(ntDir: string): GroupHistoryEntry[] {
  return readJson<GroupHistoryEntry[]>(join(ntDir, "groups.json")) ?? [];
}
export function writeHistory(ntDir: string, history: GroupHistoryEntry[]): void {
  mkdirSync(ntDir, { recursive: true });
  writeJsonAtomic(join(ntDir, "groups.json"), history);
}

export function recordSeeded(ntDir: string, cur: CurrentGroup): void {
  mkdirSync(ntDir, { recursive: true });
  writeJsonAtomic(join(ntDir, "current.json"), cur);
  const history = readHistory(ntDir).filter((h) => h.group_id !== cur.group_id);
  history.push({ group_id: cur.group_id, scenario: cur.scenario, run_ids: Object.values(cur.runs), seeded_at: cur.seeded_at });
  writeHistory(ntDir, history);
}

/** Kill passengers a judge may choose (DEMO_RUNBOOK §3-4; HANDOVER §7.4). S0 has one valid target. */
export const KILL_TARGETS: Record<string, readonly string[]> = {
  S0: ["P02"],
  S1: ["P01", "P02", "P03", "P05", "P06", "P07"],
};

export function writeGoFile(ntDir: string, groupId: string, killAt: string | null): string {
  mkdirSync(ntDir, { recursive: true });
  const path = goFile(ntDir, groupId);
  writeJsonAtomic(path, killAt === null ? {} : { kill_at_passenger: killAt });
  return path;
}

export function removeGoFiles(ntDir: string): string[] {
  if (!existsSync(ntDir)) return [];
  const removed: string[] = [];
  for (const f of readdirSync(ntDir)) {
    if (/^go-.*\.json$/.test(f)) {
      rmSync(join(ntDir, f), { force: true });
      removed.push(f);
    }
  }
  return removed;
}
