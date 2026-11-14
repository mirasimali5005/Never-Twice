// The two permitted reads of evaluator/out from outside evaluator/ (ARCHITECTURE.md section 9):
//   <run_id>.certificate.json    -> GET /api/runs/:run_id/certificate, returned unchanged
//   <group_id>.commitment.json   -> GET /api/groups/:group_id, only `sha256` and `committed_at`
// Read-only: nothing here writes, renames or deletes. Never reads evaluator/hidden or the manifest.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GROUP_ID_RE, RUN_ID_RE } from "@nt/contracts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** <repo>/evaluator/out, relative to apps/desk-api/src. */
export const DEFAULT_EVALUATOR_OUT = path.resolve(HERE, "..", "..", "..", "evaluator", "out");

export type FileRead<T> = { kind: "found"; value: T } | { kind: "absent" } | { kind: "unreadable" };

async function readText(file: string): Promise<FileRead<string>> {
  try {
    return { kind: "found", value: await readFile(file, "utf8") };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
  }
}

/** The certificate's exact text (validated to be JSON, not re-serialised). The id is checked against its pattern first. */
export async function readCertificate(outDir: string, runId: string): Promise<FileRead<string>> {
  if (!RUN_ID_RE.test(runId)) return { kind: "absent" };
  const r = await readText(path.join(outDir, `${runId}.certificate.json`));
  if (r.kind !== "found") return r;
  try {
    JSON.parse(r.value);
  } catch {
    return { kind: "unreadable" };
  }
  return r;
}

export type Commitment = { manifest_sha256: string; manifest_committed_at: string };

/** Only `sha256` and `committed_at` of the commitment file; anything malformed counts as unreadable. */
export async function readCommitment(outDir: string, groupId: string): Promise<FileRead<Commitment>> {
  if (!GROUP_ID_RE.test(groupId)) return { kind: "absent" };
  const r = await readText(path.join(outDir, `${groupId}.commitment.json`));
  if (r.kind !== "found") return r;
  try {
    const j = JSON.parse(r.value) as { sha256?: unknown; committed_at?: unknown };
    if (typeof j.sha256 === "string" && /^[0-9a-f]{64}$/.test(j.sha256) && typeof j.committed_at === "string") {
      return { kind: "found", value: { manifest_sha256: j.sha256, manifest_committed_at: j.committed_at } };
    }
  } catch {
    /* fall through */
  }
  return { kind: "unreadable" };
}
