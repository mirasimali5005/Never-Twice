// GET /api/runs/:run_id/events: server-sent events produced by POLLING audit_events with { run_id, _id: { $gt: last } } on the
// { run_id, _id } index (default every 500 ms). Not a change stream. An event is a signal to refetch, not the data.
// Honours Last-Event-ID; without it, starts after the newest event at connection time. A comment line every 15 s.
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { ObjectId } from "mongodb";
import type { DeskCollections } from "./read-model.ts";

export const DEFAULT_POLL_MS = 500;
export const DEFAULT_KEEP_ALIVE_MS = 15_000;
const BATCH = 200;
const HEX24 = /^[0-9a-f]{24}$/i;

export type SseOptions = { pollMs?: number; keepAliveMs?: number };

type AuditRow = {
  _id: ObjectId;
  at: Date;
  type: string;
  actor: { kind: string; id: string };
  intent_id: string | null;
  effect_key: string | null;
  claim_id: string | null;
  from_state: string | null;
  to_state: string | null;
  detail: Record<string, unknown>;
};

/** The compact event of ARCHITECTURE.md section 9 (matches StreamEvent in the UI). */
export function compactEvent(e: AuditRow) {
  const transition = e.detail?.["transition"];
  return {
    _id: e._id.toHexString(),
    at: e.at.toISOString(),
    type: e.type,
    actor: e.actor.kind,
    intent_id: e.intent_id,
    effect_key: e.effect_key,
    claim_id: e.claim_id,
    from_state: e.from_state,
    to_state: e.to_state,
    transition: typeof transition === "string" ? transition : null,
  };
}

async function newestId(cols: DeskCollections, runId: string): Promise<ObjectId> {
  const newest = await cols.audit.find({ run_id: runId }, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).toArray();
  return (newest[0]?._id as unknown as ObjectId | undefined) ?? ObjectId.createFromTime(0);
}

export function auditStream(c: Context, cols: DeskCollections, runId: string, opts: SseOptions = {}): Response {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const keepAliveMs = opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const header = c.req.header("last-event-id");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });
    let last: ObjectId;
    try {
      last = header && HEX24.test(header) ? new ObjectId(header) : await newestId(cols, runId);
    } catch {
      return; // database unavailable at connect: close; the browser reconnects
    }
    await stream.write(": connected\n\n");
    let lastWrite = Date.now();
    while (!aborted) {
      try {
        const rows = (await cols.audit.find({ run_id: runId, _id: { $gt: last } }).sort({ _id: 1 }).limit(BATCH).toArray()) as unknown as AuditRow[];
        for (const e of rows) {
          await stream.writeSSE({ id: e._id.toHexString(), event: "audit", data: JSON.stringify(compactEvent(e)) });
          last = e._id;
          lastWrite = Date.now();
        }
        if (rows.length === BATCH) continue; // more waiting: drain before sleeping
      } catch {
        return; // a read failed: end the stream so the client reconnects with Last-Event-ID; no error text is sent
      }
      if (Date.now() - lastWrite >= keepAliveMs) {
        await stream.write(": keep-alive\n\n");
        lastWrite = Date.now();
      }
      await stream.sleep(pollMs);
    }
  });
}
