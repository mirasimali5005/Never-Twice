// C2-UNIT-01: every row of the response mapping table, from canned responses served by a stub HTTP server.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchResult, frozenRequestBody, hashFrozenRequest } from "@nt/contracts";
import { MAX_EVIDENCE_PAGES, ProviderConfigError, ProviderReadError, SimKeylessProvider, SimPayoutProvider, createProvider } from "../src/index.ts";
import { ACCOUNT, ACCOUNT_BODY, READ, StubServer, WRITE, frozenReq, providerObject, withAccount } from "./support/stub-http.ts";
import type { Handler, Reply } from "./support/stub-http.ts";

let stub: StubServer;
beforeEach(async () => {
  stub = await StubServer.start();
});
afterEach(async () => {
  await stub.stop();
});

const KEY = "r7k2m9qa:ZT4H9X.P02.NT101-20261110.APPR_DELAY";

async function payout(onPost: Reply | Handler) {
  stub.handler = withAccount((req, n) => (typeof onPost === "function" ? onPost(req, n) : onPost));
  return SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
}
async function keyless(onPost: Reply | Handler) {
  stub.handler = withAccount((req, n) => (typeof onPost === "function" ? onPost(req, n) : onPost));
  return SimKeylessProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
}
const send = (p: SimPayoutProvider, timeoutMs = 2000) => p.createPaymentOrRefund(frozenReq(), { idempotencyKey: KEY, timeoutMs });

describe("construction and capabilities", () => {
  it("sim_payout reads capabilities from GET /v1/accounts/:account with the read key", async () => {
    stub.handler = withAccount(() => ({ status: 500 }), { account: ACCOUNT, retention_ms: 4000, max_in_flight_ms: 2500, search_lag_ms: 5000 });
    const p = await SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
    expect(p.id).toBe("sim_payout");
    expect(p.capabilities).toEqual({ dedupesOnIdempotencyKey: true, keyRetentionMs: 4000, declaredMaxInFlightMs: 2500, stronglyConsistentList: true });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.method).toBe("GET");
    expect(stub.requests[0]!.url).toBe(`/v1/accounts/${ACCOUNT}`);
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${READ}`);
  });

  it("sim_keyless does not deduplicate and has no retention", async () => {
    const p = await keyless({ status: 500 });
    expect(p.id).toBe("sim_keyless");
    expect(p.capabilities).toEqual({ dedupesOnIdempotencyKey: false, keyRetentionMs: null, declaredMaxInFlightMs: null, stronglyConsistentList: true });
  });

  it("an unknown account, a bad key or an unreachable simulator is a ProviderConfigError at construction", async () => {
    stub.handler = () => ({ status: 404, body: { error: { code: "not_found", message: "unknown account" } } });
    await expect(SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ })).rejects.toBeInstanceOf(ProviderConfigError);
    stub.handler = () => ({ status: 401, body: { error: { code: "unauthorized", message: "no" } } });
    await expect(SimKeylessProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ })).rejects.toBeInstanceOf(ProviderConfigError);
    stub.handler = () => ({ status: 200, body: { account: ACCOUNT } });
    await expect(SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ })).rejects.toBeInstanceOf(ProviderConfigError);
    await stub.stop();
    await expect(SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ, readTimeoutMs: 500 })).rejects.toBeInstanceOf(ProviderConfigError);
    stub = await StubServer.start(); // for afterEach
  });
});

describe("POST wire format", () => {
  it("sends exactly frozenRequestBody(req) with the write key and Idempotency-Key; body hash equals frozen_request_sha256", async () => {
    const p = await payout({ status: 201, body: providerObject(), headers: { "Idempotent-Replayed": "false" } });
    const req = frozenReq();
    await p.createPaymentOrRefund(req, { idempotencyKey: KEY, timeoutMs: 2000 });
    const post = stub.posts[0]!;
    expect(post.url).toBe("/v1/payouts");
    expect(post.body.toString("utf8")).toBe(frozenRequestBody(req));
    expect(createHash("sha256").update(post.body).digest("hex")).toBe(hashFrozenRequest(req));
    expect(post.headers.authorization).toBe(`Bearer ${WRITE}`);
    expect(post.headers["idempotency-key"]).toBe(KEY);
    expect(post.headers["content-type"]).toBe("application/json");
  });

  it("sim_keyless never sends Idempotency-Key and sends rail legacy", async () => {
    const p = await keyless({ status: 201, body: providerObject({ id: "po_c5e1907ab3d26f84" }) });
    const req = frozenReq({ rail: "legacy" });
    const r = await p.createPaymentOrRefund(req, { idempotencyKey: null, timeoutMs: 2000 });
    expect(r.kind).toBe("ACCEPTED");
    const post = stub.posts[0]!;
    expect(post.headers["idempotency-key"]).toBeUndefined();
    expect(JSON.parse(post.body.toString("utf8")).rail).toBe("legacy");
    expect(post.body.toString("utf8")).toBe(frozenRequestBody(req));
    expect(post.headers.authorization).toBe(`Bearer ${WRITE}`);
  });

  it("programmer errors throw and send nothing: null key on sim_payout, a key on sim_keyless, wrong provider, rail or account", async () => {
    const p = await payout({ status: 201, body: providerObject() });
    const k = await keyless({ status: 201, body: providerObject() });
    await expect(p.createPaymentOrRefund(frozenReq(), { idempotencyKey: null, timeoutMs: 1000 })).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(k.createPaymentOrRefund(frozenReq({ rail: "legacy" }), { idempotencyKey: KEY, timeoutMs: 1000 })).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(p.createPaymentOrRefund(frozenReq({ rail: "legacy" }), { idempotencyKey: KEY, timeoutMs: 1000 })).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(p.createPaymentOrRefund({ ...frozenReq(), account: "acct_other" }, { idempotencyKey: KEY, timeoutMs: 1000 })).rejects.toBeInstanceOf(ProviderConfigError);
    expect(stub.posts).toHaveLength(0);
  });

  it("an invalid frozen request is a programmer error and sends nothing", async () => {
    const p = await payout({ status: 201, body: providerObject() });
    await expect(p.createPaymentOrRefund({ ...frozenReq(), amount_minor: 700.5 }, { idempotencyKey: KEY, timeoutMs: 1000 })).rejects.toThrow();
    expect(stub.posts).toHaveLength(0);
  });

  it("the REFUND operation goes to the same endpoint under provider sim_payout", async () => {
    const p = await payout({ status: 201, body: providerObject({ id: "rf_8d20c6b9e14f7a03", kind: "refund" }) });
    const r = await p.createPaymentOrRefund(frozenReq({ operation: "REFUND" }), { idempotencyKey: KEY, timeoutMs: 2000 });
    expect(r.kind === "ACCEPTED" && r.object.kind).toBe("refund");
    expect(JSON.parse(stub.posts[0]!.body.toString("utf8")).operation).toBe("REFUND");
  });
});

describe("response mapping table", () => {
  it("201 + parsable object, header true -> ACCEPTED replayed true", async () => {
    const p = await payout({ status: 201, body: providerObject(), headers: { "Idempotent-Replayed": "true" } });
    expect(await send(p)).toEqual({ kind: "ACCEPTED", object: providerObject(), replayed: true });
  });

  it("201, header false -> ACCEPTED replayed false; header absent -> replayed false", async () => {
    const p = await payout({ status: 201, body: providerObject(), headers: { "Idempotent-Replayed": "false" } });
    expect(await send(p)).toMatchObject({ kind: "ACCEPTED", replayed: false });
    const k = await keyless({ status: 201, body: providerObject() });
    expect(await k.createPaymentOrRefund(frozenReq({ rail: "legacy" }), { idempotencyKey: null, timeoutMs: 2000 })).toMatchObject({ kind: "ACCEPTED", replayed: false });
  });

  it("201 with a body that does not parse -> CONTRADICTION UNEXPECTED_OBJECT (wrong shape, non-JSON, non-integer amount)", async () => {
    for (const reply of [
      { status: 201, body: { id: "po_1", hello: "world" } },
      { status: 201, rawBody: "<html>not json</html>" },
      { status: 201, body: { ...providerObject(), amount_minor: 700.5 } },
      { status: 201, body: { ...providerObject(), kind: "transfer" } },
    ] satisfies Reply[]) {
      const p = await payout(reply);
      const r = await send(p);
      expect(r).toMatchObject({ kind: "CONTRADICTION", code: "UNEXPECTED_OBJECT" });
    }
  });

  it("an unexpected 2xx (200) -> CONTRADICTION UNEXPECTED_OBJECT", async () => {
    const p = await payout({ status: 200, body: providerObject() });
    expect(await send(p)).toMatchObject({ kind: "CONTRADICTION", code: "UNEXPECTED_OBJECT" });
  });

  it("400 -> REJECTED_DEFINITIVE with code, message and replayed from the header", async () => {
    const body = { error: { code: "payee_closed", message: "payee account closed" } };
    let p = await payout({ status: 400, body, headers: { "Idempotent-Replayed": "false" } });
    expect(await send(p)).toEqual({ kind: "REJECTED_DEFINITIVE", code: "payee_closed", message: "payee account closed", replayed: false });
    p = await payout({ status: 400, body, headers: { "Idempotent-Replayed": "true" } });
    expect(await send(p)).toEqual({ kind: "REJECTED_DEFINITIVE", code: "payee_closed", message: "payee account closed", replayed: true });
    p = await payout({ status: 400, body: { error: { code: "amount_invalid", message: "bad" } } });
    expect(await send(p)).toMatchObject({ kind: "REJECTED_DEFINITIVE", code: "amount_invalid", replayed: false });
    p = await payout({ status: 400, rawBody: "garbage" });
    expect(await send(p)).toMatchObject({ kind: "REJECTED_DEFINITIVE", code: "unknown", replayed: false });
  });

  it("409 request_in_progress -> INDETERMINATE IN_PROGRESS_CONFLICT", async () => {
    const p = await payout({ status: 409, body: { error: { code: "request_in_progress", message: "x" } } });
    expect(await send(p)).toMatchObject({ kind: "INDETERMINATE", cause: "IN_PROGRESS_CONFLICT" });
  });

  it("422 idempotency_key_reuse -> CONTRADICTION KEY_REUSED_DIFFERENT_PARAMS", async () => {
    const p = await payout({ status: 422, body: { error: { code: "idempotency_key_reuse", message: "x" } } });
    expect(await send(p)).toMatchObject({ kind: "CONTRADICTION", code: "KEY_REUSED_DIFFERENT_PARAMS" });
  });

  it("any 5xx -> INDETERMINATE SERVER_ERROR", async () => {
    for (const status of [500, 502, 503, 504]) {
      const p = await payout({ status, body: { error: { code: "internal", message: "x" } } });
      expect(await send(p)).toMatchObject({ kind: "INDETERMINATE", cause: "SERVER_ERROR" });
    }
  });

  it("timeout (no response) -> INDETERMINATE TIMEOUT", async () => {
    const p = await payout({ hang: true });
    const started = Date.now();
    const r = await send(p, 250);
    expect(r).toMatchObject({ kind: "INDETERMINATE", cause: "TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("connection reset or closed without a response -> INDETERMINATE CONNECTION", async () => {
    const p = await payout({ destroy: true });
    expect(await send(p)).toMatchObject({ kind: "INDETERMINATE", cause: "CONNECTION" });
  });

  it("connection refused -> INDETERMINATE CONNECTION", async () => {
    const p = await payout({ status: 201, body: providerObject() });
    await stub.stop();
    expect(await send(p, 1000)).toMatchObject({ kind: "INDETERMINATE", cause: "CONNECTION" });
    stub = await StubServer.start(); // for afterEach
  });

  it("401, 403, 404 on the POST -> ProviderConfigError (not an outcome)", async () => {
    for (const status of [401, 403, 404]) {
      const p = await payout({ status, body: { error: { code: "x", message: "y" } } });
      await expect(send(p)).rejects.toBeInstanceOf(ProviderConfigError);
    }
  });

  it("any other status (429, 408, 302, 402) is never a definitive rejection: INDETERMINATE SERVER_ERROR", async () => {
    for (const status of [429, 408, 302, 402]) {
      const p = await payout({ status, body: {} });
      expect(await send(p)).toMatchObject({ kind: "INDETERMINATE", cause: "SERVER_ERROR" });
    }
  });

  it("every returned value validates against the DispatchResult schema", async () => {
    const replies: Reply[] = [
      { status: 201, body: providerObject() },
      { status: 400, body: { error: { code: "payee_closed", message: "m" } } },
      { status: 409, body: { error: { code: "request_in_progress", message: "m" } } },
      { status: 422, body: { error: { code: "idempotency_key_reuse", message: "m" } } },
      { status: 500 },
      { status: 201, rawBody: "nope" },
    ];
    for (const r of replies) expect(DispatchResult.safeParse(await send(await payout(r))).success).toBe(true);
  });

  it("no retries: one POST per call whatever the answer", async () => {
    for (const reply of [{ status: 500 }, { status: 409, body: {} }, { destroy: true }] satisfies Reply[]) {
      stub.requests.length = 0;
      const p = await payout(reply);
      await send(p);
      expect(stub.posts).toHaveLength(1);
    }
  });
});

describe("read methods (GET only, read key)", () => {
  it("getOperation: 200 -> object, 404 -> null, transport failure or 5xx throws ProviderReadError", async () => {
    stub.handler = withAccount((req) =>
      req.url === "/v1/payouts/po_found"
        ? { status: 200, body: providerObject({ id: "po_found" }) }
        : req.url === "/v1/payouts/po_boom"
          ? { status: 500 }
          : { status: 404, body: { error: { code: "not_found", message: "no such object" } } },
    );
    const p = await SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
    expect(await p.getOperation("po_found")).toEqual(providerObject({ id: "po_found" }));
    expect(await p.getOperation("po_missing")).toBeNull();
    await expect(p.getOperation("po_boom")).rejects.toBeInstanceOf(ProviderReadError);
    const gets = stub.requests.filter((r) => r.url.startsWith("/v1/payouts/"));
    expect(gets.every((r) => r.method === "GET" && r.headers.authorization === `Bearer ${READ}`)).toBe(true);
  });

  function pagedList(total: number, pageSize = 100): Handler {
    const all = Array.from({ length: total }, (_, i) => providerObject({ id: `po_${String(i + 1).padStart(4, "0")}` }));
    return withAccount((req) => {
      const u = new URL(req.url, "http://x");
      const limit = Math.min(Number(u.searchParams.get("limit") ?? "10"), pageSize);
      const after = u.searchParams.get("starting_after");
      const start = after ? all.findIndex((o) => o.id === after) + 1 : 0;
      const page = all.slice(start, start + limit);
      const hasMore = start + limit < all.length;
      return { status: 200, body: { data: page, has_more: hasMore, next_cursor: hasMore ? page[page.length - 1]!.id : null } };
    });
  }

  it("findOperationEvidence lists by payee since a time, follows every page, complete true", async () => {
    stub.handler = pagedList(250);
    const p = await SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
    const since = new Date("2026-11-14T17:59:07.000Z");
    const r = await p.findOperationEvidence({ account: ACCOUNT, payeeRef: "payee_P02", parentRef: null, since });
    expect(r.complete).toBe(true);
    expect(r.records).toHaveLength(250);
    const lists = stub.requests.filter((x) => x.url.startsWith("/v1/payouts?"));
    expect(lists).toHaveLength(3);
    const first = new URL(lists[0]!.url, "http://x").searchParams;
    expect(first.get("account")).toBe(ACCOUNT);
    expect(first.get("payee_ref")).toBe("payee_P02");
    expect(first.get("created_gte")).toBe("2026-11-14T17:59:07.000Z");
    expect(first.get("starting_after")).toBeNull();
    expect(new URL(lists[1]!.url, "http://x").searchParams.get("starting_after")).toBe("po_0100");
    expect(lists.every((x) => x.method === "GET" && x.headers.authorization === `Bearer ${READ}`)).toBe(true);
  });

  it("findOperationEvidence: an error after page 1 returns what was read with complete false", async () => {
    let n = 0;
    stub.handler = withAccount(() => {
      n += 1;
      return n === 1
        ? { status: 200, body: { data: [providerObject({ id: "po_0001" })], has_more: true, next_cursor: "po_0001" } }
        : { status: 503 };
    });
    const p = await SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
    const r = await p.findOperationEvidence({ account: ACCOUNT, payeeRef: "payee_P02", parentRef: null, since: new Date(0) });
    expect(r.complete).toBe(false);
    expect(r.records.map((o) => o.id)).toEqual(["po_0001"]);
  });

  it("findOperationEvidence: a transport failure, an unparsable object or the page cap makes complete false", async () => {
    stub.handler = withAccount(() => ({ destroy: true }));
    let p = await SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
    expect(await p.findOperationEvidence({ account: ACCOUNT, payeeRef: "x", parentRef: null, since: new Date(0) })).toEqual({ records: [], complete: false });

    stub.handler = withAccount(() => ({ status: 200, body: { data: [providerObject(), { id: "junk" }], has_more: false, next_cursor: null } }));
    p = await SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
    const bad = await p.findOperationEvidence({ account: ACCOUNT, payeeRef: "x", parentRef: null, since: new Date(0) });
    expect(bad.complete).toBe(false);
    expect(bad.records).toHaveLength(1);

    stub.handler = pagedList((MAX_EVIDENCE_PAGES + 5) * 100);
    p = await SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
    const capped = await p.findOperationEvidence({ account: ACCOUNT, payeeRef: "x", parentRef: null, since: new Date(0) });
    expect(capped.complete).toBe(false);
    expect(capped.records).toHaveLength(MAX_EVIDENCE_PAGES * 100);
  });

  it("listOperations is an async iterable over every page; since becomes created_gte; a failed page throws ProviderReadError", async () => {
    stub.handler = pagedList(230);
    const p = await SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
    const ids: string[] = [];
    for await (const o of p.listOperations({ account: ACCOUNT, since: new Date("2026-11-14T00:00:00.000Z") })) ids.push(o.id);
    expect(ids).toHaveLength(230);
    expect(new Set(ids).size).toBe(230);
    const lists = stub.requests.filter((x) => x.url.startsWith("/v1/payouts?"));
    expect(new URL(lists[0]!.url, "http://x").searchParams.get("created_gte")).toBe("2026-11-14T00:00:00.000Z");
    expect(new URL(lists[0]!.url, "http://x").searchParams.get("payee_ref")).toBeNull();

    stub.handler = withAccount(() => ({ status: 500 }));
    const q = await SimPayoutProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
    await expect(
      (async () => {
        for await (const _ of q.listOperations({ account: ACCOUNT })) void _;
      })(),
    ).rejects.toBeInstanceOf(ProviderReadError);
  });

  it("the three read methods issue only GET", async () => {
    stub.handler = withAccount((req) =>
      req.url.startsWith("/v1/payouts?") ? { status: 200, body: { data: [], has_more: false, next_cursor: null } } : { status: 404, body: { error: { code: "not_found", message: "m" } } },
    );
    const p = await SimKeylessProvider.create({ baseUrl: stub.baseUrl, account: ACCOUNT, writeKey: WRITE, readKey: READ });
    await p.getOperation("po_x");
    await p.findOperationEvidence({ account: ACCOUNT, payeeRef: "x", parentRef: null, since: new Date(0) });
    for await (const _ of p.listOperations({ account: ACCOUNT })) void _;
    expect(stub.requests.every((r) => r.method === "GET")).toBe(true);
    expect(stub.requests.length).toBeGreaterThanOrEqual(4);
  });
});

describe("createProvider(id, env)", () => {
  it("builds the simulator providers from the environment (account = acct_<run id>; read key falls back to the write key)", async () => {
    stub.handler = withAccount(() => ({ status: 500 }), { ...ACCOUNT_BODY, account: "acct_r7k2m9qa" });
    const p = await createProvider("sim_payout", { NT_SIM_URL: stub.baseUrl, NT_SIM_WRITE_KEY: WRITE, NT_RUN_ID: "r7k2m9qa" });
    expect(p.id).toBe("sim_payout");
    expect(stub.requests[0]!.url).toBe("/v1/accounts/acct_r7k2m9qa");
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${WRITE}`);
    const k = await createProvider("sim_keyless", { NT_SIM_URL: stub.baseUrl, NT_SIM_WRITE_KEY: WRITE, NT_SIM_READ_KEY: READ, account: "acct_x" });
    expect(k.id).toBe("sim_keyless");
    expect(stub.requests[1]!.url).toBe("/v1/accounts/acct_x");
    expect(stub.requests[1]!.headers.authorization).toBe(`Bearer ${READ}`);
  });

  it("a missing write key or run id is a ProviderConfigError", async () => {
    await expect(createProvider("sim_payout", { NT_SIM_URL: stub.baseUrl, NT_RUN_ID: "r7k2m9qa" })).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(createProvider("sim_payout", { NT_SIM_URL: stub.baseUrl, NT_SIM_WRITE_KEY: WRITE })).rejects.toBeInstanceOf(ProviderConfigError);
  });
});
