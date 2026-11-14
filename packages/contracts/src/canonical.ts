// Canonical bytes and hashing (HANDOVER.md §9.3; ARCHITECTURE.md §6.2, [ADD-15]).
import { createHash } from "node:crypto";

export class CanonicalJsonError extends TypeError {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`canonicalJson: ${message} at ${path}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`number ${String(value)} is not a safe integer`, path);
      if (Object.is(value, -0)) throw new CanonicalJsonError("-0 is not allowed", path);
      return String(value);
    case "undefined":
      throw new CanonicalJsonError("undefined is not allowed", path);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`${typeof value} is not allowed`, path);
  }
  const obj = value as object;
  if (stack.has(obj)) throw new CanonicalJsonError("cycle", path);
  if (Array.isArray(obj)) {
    stack.add(obj);
    const parts: string[] = [];
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj)) throw new CanonicalJsonError("sparse array hole", `${path}[${i}]`);
      parts.push(write(obj[i], `${path}[${i}]`, stack));
    }
    stack.delete(obj);
    return `[${parts.join(",")}]`;
  }
  if (!isPlainObject(obj)) {
    const name = (obj as { constructor?: { name?: string } }).constructor?.name ?? "object";
    throw new CanonicalJsonError(`${name} is not a plain object`, path);
  }
  if (Object.getOwnPropertySymbols(obj).length > 0) throw new CanonicalJsonError("symbol keys are not allowed", path);
  stack.add(obj);
  // Default sort compares UTF-16 code units.
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${JSON.stringify(k)}:${write((obj as Record<string, unknown>)[k], `${path}.${k}`, stack)}`);
  }
  stack.delete(obj);
  return `{${parts.join(",")}}`;
}

/** Defines "the bytes". Object keys sorted by UTF-16 code unit at every depth; arrays keep their order; no whitespace;
 *  strings escaped as JSON.stringify does; output hashed as UTF-8. Accepts only null, booleans, strings, safe integers,
 *  arrays and plain objects; throws on undefined, non-integer numbers, NaN, infinities, -0, bigint, functions, symbols,
 *  Dates, cycles and any other object, so the same value cannot serialise two ways. */
export function canonicalJson(value: unknown): string {
  return write(value, "$", new Set());
}

/** Lowercase hex SHA-256. A string is hashed as its UTF-8 bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  const h = createHash("sha256");
  if (typeof input === "string") h.update(input, "utf8");
  else h.update(input);
  return h.digest("hex");
}

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
