// The reconciler loop (HANDOVER.md §11.1): a polling scan, not a change stream. One pass = orphans → takeover → investigate → watch.
// Candidates are selected on the database clock ($$NOW, in the store); each action re-checks inside its own compare-and-set in the
// gateway, so several reconcilers on one run are safe (REC-07). Intents are processed one at a time, ordered by _id.
import type { Intent } from "@nt/contracts";
import { investigate } from "./investigate.ts";
import { watchOne, watchReversal, type WatchDeps } from "./watcher.ts";

export type LoopDeps = WatchDeps & {
  runId: string;
  /** NT_LEASE_MS: a RESERVED intent older than one lease period with no live lease is an orphan. */
  leaseMs: number;
  /** Tier 2 watcher (T12 on absence-class quarantines). */
  watch: boolean;
  /** Set by SIGTERM: stop between intents. */
  stopping?: () => boolean;
  /** Tier 2 (advisory): embed the query texts of the due intents in one call before investigating them. Never blocks. */
  primeRecall?: (due: Intent[]) => Promise<void>;
  /** Tier 2 (advisory): embed the records closed during this tick in one call. Never blocks. */
  flushEmbeddings?: () => Promise<void>;
};

export type TickResult = { orphans: number; takeovers: number; investigated: number; watched: number; reversals: number; errors: number };

const byId = (a: Intent, b: Intent) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);

async function each(d: LoopDeps, list: Intent[], step: string, fn: (it: Intent) => Promise<boolean>, r: TickResult): Promise<number> {
  let n = 0;
  for (const it of [...list].sort(byId)) {
    if (d.stopping?.()) break;
    try {
      if (await fn(it)) n++;
    } catch (e) {
      // A failed step leaves the intent as it was (OUTCOME_UNKNOWN keeps its lease until it expires); nothing is released on absence.
      r.errors++;
      d.log?.(`[${d.workerId}] ${step} ${it._id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return n;
}

export async function tick(d: LoopDeps): Promise<TickResult> {
  const r: TickResult = { orphans: 0, takeovers: 0, investigated: 0, watched: 0, reversals: 0, errors: 0 };

  // 1. Orphans: RESERVED, no live lease, created more than one lease period ago → dispatch (all T2 checks re-run there; T11 if they fail).
  r.orphans = await each(d, await d.store.orphans(d.runId, d.leaseMs), "orphan", async (it) => {
    await d.gateway.dispatch(it._id, d.workerId);
    return true;
  }, r);

  // 2. Takeover: DISPATCHING whose lease expired → T5 (epoch + 1, lease cleared, next_attempt_at = $$NOW).
  r.takeovers = await each(d, await d.store.expiredDispatching(d.runId), "takeover", async (it) => {
    const after = await d.gateway.takeOverExpired(it._id, it.lease_epoch, d.workerId);
    return after !== null;
  }, r);

  // 3. Investigate: OUTCOME_UNKNOWN, no live lease, next_attempt_at <= $$NOW → acquire the lease → investigate.
  const due = await d.store.dueUnknown(d.runId);
  if (due.length > 0 && d.primeRecall) await d.primeRecall(due).catch(() => undefined);
  r.investigated = await each(d, due, "investigate", async (it) => {
    const leased = await d.gateway.acquireLease(it._id, it.lease_epoch, d.workerId);
    if (!leased) return false; // another worker has it, or it is not yet due
    await investigate(d, leased);
    return true;
  }, r);
  if (r.investigated > 0 && d.flushEmbeddings) await d.flushEmbeddings().catch(() => undefined);

  // 4. Watch (Tier 2): QUARANTINED with an absence-class reason → deterministic evidence → T12 on MATCH.
  if (d.watch) {
    r.watched = await each(d, await d.store.watchable(d.runId), "watch", (it) => watchOne(d, it), r);
    // 5. Reversal watch (Tier 3, CP-REV-1): CONFIRMED with no PROVIDER_REVERSAL yet → re-read the confirmed object → audit event only.
    if (d.store.confirmedUnreversed) {
      r.reversals = await each(d, await d.store.confirmedUnreversed(d.runId), "reversal", (it) => watchReversal(d, it), r);
    }
  }
  return r;
}

export type RunOptions = { untilDrained: boolean; once: boolean; intervalMs: number; sleep?: (ms: number) => Promise<void> };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs passes until stopped. With untilDrained it returns 0 once no intent of the run is RESERVED, DISPATCHING or OUTCOME_UNKNOWN
 * (quarantined intents do not keep it alive). With once it runs exactly one pass. The reconciler never writes the final report.
 */
export async function runLoop(d: LoopDeps, o: RunOptions): Promise<number> {
  const sleep = o.sleep ?? defaultSleep;
  for (;;) {
    if (d.stopping?.()) return 0;
    if (o.untilDrained && (await d.store.unresolvedCount(d.runId)) === 0) return 0;
    const r = await tick(d);
    if (r.orphans + r.takeovers + r.investigated + r.watched + r.reversals + r.errors > 0) {
      d.log?.(`[${d.workerId}] tick: orphans=${r.orphans} takeovers=${r.takeovers} investigated=${r.investigated} watched=${r.watched} reversals=${r.reversals} errors=${r.errors}`);
    }
    if (o.once) return 0;
    if (o.untilDrained && (await d.store.unresolvedCount(d.runId)) === 0) return 0;
    if (d.stopping?.()) return 0;
    await sleep(o.intervalMs);
  }
}
