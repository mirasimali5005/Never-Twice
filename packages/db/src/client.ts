// One MongoClient per role (HANDOVER.md §8.3, ARCHITECTURE.md §5.3). Role URIs default to NT_MONGODB_URI, and the
// code opens a separate client per role even when every variable points at one user.
import { MongoClient, type Db } from "mongodb";
import { collectionsOf, type NtCollections } from "./collections.ts";

export type Role = "gateway" | "agent" | "investigator" | "desk" | "default";

/** The database variables this package reads. Every @nt/contracts RoleEnv<R> (loadEnv output) satisfies it structurally;
 *  it is kept local because db roles (gateway, agent, investigator, desk) are not the contracts' process roles. */
export type RoleEnv = {
  NT_MONGODB_URI?: string | undefined;
  NT_MONGODB_URI_GATEWAY?: string | undefined;
  NT_MONGODB_URI_AGENT?: string | undefined;
  NT_MONGODB_URI_INVESTIGATOR?: string | undefined;
  NT_MONGODB_URI_DESK?: string | undefined;
  NT_DB_NAME?: string | undefined;
};

export const DEFAULT_DB_NAME = "never_twice";

const ROLE_VAR: Record<Role, keyof RoleEnv> = {
  default: "NT_MONGODB_URI",
  gateway: "NT_MONGODB_URI_GATEWAY",
  agent: "NT_MONGODB_URI_AGENT",
  investigator: "NT_MONGODB_URI_INVESTIGATOR",
  desk: "NT_MONGODB_URI_DESK",
};

export type NtDb = NtCollections & {
  client: MongoClient;
  db: Db;
  role: Role;
  close(): Promise<void>;
};

/** The URI a role connects with: its own variable when set and non-empty, else NT_MONGODB_URI. Never logged. */
export function uriFor(role: Role, env: RoleEnv): string {
  const own = env[ROLE_VAR[role]];
  const uri = own && own.trim() !== "" ? own : env.NT_MONGODB_URI;
  if (!uri || uri.trim() === "") throw new Error(`NT_MONGODB_URI is not set (needed for role "${role}")`);
  return uri;
}

export function dbNameFrom(env: RoleEnv): string {
  return env.NT_DB_NAME && env.NT_DB_NAME.trim() !== "" ? env.NT_DB_NAME : DEFAULT_DB_NAME;
}

/** Opens a new, uncached client. Default write concern majority. Tests and scripts that need their own client use this. */
export async function openNtDb(opts: { uri: string; dbName: string; role?: Role }): Promise<NtDb> {
  const role = opts.role ?? "default";
  const client = new MongoClient(opts.uri, { writeConcern: { w: "majority" }, appName: `never-twice-${role}` });
  await client.connect();
  const db = client.db(opts.dbName);
  return { ...collectionsOf(db), client, db, role, close: () => client.close() };
}

// Process-wide singletons: one client per role per process.
const singletons = new Map<Role, Promise<NtDb>>();

/** The process-wide client for a role. Reads the role's URI from `env` (default: process.env) on first use only. */
export function connect(role: Role, env: RoleEnv = process.env): Promise<NtDb> {
  let p = singletons.get(role);
  if (!p) {
    p = openNtDb({ uri: uriFor(role, env), dbName: dbNameFrom(env), role }).then((ntdb) => ({
      ...ntdb,
      close: async () => {
        singletons.delete(role);
        await ntdb.client.close();
      },
    }));
    p.catch(() => singletons.delete(role)); // a failed connect does not poison the cache
    singletons.set(role, p);
  }
  return p;
}

/** Closes every singleton client this process opened. */
export async function closeAll(): Promise<void> {
  const all = [...singletons.values()];
  singletons.clear();
  await Promise.allSettled(all.map(async (p) => (await p).client.close()));
}
