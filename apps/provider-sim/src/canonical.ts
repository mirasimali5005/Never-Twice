// Local re-implementation of canonical JSON and SHA-256 (the simulator imports nothing from the workspace).
// Canonical JSON: object keys sorted (by UTF-16 code unit, as Array.prototype.sort does), no whitespace, UTF-8.
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    if (obj[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + canonicalJson(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
