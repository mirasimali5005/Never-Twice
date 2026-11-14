// Tier 2 recall (advisory): the Voyage embedder against a stub HTTP server, the $vectorSearch pipeline, the embedding texts, and
// "any failure means no context". Synthetic data only; no network beyond 127.0.0.1.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "@nt/contracts";
import {
  createRecall,
  createVoyageEmbedder,
  embeddingText,
  faultSignature,
  queryText,
  recallEnabled,
  recallPipeline,
  RECALL_INDEX,
  type RecallCollection,
} from "../src/recall/index.ts";
import { attempt, makeIntent } from "./support/fixtures.ts";

const FAKE_KEY = "test-voyage-key-not-real";

type Seen = { auth: string | undefined; body: { input: string[]; model: string; input_type: string } };
let server: Server;
let base = "";
const seen: Seen[] = [];
let reply: (body: Seen["body"]) => { status: number; json: unknown } = (b) => ({
  status: 200,
  json: { object: "list", data: b.input.map((_, i) => ({ object: "embedding", embedding: Array.from({ length: 4 }, (_, j) => i + j / 10), index: i })), model: b.model },
});

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c: Buffer) => (s += c.toString("utf8")));
    req.on("end", () => resolve(s));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as Seen["body"];
    seen.push({ auth: req.headers.authorization, body });
    const r = reply(body);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.json));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("Voyage embedder (stub HTTP server)", () => {
  it("POSTs model, input and input_type with a bearer key and returns vectors in index order", async () => {
    seen.length = 0;
    const e = createVoyageEmbedder({ apiKey: FAKE_KEY, model: "voyage-3.5-lite", dims: 4, url: base });
    expect(e.model).toBe("voyage-3.5-lite");
    expect(e.dims).toBe(4);
    const v = await e.embed(["a", "b"], "document");
    expect(v).toHaveLength(2);
    expect(v[1]![0]).toBe(1);
    expect(seen[0]!.auth).toBe(`Bearer ${FAKE_KEY}`);
    expect(seen[0]!.body).toEqual({ input: ["a", "b"], model: "voyage-3.5-lite", input_type: "document" });
    await e.embed(["q"], "query");
    expect(seen[1]!.body.input_type).toBe("query");
  });

  it("rejects a dimension mismatch, an HTTP error and a short reply, and never echoes the key", async () => {
    const e = createVoyageEmbedder({ apiKey: FAKE_KEY, dims: 1024, url: base });
    await expect(e.embed(["a"], "document")).rejects.toThrow(/4 dimensions, expected 1024/);
    const saved = reply;
    try {
      reply = () => ({ status: 401, json: { detail: "bad key" } });
      const err = await e.embed(["a"], "document").catch((x: Error) => x);
      expect(String(err)).toMatch(/HTTP 401/);
      expect(String(err)).not.toContain(FAKE_KEY);
      reply = () => ({ status: 200, json: { data: [] } });
      await expect(e.embed(["a"], "document")).rejects.toThrow(/expected 1 embedding/);
    } finally {
      reply = saved;
    }
  });

  it("makes no request for an empty input and refuses an empty key", async () => {
    seen.length = 0;
    expect(await createVoyageEmbedder({ apiKey: FAKE_KEY, dims: 4, url: base }).embed([], "query")).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(() => createVoyageEmbedder({ apiKey: "" })).toThrow();
  });
});

describe("recall query builder", () => {
  it("vector search across runs: index, path, numCandidates 50, limit k, provider filter, current intent excluded, closed only", () => {
    const it0 = makeIntent("sim_payout");
    const p = recallPipeline(it0, [0.1, 0.2], 3);
    const vs = (p[0] as { $vectorSearch: Record<string, unknown> }).$vectorSearch;
    expect(vs).toMatchObject({ index: RECALL_INDEX, path: "embedding", queryVector: [0.1, 0.2], numCandidates: 50, limit: 3 });
    expect(vs.filter).toEqual({
      $and: [{ provider: { $eq: "sim_payout" } }, { intent_id: { $ne: it0._id } }, { match: { $in: ["MATCH", "NO_MATCH", "CONTRADICTION"] } }],
    });
    expect(JSON.stringify(vs.filter)).not.toContain("run_id"); // past experience from every run
    expect(p[1]).toEqual({ $match: { closed_at: { $ne: null } } });
    expect((p[2] as { $project: Record<string, unknown> }).$project).toMatchObject({ decision_kind: "$decision.kind", score: { $meta: "vectorSearchScore" } });
  });
});

describe("embedding texts", () => {
  it("record text carries hypothesis, provider/rail, fault signature, which queries found the evidence and the decision", () => {
    const it0 = makeIntent("sim_payout", { attempts: [{ ...attempt(1), result: { kind: "INDETERMINATE", cause: "TIMEOUT", code: null, replayed: null, provider_object_id: null } }] });
    const fs = faultSignature(it0, "MATCH");
    expect(fs).toBe("sim_payout|attempts:INDETERMINATE:TIMEOUT|match:MATCH");
    const t = embeddingText({
      hypothesis: "applied, response lost",
      provider: "sim_payout",
      rail: "instant",
      fault_signature: fs,
      evidence_queries: ["list_provider_payments_by_payee"],
      steps: [{ tool: "search_provider_payments", record_count: 0 }, { tool: "list_provider_payments_by_payee", record_count: 1 }],
      match: "MATCH",
      decision: { kind: "SETTLE" },
      licence: null,
      investigator: "llm",
    });
    expect(t).toContain("hypothesis: applied, response lost");
    expect(t).toContain("rail: instant");
    expect(t).toContain(`fault: ${fs}`);
    expect(t).toContain("evidence found by: list_provider_payments_by_payee");
    expect(t).toContain("outcome: MATCH, SETTLE");
    expect(queryText(it0)).toContain("fault: sim_payout|attempts:INDETERMINATE:TIMEOUT");
  });

  it("NT_RECALL_ENABLED defaults on with a key, off without one, and can be turned off", () => {
    expect(recallEnabled({ VOYAGE_API_KEY: "k" })).toBe(true);
    expect(recallEnabled({ VOYAGE_API_KEY: "k", NT_RECALL_ENABLED: "false" })).toBe(false);
    expect(recallEnabled({ NT_RECALL_ENABLED: "true" })).toBe(false);
  });
});

describe("Recall.similar", () => {
  const embedder = (over: Partial<Embedder> = {}): Embedder => ({ model: "fake", dims: 2, embed: async (ts) => ts.map(() => [1, 0]), ...over });
  const row = { _id: "65a000000000000000000001", hypothesis: "h", rail: "instant", fault_signature: "f", evidence_queries: ["list_provider_payments_by_payee"], match: "MATCH", decision_kind: "SETTLE", score: 0.93 };

  it("embeds a query text with input_type query and maps rows to compact PastInvestigation entries", async () => {
    const pipelines: unknown[] = [];
    const types: string[] = [];
    const coll: RecallCollection = { aggregate: (p) => (pipelines.push(p), { toArray: async () => [row, { junk: true }] }) };
    const r = createRecall({ collection: coll, embedder: embedder({ embed: async (ts, t) => (types.push(t), ts.map(() => [1, 0])) }) });
    const out = await r.similar(makeIntent("sim_payout"), 3);
    expect(types).toEqual(["query"]);
    expect(pipelines).toHaveLength(1);
    expect(out).toEqual([{ id: row._id, hypothesis: "h", rail: "instant", fault_signature: "f", evidence_queries: ["list_provider_payments_by_payee"], match: "MATCH", decision_kind: "SETTLE", score: 0.93 }]);
  });

  it("any failure is no context: embedder error, missing index, hang past the timeout", async () => {
    const logs: string[] = [];
    const ok: RecallCollection = { aggregate: () => ({ toArray: async () => [row] }) };
    const it0 = makeIntent("sim_payout");
    expect(await createRecall({ collection: ok, embedder: embedder({ embed: async () => { throw new Error("voyage down"); } }), log: (l) => logs.push(l) }).similar(it0, 3)).toEqual([]);
    const noIndex: RecallCollection = { aggregate: () => ({ toArray: async () => { throw new Error("PlanExecutor error: index not found"); } }) };
    expect(await createRecall({ collection: noIndex, embedder: embedder(), log: (l) => logs.push(l) }).similar(it0, 3)).toEqual([]);
    const hang: RecallCollection = { aggregate: () => ({ toArray: () => new Promise(() => {}) }) };
    expect(await createRecall({ collection: hang, embedder: embedder(), timeoutMs: 30, log: (l) => logs.push(l) }).similar(it0, 3)).toEqual([]);
    expect(logs.join("\n")).toMatch(/voyage down[\s\S]*index not found[\s\S]*timeout after 30 ms/);
  });
});

describe("Recall.prime", () => {
  it("embeds several intents' query texts in one call and similar() then reuses the cached vectors", async () => {
    const batches: number[] = [];
    const embedder: Embedder = { model: "fake", dims: 2, embed: async (ts) => (batches.push(ts.length), ts.map(() => [1, 0])) };
    const coll: RecallCollection = { aggregate: () => ({ toArray: async () => [] }) };
    const r = createRecall({ collection: coll, embedder });
    const a = makeIntent("sim_payout");
    const b = makeIntent("sim_keyless");
    await r.prime([a, b, a]);
    expect(batches).toEqual([2]);
    await r.similar(a, 3);
    await r.similar(b, 3);
    expect(batches).toEqual([2]);
  });
});
