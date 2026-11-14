// PRB-01 static admission checks; PRB-07 a schema-hash change invalidates admission; PRB-09 the author's single retry with the
// admission failure as feedback, and the admission rate as admitted over attempted.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelParseRequest, ModelParseResult } from "@nt/contracts";
import {
  admitProbe,
  authorAndAdmit,
  evalPath,
  evidenceSourceFor,
  probeId,
  saveAdmittedProbe,
  staticCheck,
  toolSchemaHash,
} from "../src/probes/index.ts";
import type { ProbeCollection, ProbeDoc, ProbeDraft } from "../src/probes/index.ts";
import { SimProcess } from "./support/sim-process.ts";
import { GOOD_DRAFT, NOTIFY_TOOL, countingFetch, goodSpec, harness, policy, variant } from "./support/probes.ts";

let sim: SimProcess;
beforeAll(async () => {
  sim = await SimProcess.start();
}, 30_000);
afterAll(async () => {
  await sim.stop();
});

describe("PRB-01 static admission checks", () => {
  const P = () => policy(sim.baseUrl);

  it("the section 11.4 example spec passes the static stage", () => {
    expect(staticCheck(goodSpec(), P())).toEqual({ ok: true });
  });

  const variants: [string, string, (s: ReturnType<typeof goodSpec>) => void][] = [
    ["method POST", "METHOD", (s) => (s.request.method = "POST")],
    ["a host off the allow-list", "HOST", (s) => (s.request.path = "https://evil.example.com/v1/messages")],
    ["a path off the allow-list", "PATH", (s) => (s.request.path = "/admin/state-hash")],
    ["the write credential attached", "CREDENTIAL", (s) => (s.request.credential = "write")],
    ["a template drawing on claim text", "TEMPLATE", (s) => (s.request.query.recipient = "{{claim_text}}")],
    ["an Authorization header", "HEADERS", (s) => (s.request.headers = { Authorization: "Bearer x" })],
    ["a query string smuggled into the path", "PATH", (s) => (s.request.path = "/v1/messages?account=x")],
    ["a payout path of another tool", "PATH", (s) => (s.request.path = "/v1/payouts")],
    ["a spec for another schema hash", "SCHEMA_HASH", (s) => (s.schema_hash = "0".repeat(64))],
    ["a JSONPath outside the subset", "JSONPATH", (s) => (s.items_path = "$..data[?(@.x)]")],
    ["max_pages 50", "PAGINATION", (s) => (s.pagination!.max_pages = 50)],
  ];
  for (const [name, check, edit] of variants) {
    it(`rejects ${name} (${check}) before any request is made`, async () => {
      const c = countingFetch();
      const spec = variant(edit);
      const v = await admitProbe(spec, P(), harness(sim.baseUrl, c.fetchImpl));
      expect(v.admitted).toBe(false);
      expect(v.static).toMatchObject({ ok: false, check });
      expect(v.canaries).toBeNull();
      expect(v.reason).toMatch(new RegExp(`^static ${check}`));
      expect(c.count()).toBe(0);
    });
  }

  it("JSONPath subset evaluates as documented", () => {
    const body = { data: [{ id: "a", metadata: { nt_marker: "m" } }, { id: "b" }], next_cursor: "b" };
    expect(evalPath(body, "$.data[*]")).toHaveLength(2);
    expect(evalPath(body, "$.data[0].metadata.nt_marker")).toEqual(["m"]);
    expect(evalPath(body, "$['next_cursor']")).toEqual(["b"]);
    expect(evalPath(body, "$.nope")).toEqual([]);
  });
});

/** In-memory stand-in for the @nt/db probes collection. */
function memCollection(): ProbeCollection & { docs: Map<string, ProbeDoc> } {
  const docs = new Map<string, ProbeDoc>();
  return {
    docs,
    async findOne(f) {
      return docs.get(f._id) ?? null;
    },
    async insertOne(d) {
      if (docs.has(d._id)) throw new Error("duplicate key");
      docs.set(d._id, structuredClone(d));
    },
  };
}

describe("PRB-07 a schema-hash change invalidates admission", () => {
  it("admitted as notify.send:{hash}; after the tool's schema changes there is no admitted probe (PROBE_NOT_ADMITTED); the old document is unchanged", async () => {
    const coll = memCollection();
    const spec = goodSpec();
    const v = await admitProbe(spec, policy(sim.baseUrl), harness(sim.baseUrl));
    expect(v.admitted).toBe(true);
    const doc = await saveAdmittedProbe(coll, spec, v);
    expect(doc._id).toBe(`notify.send:${toolSchemaHash(NOTIFY_TOOL)}`);
    expect(doc.admission).toMatchObject({ static_checks: "PASS", canaries: { found_immediately: true, decoy_ignored: true, paginated: true, state_hash_unchanged: true } });
    expect(await evidenceSourceFor(coll, NOTIFY_TOOL)).toEqual({ kind: "ADMITTED_PROBE", spec });

    const changed = structuredClone(NOTIFY_TOOL);
    changed.object_schema.recipient_name = "string";
    const newHash = toolSchemaHash(changed);
    expect(newHash).not.toBe(spec.schema_hash);
    const before = structuredClone(coll.docs.get(doc._id));
    expect(await evidenceSourceFor(coll, changed)).toEqual({ kind: "NONE", quarantine: "PROBE_NOT_ADMITTED" });
    // the old spec is not admissible against the new schema either
    expect(staticCheck(spec, { tool: changed, allowedOrigins: [new URL(sim.baseUrl).origin] })).toMatchObject({ ok: false, check: "SCHEMA_HASH" });
    expect(coll.docs.get(doc._id)).toEqual(before);
    expect(coll.docs.has(probeId("notify.send", newHash))).toBe(false);
    // a rejected spec is never stored
    const bad = variant((s) => (s.pagination = null));
    const bv = await admitProbe(bad, policy(sim.baseUrl), harness(sim.baseUrl));
    await expect(saveAdmittedProbe(coll, bad, bv)).rejects.toThrow(/only an admitted probe/);
    expect(coll.docs.size).toBe(1);
  });
});

/** A scripted ModelClient: returns the given drafts in order and records each request. */
function scriptedModel(drafts: (ProbeDraft | null)[]): ModelClient & { requests: ModelParseRequest<unknown>[] } {
  const requests: ModelParseRequest<unknown>[] = [];
  let i = 0;
  return {
    mode: "replay",
    model: "scripted",
    backend: "cli",
    requests,
    async parse<T>(req: ModelParseRequest<T>): Promise<ModelParseResult<T>> {
      requests.push(req as ModelParseRequest<unknown>);
      const d = drafts[i++];
      if (d === undefined || d === null) return { ok: false, failure: "SCHEMA_INVALID", detail: "scripted failure", requestSha256: `s${i}` };
      return { ok: true, output: req.schema.parse(d), requestSha256: `s${i}`, source: "cassette" };
    },
    async runTools() {
      return { ok: false, failure: "UNSUPPORTED", detail: "" };
    },
  };
}

describe("PRB-09 author retry and admission rate", () => {
  const lagging: ProbeDraft = { ...structuredClone(GOOD_DRAFT), request: { method: "GET", path: "/v1/search/messages", query: { account: "{{account}}", marker: "{{marker}}" }, credential: "read" }, pagination: null };

  it("an author output that fails canary 1 and a retry that fails again: rejected twice, nothing admitted; the retry carried the failure", async () => {
    const model = scriptedModel([lagging, lagging]);
    const r = await authorAndAdmit(model, policy(sim.baseUrl), harness(sim.baseUrl));
    expect(r.admitted).toBe(false);
    expect(r.attempts).toHaveLength(2);
    for (const a of r.attempts) expect(a.reason).toMatch(/^canary 1 \(found_immediately\)/);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]!.messages[0]!.content).not.toMatch(/REJECTED/);
    expect(model.requests[1]!.messages[0]!.content).toMatch(/REJECTED by admission/);
    expect(model.requests[1]!.messages[0]!.content).toMatch(/canary 1 \(found_immediately\)/);
    // admission rate as measured: admitted over attempted
    const attempted = r.attempts.length;
    const admitted = r.attempts.filter((a) => a.verdict?.admitted).length;
    expect(`${admitted}/${attempted}`).toBe("0/2");
  });

  it("a rejected first spec followed by a corrected retry is admitted on attempt 2", async () => {
    const model = scriptedModel([lagging, GOOD_DRAFT]);
    const r = await authorAndAdmit(model, policy(sim.baseUrl), harness(sim.baseUrl));
    expect(r.admitted).toBe(true);
    expect(r.attempts.map((a) => a.verdict?.admitted)).toEqual([false, true]);
    expect(r.spec!.tool_id).toBe("notify.send");
    expect(r.spec!.schema_hash).toBe(toolSchemaHash(NOTIFY_TOOL));
  });

  it("a model failure counts as a failed attempt and is retried once", async () => {
    const model = scriptedModel([null, null]);
    const r = await authorAndAdmit(model, policy(sim.baseUrl), harness(sim.baseUrl));
    expect(r.admitted).toBe(false);
    expect(r.attempts.map((a) => a.model_failure?.failure)).toEqual(["SCHEMA_INVALID", "SCHEMA_INVALID"]);
  });
});
