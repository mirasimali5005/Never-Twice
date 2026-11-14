// Environment for the harness scripts (owner connection; HANDOVER §8.3). Run under `node --env-file-if-exists=.env`.
import { dbNameFrom, openNtDb, type NtDb, type Role } from "../../packages/db/src/index.ts";
import { SimAdmin } from "./sim-admin.ts";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`${name} is not set (put it in .env; see .env.example)`);
  return v;
}

export function dbLabel(): string {
  return process.env.NT_ENV === "sandbox" ? "Atlas sandbox" : "LOCAL DATABASE";
}

/** Owner connection by default (`seed`, `reset`); `role: "desk"` for the read-only terminal renderer. */
export async function openOwnerDb(role: Role = "default"): Promise<NtDb> {
  const uri = role === "desk" && process.env.NT_MONGODB_URI_DESK?.trim() ? process.env.NT_MONGODB_URI_DESK : requireEnv("NT_MONGODB_URI");
  return openNtDb({ uri, dbName: dbNameFrom(process.env), role });
}

export function simUrl(): string {
  return process.env.NT_SIM_URL?.trim() || "http://127.0.0.1:4010";
}

export function openSimAdmin(): SimAdmin {
  return new SimAdmin(simUrl(), requireEnv("NT_SIM_ADMIN_KEY"));
}
