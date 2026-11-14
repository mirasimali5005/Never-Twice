// Environment of the desk API. The process holds exactly two credentials: the read-only database user and the simulator read key.
// Validation is the desk-api role of @nt/contracts, which drops every other variable (no write key, no model key, no admin key).
import { parseEnv, type RoleEnv } from "@nt/contracts";

export type DeskEnv = RoleEnv<"desk-api">;

export const DESK_PORT = 4020;
export const DESK_HOST = "127.0.0.1";

/** Exits the process with the variable names (never values) when the environment is not valid. */
export function loadDeskEnv(source: Record<string, string | undefined> = process.env): DeskEnv {
  const r = parseEnv("desk-api", source);
  if (!r.ok) {
    process.stderr.write(`desk-api: environment invalid:\n${r.errors.map((e) => `  ${e}`).join("\n")}\n`);
    process.exit(1);
  }
  return r.env;
}

/** `true` when this process serves a recorded run from disk (the banner "Recorded run" in the UI). Not a secret. */
export function recordedFlag(source: Record<string, string | undefined> = process.env): boolean {
  return source["NT_DESK_RECORDED"] === "true";
}
