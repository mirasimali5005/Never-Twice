// Identity: effect key, disruption id, marker, run and group ids (HANDOVER.md §9.1–9.2; ARCHITECTURE.md §6.2).
import { randomInt } from "node:crypto";
import { z } from "zod";
import { EntitlementType } from "./reasons.ts";

export const RUN_ID_RE = /^r[0-9a-z]{7}$/;
export const GROUP_ID_RE = /^g[0-9a-z]{7}$/;
/** "r" + 7 lowercase base-36 characters, 8 in all, e.g. r7k2m9qa. */
export const RunId = z.string().regex(RUN_ID_RE);
export type RunId = z.infer<typeof RunId>;
/** "g" + 7 lowercase base-36 characters, e.g. g4x8p2nd. */
export const GroupId = z.string().regex(GROUP_ID_RE);
export type GroupId = z.infer<typeof GroupId>;

/** One effect-key component: no dot, so the key splits unambiguously. */
export const EFFECT_KEY_PART_RE = /^[A-Z0-9_-]+$/;
export const EFFECT_KEY_RE = /^[A-Z0-9._-]+$/;
export const EffectKey = z.string().regex(EFFECT_KEY_RE);
const FLIGHT_NO_RE = /^[A-Z0-9]+$/;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

/** `${flightNo}-${yyyymmdd}`. With a Date, the UTC calendar date of the scheduled departure [ADD-11]; with a string, it must be
 *  "YYYY-MM-DD" (taken as-is from the record, no Date arithmetic). Throws on a malformed flight number or date. */
export function disruptionId(flightNo: string, scheduledDeparture: Date | string): string {
  if (!FLIGHT_NO_RE.test(flightNo)) throw new IdentityError(`disruptionId: bad flight number ${JSON.stringify(flightNo)}`);
  let ymd: string;
  if (scheduledDeparture instanceof Date) {
    const t = scheduledDeparture.getTime();
    if (Number.isNaN(t)) throw new IdentityError("disruptionId: invalid Date");
    ymd = scheduledDeparture.toISOString().slice(0, 10).replaceAll("-", "");
    if (!/^\d{8}$/.test(ymd)) throw new IdentityError("disruptionId: date out of range");
  } else {
    const m = LOCAL_DATE_RE.exec(scheduledDeparture);
    if (!m) throw new IdentityError(`disruptionId: date must be YYYY-MM-DD, got ${JSON.stringify(scheduledDeparture)}`);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) throw new IdentityError(`disruptionId: bad date ${scheduledDeparture}`);
    ymd = `${m[1]}${m[2]}${m[3]}`;
  }
  return `${flightNo}-${ymd}`;
}

export type EffectKeyParts = { booking_ref: string; passenger_id: string; disruption_id: string };

/** The ONLY function allowed to build an effect key. Inputs come from the booking record, never from claim text or model output.
 *  Returns `${booking_ref}.${passenger_id}.${disruption_id}.${type}`. Throws if a part is empty, contains "." or any character
 *  outside [A-Z0-9_-] (a lower-case booking reference is a fixture error and is not normalised), or if the type is unknown. */
export function effectKey(b: EffectKeyParts, type: EntitlementType): string {
  const parts: [string, unknown][] = [
    ["booking_ref", b.booking_ref],
    ["passenger_id", b.passenger_id],
    ["disruption_id", b.disruption_id],
  ];
  for (const [name, v] of parts) {
    if (typeof v !== "string" || !EFFECT_KEY_PART_RE.test(v)) {
      throw new IdentityError(`effectKey: ${name} must match ${String(EFFECT_KEY_PART_RE)}, got ${JSON.stringify(v)}`);
    }
  }
  if (!EntitlementType.safeParse(type).success) throw new IdentityError(`effectKey: unknown entitlement type ${JSON.stringify(type)}`);
  const key = `${b.booking_ref}.${b.passenger_id}.${b.disruption_id}.${type}`;
  if (!EFFECT_KEY_RE.test(key)) throw new IdentityError(`effectKey: result ${JSON.stringify(key)} has a forbidden character`);
  return key;
}

/** Inverse of effectKey. Throws on anything effectKey could not have produced. */
export function parseEffectKey(key: string): EffectKeyParts & { entitlement_type: EntitlementType } {
  const segs = key.split(".");
  if (segs.length !== 4) throw new IdentityError(`parseEffectKey: expected 4 dot-separated parts in ${JSON.stringify(key)}`);
  const [booking_ref, passenger_id, disruption_id, type] = segs as [string, string, string, string];
  const t = EntitlementType.safeParse(type);
  if (!t.success) throw new IdentityError(`parseEffectKey: unknown entitlement type ${JSON.stringify(type)}`);
  const parts = { booking_ref, passenger_id, disruption_id };
  if (effectKey(parts, t.data) !== key) throw new IdentityError(`parseEffectKey: ${JSON.stringify(key)} is not canonical`);
  return { ...parts, entitlement_type: t.data };
}

/** `${runId}:${effectKey}` = intent _id = metadata.nt_marker = idempotency key on deduplicating rails. */
export function marker(runId: string, effectKeyValue: string): string {
  if (!RUN_ID_RE.test(runId)) throw new IdentityError(`marker: bad run id ${JSON.stringify(runId)}`);
  if (!EFFECT_KEY_RE.test(effectKeyValue)) throw new IdentityError(`marker: bad effect key ${JSON.stringify(effectKeyValue)}`);
  return `${runId}:${effectKeyValue}`;
}
/** Alias of marker (AGENT_TASKS.md packet A name). */
export const markerOf = marker;

/** Simulator account for a run: `acct_${runId}`. */
export function simAccountOf(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new IdentityError(`simAccountOf: bad run id ${JSON.stringify(runId)}`);
  return `acct_${runId}`;
}

const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";
function randomB36(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += B36[randomInt(36)];
  return s;
}
/** A fresh run id ("r" + 7 random base-36 characters). Used by the seed script only. */
export function newRunId(): string {
  return `r${randomB36(7)}`;
}
/** A fresh group id ("g" + 7 random base-36 characters). */
export function newGroupId(): string {
  return `g${randomB36(7)}`;
}
