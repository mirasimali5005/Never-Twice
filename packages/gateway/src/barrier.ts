// Crash barriers (HANDOVER.md §16). A no-op unless NT_CRASH_AT, read at call time, parses and matches; then the process
// sends itself SIGKILL. Forms: `NAME:n` fires on the nth arrival at NAME in this process; `NAME@effect_key` fires when the
// key matches. A barrier is the single permitted exception to "no side effects inside a transaction callback".
import { parseCrashSpec, type CrashPointName } from "@nt/contracts";

const arrivals = new Map<string, number>();

/** Test seam: what "firing" does. Production: SIGKILL to self. */
let fire: () => void = () => {
  process.kill(process.pid, "SIGKILL");
};

export function barrier(name: CrashPointName, effectKey?: string): void {
  const raw = process.env.NT_CRASH_AT;
  if (!raw) return;
  const spec = parseCrashSpec(raw);
  if (!spec || spec.name !== name) return;
  if ("nth" in spec) {
    const n = (arrivals.get(name) ?? 0) + 1; // counts each arrival, including callback re-runs
    arrivals.set(name, n);
    if (n === spec.nth) fire();
  } else if (effectKey !== undefined && effectKey === spec.effectKey) {
    fire();
  }
}

/** Arms `barrier(name, effectKey)` to run after `ms`; returns a cancel function. Used for BR_DISPATCH_REQUEST_SENT. */
export function barrierAfterMs<N extends CrashPointName>(name: N, ms: number, effectKey?: string, run: (n: N, k?: string) => void = barrier): () => void {
  const t = setTimeout(() => run(name, effectKey), ms);
  return () => clearTimeout(t);
}

/** For unit tests only: replace the kill and reset arrival counts. */
export function __setBarrierFireForTests(f: (() => void) | null): void {
  arrivals.clear();
  fire = f ?? (() => process.kill(process.pid, "SIGKILL"));
}
