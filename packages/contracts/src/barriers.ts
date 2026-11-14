// Crash barriers and mutations (HANDOVER.md §16; ARCHITECTURE.md §6.1, §6.8).
import { z } from "zod";

export const BARRIER_NAMES = [
  "BR_RESERVE_BEFORE_COMMIT",
  "BR_RESERVE_AFTER_COMMIT",
  "BR_DISPATCH_AFTER_MARK",
  "BR_DISPATCH_REQUEST_SENT",
  "BR_DISPATCH_RESPONSE_RECEIVED",
  "BR_SETTLE_IN_TXN",
  "BR_SETTLE_AFTER_COMMIT",
  "BR_RECON_AFTER_EVIDENCE",
  "BR_RECON_AFTER_LICENCE",
  "BR_RECON_AFTER_RESEND",
] as const;
export const BarrierName = z.enum(BARRIER_NAMES);
export type BarrierName = z.infer<typeof BarrierName>;

/** The control arm's one barrier, analogous to BR_DISPATCH_RESPONSE_RECEIVED. */
export const CONTROL_BARRIER_NAMES = ["CTRL_AFTER_PROVIDER_RESPONSE"] as const;
/** Every name NT_CRASH_AT may carry. */
export const CRASH_POINT_NAMES = [...BARRIER_NAMES, ...CONTROL_BARRIER_NAMES] as const;
export const CrashPointName = z.enum(CRASH_POINT_NAMES);
export type CrashPointName = z.infer<typeof CrashPointName>;

export const MUTATION_IDS = ["M1", "M2", "M3", "M4", "M5"] as const;
export const MutationId = z.enum(MUTATION_IDS);
export type MutationId = z.infer<typeof MutationId>;

/** Syntactic form of NT_CRASH_AT (ARCHITECTURE.md §6.8). parseCrashSpec additionally checks the name. */
export const CRASH_SPEC_RE = /^(BR|CTRL)_[A-Z_]+(:\d+|@[A-Z0-9._-]+)$/;

export type CrashSpec = { name: CrashPointName; nth: number } | { name: CrashPointName; effectKey: string };

/** `NAME:n` → { name, nth } (n ≥ 1); `NAME@effect_key` → { name, effectKey }; anything else, or an unknown name → null. */
export function parseCrashSpec(s: string): CrashSpec | null {
  if (!CRASH_SPEC_RE.test(s)) return null;
  const at = s.indexOf("@");
  if (at >= 0) {
    const name = CrashPointName.safeParse(s.slice(0, at));
    const effectKey = s.slice(at + 1);
    return name.success && effectKey.length > 0 ? { name: name.data, effectKey } : null;
  }
  const colon = s.lastIndexOf(":");
  const name = CrashPointName.safeParse(s.slice(0, colon));
  const nth = Number(s.slice(colon + 1));
  if (!name.success || !Number.isSafeInteger(nth) || nth < 1) return null;
  return { name: name.data, nth };
}
