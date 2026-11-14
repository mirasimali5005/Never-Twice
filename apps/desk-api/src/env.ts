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

export type DatabaseKind = "atlas_sandbox" | "local";

/**
 * Which database the desk API reads, from the HOST of the connection string only (never returned: no user, password, host name or
 * query leaves this function). An Atlas cluster is `*.mongodb.net`; anything else (localhost, 127.0.0.1, a container name) is local.
 */
export function databaseKind(uri: string | undefined): DatabaseKind {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(uri ?? "");
  const hosts = (m?.[1] ?? "").split(",").map((h) => h.trim().toLowerCase().replace(/:\d+$/, ""));
  return hosts.length > 0 && hosts.every((h) => h.endsWith(".mongodb.net")) ? "atlas_sandbox" : "local";
}
