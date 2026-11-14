// G1 SSE: the stream polls audit_events by _id. A real server on an ephemeral port, the in-memory replica set, fast polling.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { ObjectId } from "mongodb";
import { openNtDb, type NtDb } from "@nt/db";
import { startTestReplSet, type TestReplSet } from "@nt/db/testing";
import { DEFAULT_KEEP_ALIVE_MS, DEFAULT_POLL_MS } from "../src/sse.ts";
import { createApp } from "../src/routes.ts";
import { NT, P02, READ_KEY, auditIds, seed, spyOn, type Spy } from "./support.ts";

let rs: TestReplSet;
let owner: NtDb;
let server: ServerType;
let base: string;
let spy: Spy;

beforeAll(async () => {
  rs = await startTestReplSet();
  owner = await openNtDb({ uri: rs.uri, dbName: rs.dbName });
  await seed(owner);
  const s = spyOn(owner);
  spy = s.spy;
  const app = createApp({ cols: s.cols, sim: { url: "http://127.0.0.1:1", readKey: READ_KEY }, evaluatorOut: "/nonexistent", recorded: false, sse: { pollMs: 40, keepAliveMs: 300 } });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
}, 180_000);

afterAll(async () => {
  (server as unknown as { closeAllConnections?: () => void } | undefined)?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await owner?.close();
  await rs?.stop();
});

/** Reads the stream until `done(text)` is true or the deadline passes; returns everything received. */
async function readUntil(res: Response, done: (text: string) => boolean, ms = 8000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  let read: Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> | null = null;
  while (Date.now() < deadline && !done(text)) {
    read ??= reader.read();
    const r = await Promise.race([read, new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
    if (r === null) continue; // keep the same pending read: abandoning it would lose its chunk
    read = null;
    if (r.done) break;
    text += dec.decode(r.value);
  }
  await reader.cancel().catch(() => {});
  return text;
}

const newEvent = (extra: Record<string, unknown> = {}) => ({
  _id: new ObjectId(), run_id: NT, at: new Date(), actor: { kind: "reconciler", id: "reconciler-1" }, type: "TRANSITION", intent_id: `${NT}:${P02}`, effect_key: P02,
  claim_id: null, from_state: "OUTCOME_UNKNOWN", to_state: "CONFIRMED", rule_citation: null, policy_version: null, detail: { transition: "T6", epoch: 3 }, ...extra,
});

describe("GET /api/runs/:run_id/events", () => {
  it("defaults: poll every 500 ms, keep-alive every 15 s", () => {
    expect(DEFAULT_POLL_MS).toBe(500);
    expect(DEFAULT_KEEP_ALIVE_MS).toBe(15_000);
  });

  it("without Last-Event-ID starts after the newest event, then emits a new event after an insert", async () => {
    const res = await fetch(`${base}/api/runs/${NT}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const pending = readUntil(res, (t) => t.includes("event: audit"));
    await new Promise((r) => setTimeout(r, 200)); // the stream is connected and has taken its starting point
    const e = newEvent();
    await owner.db.collection("audit_events").insertOne(e as never);
    const text = await pending;
    const block = text.split("\n\n").find((b) => b.includes("event: audit"))!;
    expect(block).toContain(`id: ${e._id.toHexString()}`);
    const data = JSON.parse(block.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as Record<string, unknown>;
    expect(data).toEqual({
      _id: e._id.toHexString(), at: e.at.toISOString(), type: "TRANSITION", actor: "reconciler", intent_id: `${NT}:${P02}`, effect_key: P02, claim_id: null,
      from_state: "OUTCOME_UNKNOWN", to_state: "CONFIRMED", transition: "T6",
    });
    // none of the seeded history was replayed
    expect(text).not.toContain(auditIds.decided.toHexString());
    expect(text.match(/event: audit/g)).toHaveLength(1);
  });

  it("honours Last-Event-ID: replays only what came after it, in _id order", async () => {
    const res = await fetch(`${base}/api/runs/${NT}/events`, { headers: { "Last-Event-ID": auditIds.reserved.toHexString() } });
    const text = await readUntil(res, (t) => (t.match(/event: audit/g)?.length ?? 0) >= 3);
    const ids = [...text.matchAll(/^id: ([0-9a-f]{24})$/gm)].map((m) => m[1]!);
    expect(ids.slice(0, 3)).toEqual([auditIds.t2, auditIds.t6, auditIds.other].map((i) => i.toHexString()));
    expect(ids).not.toContain(auditIds.reserved.toHexString());
  });

  it("sends a keep-alive comment while idle", async () => {
    const res = await fetch(`${base}/api/runs/${NT}/events`);
    const text = await readUntil(res, (t) => t.includes(": keep-alive"));
    expect(text).toContain(": keep-alive");
  });

  it("404 for an unknown run; it is JSON, not a stream", async () => {
    const res = await fetch(`${base}/api/runs/r0000000/events`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "UNKNOWN_RUN" });
  });

  it("the stream issues reads only", () => {
    expect(spy.violations).toEqual([]);
  });
});
