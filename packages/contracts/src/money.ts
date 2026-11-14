// Money: integer minor units (cents) only; no floating-point arithmetic near money (ARCHITECTURE.md §6.2).
import { z } from "zod";

/** Integer cents. */
export const Minor = z.number().int().safe();
export type Minor = z.infer<typeof Minor>;

const CAD_TEXT_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]{2}))?$/;

/** Throws unless n is a safe integer ≥ 0. */
export function assertMinor(n: unknown): asserts n is number {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || Object.is(n, -0)) {
    throw new TypeError(`not a non-negative safe integer amount in minor units: ${String(n)}`);
  }
}

/** "412.60" → 41260; "1000" → 100000. String arithmetic only. Throws on signs, separators, one or three decimals, spaces. */
export function parseCad(text: string): number {
  if (typeof text !== "string") throw new TypeError("parseCad expects a string");
  const m = CAD_TEXT_RE.exec(text);
  if (!m) throw new RangeError(`not a CAD amount of the form 123 or 123.45: ${JSON.stringify(text)}`);
  const whole = m[1] ?? "0";
  const cents = m[2] ?? "00";
  const digits = (whole + cents).replace(/^0+(?=\d)/, "");
  const n = Number(digits);
  if (!Number.isSafeInteger(n)) throw new RangeError(`amount out of safe integer range: ${JSON.stringify(text)}`);
  return n;
}

/** 70000 → "700.00". Throws unless minor is a safe integer ≥ 0. */
export function formatCad(minor: number): string {
  assertMinor(minor);
  const s = String(minor).padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** Alias of parseCad (AGENT_TASKS.md packet A name). */
export const toMinor = parseCad;
/** Alias of formatCad (AGENT_TASKS.md packet A name). */
export const formatMinor = formatCad;
