// Record/replay store for model responses (HANDOVER.md §5.1, ARCHITECTURE.md §6.7).
// One file per request: <NT_MODEL_CASSETTE_DIR>/<request_sha256>.json, shaped as the Cassette contract in @nt/contracts.
// No key, header or raw HTTP body is ever written: only the validated model output.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cassette, canonicalJson, sha256Hex } from "@nt/contracts";

/** sha256(model + prompt_version + canonicalJson(request)); the request carries no run id, timestamp or backend. */
export function requestSha256(model: string, promptVersion: string, request: unknown): string {
  return sha256Hex(model + promptVersion + canonicalJson(request));
}

export type CassetteRead =
  | { kind: "hit"; cassette: Cassette }
  | { kind: "miss"; detail: string }
  | { kind: "corrupt"; detail: string };

export class CassetteStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  path(sha: string): string {
    return join(this.dir, `${sha}.json`);
  }

  read(sha: string): CassetteRead {
    const file = this.path(sha);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "miss", detail: `no cassette ${sha} in ${this.dir}` };
      return { kind: "corrupt", detail: `cannot read ${file}: ${(e as Error).message}` };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: "corrupt", detail: `cassette ${file} is not valid JSON` };
    }
    const parsed = Cassette.safeParse(raw);
    if (!parsed.success) return { kind: "corrupt", detail: `cassette ${file} does not match the Cassette schema` };
    if (parsed.data.request_sha256 !== sha) return { kind: "corrupt", detail: `cassette ${file} carries a different request_sha256` };
    return { kind: "hit", cassette: parsed.data };
  }

  /** Temporary file then rename, so a reader never sees a half-written cassette. */
  write(c: Cassette): string {
    mkdirSync(this.dir, { recursive: true });
    const file = this.path(c.request_sha256);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return file;
  }
}
