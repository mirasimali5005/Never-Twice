// Bearer-key authentication. Keys come from the environment at start; they are never logged.
import { createHash, timingSafeEqual } from "node:crypto";

export type SimKeys = { write: string; read: string; evalRead: string; admin: string };
export type AuthClass = "none" | "admin" | "write" | "read";

export function loadKeysFromEnv(env: Record<string, string | undefined> = process.env): SimKeys {
  const names = ["NT_SIM_WRITE_KEY", "NT_SIM_READ_KEY", "NT_SIM_EVAL_READ_KEY", "NT_SIM_ADMIN_KEY"] as const;
  const missing = names.filter((n) => !env[n] || env[n]!.trim() === "");
  if (missing.length > 0) {
    throw new Error(`provider-sim refuses to start: missing ${missing.join(", ")}`);
  }
  return {
    write: env.NT_SIM_WRITE_KEY!,
    read: env.NT_SIM_READ_KEY!,
    evalRead: env.NT_SIM_EVAL_READ_KEY!,
    admin: env.NT_SIM_ADMIN_KEY!,
  };
}

/** Which credential class an endpoint needs. */
export function classify(method: string, pathname: string): AuthClass {
  if (pathname === "/healthz") return "none";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin";
  if (pathname.startsWith("/v1/")) {
    return method === "GET" || method === "HEAD" ? "read" : "write";
  }
  return "none"; // unknown paths fall through to 404
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function same(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function bearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/** write also reads; a read key never writes; only admin reaches /admin/*, and it reaches nothing else. */
export function authorized(keys: SimKeys, need: AuthClass, header: string | undefined | null): boolean {
  if (need === "none") return true;
  const token = bearer(header);
  if (token === null) return false;
  switch (need) {
    case "admin":
      return same(token, keys.admin);
    case "write":
      return same(token, keys.write);
    case "read":
      return same(token, keys.write) || same(token, keys.read) || same(token, keys.evalRead);
  }
}
