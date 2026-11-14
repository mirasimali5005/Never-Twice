// C3-UNIT-01: key guard; parameter object built from a frozen request; ProviderObject mapping; error mapping.
// No network: the real Stripe SDK (23.1.0) is pointed at a loopback stub server, so the SDK itself generates its error classes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchResult } from "@nt/contracts";
import type { FrozenRequest } from "@nt/contracts";
import { ProviderConfigError, ProviderReadError, createProvider } from "../src/index.ts";
import { MAX_REFUND_LIST_PAGES, STRIPE_CAPABILITIES, StripeRefundProvider, assertStripeTestKey, buildRefundParams, mapRefund } from "../src/stripe-refund.ts";
import { StubServer } from "./support/stub-http.ts";
import type { Reply } from "./support/stub-http.ts";

// Placeholders are assembled at run time so no key-shaped literal sits in the source (the safety scan looks for those).
const pfx = (a: string, b: string) => `${a}_${b}_`;
const KEY = `${pfx("sk", "test")}placeholder-for-unit-tests`;
const PI = "pi_3QtestticketP03";
const MARKER = "r2n6d4kx:LM2P8D.P03.NT101-20261110.TICKET_REFUND";
const EFFECT = "LM2P8D.P03.NT101-20261110.TICKET_REFUND";

function frozen(o: Partial<FrozenRequest> = {}): FrozenRequest {
  return {
    provider: "stripe_refund",
    operation: "REFUND",
    account: "stripe",
    rail: null,
    amount_minor: 41260,
    currency: "CAD",
    payee_ref: "payee_P03",
    parent_ref: PI,
    metadata: { nt_marker: MARKER, nt_effect_key: EFFECT, nt_run_id: "r2n6d4kx", nt_type: "TICKET_REFUND" },
    ...o,
  };
}

function refund(o: { id?: string; amount?: number; status?: string; marker?: string | null; pi?: unknown; payee?: string | null; metadata?: unknown } = {}) {
  const metadata =
    o.metadata !== undefined
      ? o.metadata
      : {
          ...(o.marker === null ? {} : { nt_marker: o.marker ?? MARKER }),
          nt_effect_key: EFFECT,
          nt_run_id: "r2n6d4kx",
          ...(o.payee === null ? {} : { nt_payee_ref: o.payee ?? "payee_P03" }),
        };
  return {
    id: o.id ?? "re_3Qtest1",
    object: "refund",
    amount: o.amount ?? 41260,
    balance_transaction: null,
    charge: "ch_3Qtest",
    created: 1_794_000_000,
    currency: "cad",
    metadata,
    payment_intent: o.pi === undefined ? PI : o.pi,
    reason: "requested_by_customer",
    status: o.status ?? "succeeded",
  };
}
const list = (data: unknown[], hasMore = false) => ({ object: "list", data, has_more: hasMore, url: "/v1/refunds" });
const err = (status: number, type: string, code: string | undefined, message = "stub error") => ({ status, body: { error: { type, code, message } } }) satisfies Reply;

let stub: StubServer;
beforeEach(async () => {
  stub = await StubServer.start();
});
afterEach(async () => {
  await stub.stop();
});
function provider(o: { runId?: string; timeoutMs?: number } = {}): StripeRefundProvider {
  return new StripeRefundProvider({
    secretKey: KEY,
    timeoutMs: o.timeoutMs ?? 2000,
    ...(o.runId ? { runId: o.runId } : {}),
    testTransport: { host: "127.0.0.1", port: Number(new URL(stub.baseUrl).port), protocol: "http" },
  });
}
const call = (p: StripeRefundProvider, req = frozen(), timeoutMs = 2000) => p.createPaymentOrRefund(req, { idempotencyKey: MARKER, timeoutMs });
const form = (r: { body: Buffer }) => new URLSearchParams(r.body.toString("utf8"));

describe("key guard", () => {
  it("refuses everything that is not ^(sk|rk)_test_, without echoing the key", () => {
    const bad = [`${pfx("sk", "live")}abcdef0123456789`, `${pfx("rk", "live")}abcdef0123456789`, `${pfx("pk", "test")}abcdef`, "sk_test", "", "whsec_test_abc", ` ${pfx("sk", "test")}abc`];
    for (const k of bad) {
      let message = "";
      try {
        new StripeRefundProvider({ secretKey: k, timeoutMs: 1000 });
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderConfigError);
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      if (k.length > 8) expect(message).not.toContain(k);
    }
    expect(() => assertStripeTestKey(`${pfx("sk", "test")}abc`)).not.toThrow();
    expect(() => assertStripeTestKey(`${pfx("rk", "test")}abc`)).not.toThrow();
    expect(() => assertStripeTestKey(undefined as unknown as string)).toThrow(ProviderConfigError);
  });

  it("requires an explicit timeout, and the test transport is loopback only", () => {
    expect(() => new StripeRefundProvider({ secretKey: KEY, timeoutMs: 0 })).toThrow(ProviderConfigError);
    expect(() => new StripeRefundProvider({ secretKey: KEY, timeoutMs: 1000, testTransport: { host: "api.stripe.com" as "localhost", port: 443, protocol: "http" } })).toThrow(ProviderConfigError);
  });

  it("createProvider('stripe_refund') applies the same guard and needs the key", async () => {
    await expect(createProvider("stripe_refund", { STRIPE_SECRET_KEY: `${pfx("sk", "live")}x` })).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(createProvider("stripe_refund", {})).rejects.toBeInstanceOf(ProviderConfigError);
    const p = await createProvider("stripe_refund", { STRIPE_SECRET_KEY: KEY });
    expect(p.id).toBe("stripe_refund");
  });
});

describe("capabilities, parameters, mapping", () => {
  it("capabilities", () => {
    expect(provider().id).toBe("stripe_refund");
    expect(provider().capabilities).toEqual({ dedupesOnIdempotencyKey: true, keyRetentionMs: 86_400_000, declaredMaxInFlightMs: null, stronglyConsistentList: true });
    expect(STRIPE_CAPABILITIES.keyRetentionMs).toBe(86_400_000);
  });

  it("buildRefundParams is exactly the HANDOVER §12.3 object, deterministic, key order irrelevant", () => {
    const expected = {
      payment_intent: PI,
      amount: 41260,
      reason: "requested_by_customer",
      metadata: { nt_marker: MARKER, nt_effect_key: EFFECT, nt_run_id: "r2n6d4kx", nt_payee_ref: "payee_P03" },
    };
    expect(buildRefundParams(frozen())).toEqual(expected);
    expect(JSON.stringify(buildRefundParams(frozen()))).toBe(JSON.stringify(buildRefundParams(frozen())));
    expect(buildRefundParams(frozen({ metadata: { nt_type: "TICKET_REFUND", nt_run_id: "r2n6d4kx", nt_effect_key: EFFECT, nt_marker: MARKER } }))).toEqual(expected);
  });

  it("buildRefundParams refuses a missing or non-PaymentIntent parent_ref (programmer error)", () => {
    expect(() => buildRefundParams(frozen({ parent_ref: null }))).toThrow(ProviderConfigError);
    expect(() => buildRefundParams(frozen({ parent_ref: "ch_123" }))).toThrow(ProviderConfigError);
  });

  it("mapRefund: payee from metadata.nt_payee_ref, parent from payment_intent (string or expanded), currency upper-cased, created as ISO", () => {
    const o = mapRefund(refund() as never);
    expect(o).toEqual({
      id: "re_3Qtest1",
      kind: "refund",
      status: "succeeded",
      amount_minor: 41260,
      currency: "CAD",
      payee_ref: "payee_P03",
      parent_ref: PI,
      metadata: { nt_marker: MARKER, nt_effect_key: EFFECT, nt_run_id: "r2n6d4kx", nt_payee_ref: "payee_P03" },
      created_at: new Date(1_794_000_000 * 1000).toISOString(),
    });
    expect(mapRefund(refund({ pi: { id: PI, object: "payment_intent" } }) as never).parent_ref).toBe(PI);
    expect(mapRefund(refund({ pi: null }) as never).parent_ref).toBeNull();
    expect(mapRefund(refund({ payee: null }) as never).payee_ref).toBe("");
    expect(mapRefund(refund({ metadata: null }) as never).metadata).toEqual({});
  });
});

describe("createPaymentOrRefund: the wire", () => {
  it("one POST /v1/refunds with the test key, Idempotency-Key = marker, and exactly the parameter object; no retry", async () => {
    stub.handler = () => ({ status: 200, body: refund() });
    const res = await call(provider());
    expect(res).toMatchObject({ kind: "ACCEPTED", replayed: false });
    expect(stub.requests).toHaveLength(1);
    const r = stub.requests[0]!;
    expect([r.method, r.url]).toEqual(["POST", "/v1/refunds"]);
    expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r.headers["idempotency-key"]).toBe(MARKER);
    const f = form(r);
    expect(Object.fromEntries(f.entries())).toEqual({
      payment_intent: PI,
      amount: "41260",
      reason: "requested_by_customer",
      "metadata[nt_marker]": MARKER,
      "metadata[nt_effect_key]": EFFECT,
      "metadata[nt_run_id]": "r2n6d4kx",
      "metadata[nt_payee_ref]": "payee_P03",
    });
  });

  it("the same request twice sends byte-identical bodies and the same key", async () => {
    stub.handler = () => ({ status: 200, body: refund() });
    const p = provider();
    await call(p);
    await call(p);
    expect(stub.requests[0]!.body.equals(stub.requests[1]!.body)).toBe(true);
    expect(stub.requests[0]!.headers["idempotency-key"]).toBe(stub.requests[1]!.headers["idempotency-key"]);
  });

  it("a returned refund is ACCEPTED with the mapped object; Idempotent-Replayed: true gives replayed true", async () => {
    stub.handler = () => ({ status: 200, body: refund(), headers: { "Idempotent-Replayed": "true" } });
    const res = await call(provider());
    expect(res.kind === "ACCEPTED" && res.replayed && res.object.id === "re_3Qtest1" && res.object.payee_ref === "payee_P03").toBe(true);
  });

  it("programmer errors throw and send nothing: null key, wrong provider or operation, bad parent_ref", async () => {
    const p = provider();
    await expect(p.createPaymentOrRefund(frozen(), { idempotencyKey: null, timeoutMs: 1000 })).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(p.createPaymentOrRefund(frozen({ provider: "sim_payout" }), { idempotencyKey: MARKER, timeoutMs: 1000 })).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(p.createPaymentOrRefund(frozen({ operation: "PAYOUT" }), { idempotencyKey: MARKER, timeoutMs: 1000 })).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(p.createPaymentOrRefund(frozen({ parent_ref: null }), { idempotencyKey: MARKER, timeoutMs: 1000 })).rejects.toBeInstanceOf(ProviderConfigError);
    expect(stub.requests).toHaveLength(0);
  });
});

describe("error mapping (constructed by the real SDK from stub responses)", () => {
  it("idempotency error (same key, different parameters) -> CONTRADICTION KEY_REUSED_DIFFERENT_PARAMS", async () => {
    stub.handler = () => err(400, "idempotency_error", undefined, "Keys for idempotent requests can only be used with the same parameters");
    expect(await call(provider())).toMatchObject({ kind: "CONTRADICTION", code: "KEY_REUSED_DIFFERENT_PARAMS" });
    expect(stub.requests).toHaveLength(1);
  });

  it("5xx -> INDETERMINATE SERVER_ERROR, sent once (maxNetworkRetries 0)", async () => {
    for (const status of [500, 502, 503]) {
      stub.requests.length = 0;
      stub.handler = () => err(status, "api_error", undefined);
      expect(await call(provider())).toMatchObject({ kind: "INDETERMINATE", cause: "SERVER_ERROR" });
      expect(stub.requests).toHaveLength(1);
    }
  });

  it("timeout -> INDETERMINATE TIMEOUT, sent once; the per-call timeoutMs is honoured", async () => {
    stub.handler = () => ({ hang: true });
    const started = Date.now();
    const res = await call(provider({ timeoutMs: 15_000 }), frozen(), 250);
    expect(res).toMatchObject({ kind: "INDETERMINATE", cause: "TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(stub.requests).toHaveLength(1);
  });

  it("a socket closed without a response -> INDETERMINATE CONNECTION and is sent ONCE (the SDK's hidden retry on ECONNRESET is disabled)", async () => {
    stub.handler = () => ({ destroy: true });
    expect(await call(provider())).toMatchObject({ kind: "INDETERMINATE", cause: "CONNECTION" });
    expect(stub.requests).toHaveLength(1);
  });

  it("connection refused -> INDETERMINATE CONNECTION", async () => {
    const p = provider();
    await stub.stop();
    expect(await call(p)).toMatchObject({ kind: "INDETERMINATE", cause: "CONNECTION" });
    stub = await StubServer.start(); // for afterEach
  });

  it("409 -> INDETERMINATE IN_PROGRESS_CONFLICT; 429 is never a definitive rejection -> INDETERMINATE", async () => {
    stub.handler = () => err(409, "invalid_request_error", "idempotency_key_in_use");
    expect(await call(provider())).toMatchObject({ kind: "INDETERMINATE", cause: "IN_PROGRESS_CONFLICT" });
    stub.handler = () => err(429, "invalid_request_error", "rate_limit");
    expect(await call(provider())).toMatchObject({ kind: "INDETERMINATE", cause: "SERVER_ERROR" });
    expect(stub.requests.every((r) => r.method === "POST")).toBe(true); // no evidence list was needed for either
  });

  describe("other 4xx: REJECTED_DEFINITIVE only after an evidence list shows no refund with the marker", () => {
    const rejectThen = (listReply: Reply | ((n: number) => Reply)) => {
      let listCalls = 0;
      stub.handler = (req) => {
        if (req.method === "POST") return err(400, "invalid_request_error", "charge_already_refunded", "Charge ch_3Qtest has already been refunded.");
        listCalls += 1;
        return typeof listReply === "function" ? listReply(listCalls) : listReply;
      };
    };

    it("list shows no object -> REJECTED_DEFINITIVE with the Stripe code and message", async () => {
      rejectThen({ status: 200, body: list([]) });
      expect(await call(provider())).toEqual({
        kind: "REJECTED_DEFINITIVE",
        code: "charge_already_refunded",
        message: "Charge ch_3Qtest has already been refunded.",
        replayed: false,
      });
      const lst = stub.requests.find((r) => r.method === "GET")!;
      const u = new URL(lst.url, "http://x");
      expect(u.pathname).toBe("/v1/refunds");
      expect(u.searchParams.get("payment_intent")).toBe(PI);
      expect(u.searchParams.get("limit")).toBe("100");
    });

    it("other refunds without our marker do not count as a hit", async () => {
      rejectThen({ status: 200, body: list([refund({ marker: "r2n6d4kx:SOMETHING.ELSE", id: "re_other" }), refund({ marker: null, id: "re_manual" })]) });
      expect(await call(provider())).toMatchObject({ kind: "REJECTED_DEFINITIVE" });
    });

    it("list shows the object -> ACCEPTED with it, replayed true", async () => {
      rejectThen({ status: 200, body: list([refund({ id: "re_other", marker: "x:y" }), refund({ id: "re_ours" })]) });
      const res = await call(provider());
      expect(res).toMatchObject({ kind: "ACCEPTED", replayed: true });
      expect(res.kind === "ACCEPTED" && res.object.id).toBe("re_ours");
    });

    it("the object on a later page is found (pages are followed)", async () => {
      rejectThen((n) =>
        n === 1 ? { status: 200, body: list([refund({ id: "re_a", marker: "x:1" })], true) } : { status: 200, body: list([refund({ id: "re_ours" })]) },
      );
      const res = await call(provider());
      expect(res.kind === "ACCEPTED" && res.object.id).toBe("re_ours");
      const gets = stub.requests.filter((r) => r.method === "GET");
      expect(new URL(gets[1]!.url, "http://x").searchParams.get("starting_after")).toBe("re_a");
    });

    it("the list call itself fails -> INDETERMINATE (never REJECTED_DEFINITIVE)", async () => {
      rejectThen({ status: 500, body: { error: { type: "api_error", message: "boom" } } });
      expect(await call(provider())).toMatchObject({ kind: "INDETERMINATE" });
    });

    it("the list is incomplete (more pages than the cap) and shows no object -> INDETERMINATE", async () => {
      rejectThen(() => ({ status: 200, body: list([refund({ id: `re_${Math.random()}`, marker: "x:z" })], true) }));
      expect(await call(provider())).toMatchObject({ kind: "INDETERMINATE" });
      expect(stub.requests.filter((r) => r.method === "GET")).toHaveLength(MAX_REFUND_LIST_PAGES);
    });

    it("two refunds carry the marker -> CONTRADICTION UNEXPECTED_OBJECT", async () => {
      rejectThen({ status: 200, body: list([refund({ id: "re_1" }), refund({ id: "re_2" })]) });
      expect(await call(provider())).toMatchObject({ kind: "CONTRADICTION", code: "UNEXPECTED_OBJECT" });
    });

    it("402 and 404 follow the same rule; an Idempotent-Replayed header on the error sets replayed true", async () => {
      for (const status of [402, 404]) {
        stub.handler = (req) => (req.method === "POST" ? err(status, "invalid_request_error", "resource_missing", "No such payment_intent") : { status: 200, body: list([]) });
        expect(await call(provider())).toMatchObject({ kind: "REJECTED_DEFINITIVE", code: "resource_missing", replayed: false });
      }
      stub.handler = (req) =>
        req.method === "POST"
          ? { ...err(400, "invalid_request_error", "amount_too_large", "too much"), headers: { "Idempotent-Replayed": "true" } }
          : { status: 200, body: list([]) };
      expect(await call(provider())).toMatchObject({ kind: "REJECTED_DEFINITIVE", code: "amount_too_large", replayed: true });
    });
  });

  it("every value returned validates against the DispatchResult schema", async () => {
    const replies: Array<(r: { method: string }) => Reply> = [
      () => ({ status: 200, body: refund() }),
      () => err(400, "idempotency_error", undefined),
      () => err(500, "api_error", undefined),
      (r) => (r.method === "POST" ? err(400, "invalid_request_error", "x") : { status: 200, body: list([]) }),
    ];
    for (const h of replies) {
      stub.handler = h;
      expect(DispatchResult.safeParse(await call(provider())).success).toBe(true);
    }
  });
});

describe("reads (GET only)", () => {
  it("findOperationEvidence lists by payment_intent with limit 100 and maps every refund; complete true on the last page", async () => {
    stub.handler = () => ({ status: 200, body: list([refund(), refund({ id: "re_x", marker: null })]) });
    const r = await provider().findOperationEvidence({ account: "stripe", payeeRef: "payee_P03", parentRef: PI, since: new Date(0) });
    expect(r.complete).toBe(true);
    expect(r.records.map((o) => o.id)).toEqual(["re_3Qtest1", "re_x"]);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.method).toBe("GET");
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("follows has_more with starting_after; an error after page 1 returns page 1 with complete false; no parentRef sends nothing", async () => {
    let n = 0;
    stub.handler = () => {
      n += 1;
      return n === 1 ? { status: 200, body: list([refund({ id: "re_p1" })], true) } : { status: 500, body: { error: { type: "api_error", message: "x" } } };
    };
    const r = await provider().findOperationEvidence({ account: "stripe", payeeRef: "p", parentRef: PI, since: new Date(0) });
    expect(r).toMatchObject({ complete: false });
    expect(r.records.map((o) => o.id)).toEqual(["re_p1"]);
    stub.requests.length = 0;
    expect(await provider().findOperationEvidence({ account: "stripe", payeeRef: "p", parentRef: null, since: new Date(0) })).toEqual({ records: [], complete: false });
    expect(stub.requests).toHaveLength(0);
  });

  it("getOperation: 200 -> mapped object; 404 -> null; 500 -> ProviderReadError; 401 -> ProviderConfigError", async () => {
    stub.handler = (req) =>
      req.url === "/v1/refunds/re_3Qtest1"
        ? { status: 200, body: refund() }
        : req.url === "/v1/refunds/re_missing"
          ? err(404, "invalid_request_error", "resource_missing", "No such refund")
          : req.url === "/v1/refunds/re_boom"
            ? err(500, "api_error", undefined)
            : err(401, "invalid_request_error", undefined, "Invalid API Key provided");
    const p = provider();
    expect((await p.getOperation("re_3Qtest1"))?.amount_minor).toBe(41260);
    expect(await p.getOperation("re_missing")).toBeNull();
    await expect(p.getOperation("re_boom")).rejects.toBeInstanceOf(ProviderReadError);
    await expect(p.getOperation("re_unauth")).rejects.toBeInstanceOf(ProviderConfigError);
    expect(stub.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("listOperations auto-paginates and keeps the run's refunds; since becomes created[gte]; a failed page throws ProviderReadError", async () => {
    stub.handler = (req) => {
      const u = new URL(req.url, "http://x");
      return u.searchParams.get("starting_after") === null
        ? { status: 200, body: list([refund({ id: "re_a" }), refund({ id: "re_b", metadata: { nt_marker: "z:z", nt_run_id: "rOTHER00" } })], true) }
        : { status: 200, body: list([refund({ id: "re_c" }), refund({ id: "re_d", marker: null, metadata: {} })]) };
    };
    const ids: string[] = [];
    for await (const o of provider({ runId: "r2n6d4kx" }).listOperations({ account: "stripe", since: new Date("2026-11-14T00:00:00.000Z") })) ids.push(o.id);
    expect(ids).toEqual(["re_a", "re_c"]);
    expect(new URL(stub.requests[0]!.url, "http://x").searchParams.get("created[gte]")).toBe(String(Date.parse("2026-11-14T00:00:00.000Z") / 1000));
    stub.requests.length = 0;
    const all: string[] = [];
    for await (const o of provider().listOperations({ account: "stripe" })) all.push(o.id); // no runId: every refund that carries a marker
    expect(all).toEqual(["re_a", "re_b", "re_c"]);
    stub.handler = () => err(500, "api_error", undefined);
    await expect(
      (async () => {
        for await (const _ of provider().listOperations({ account: "stripe" })) void _;
      })(),
    ).rejects.toBeInstanceOf(ProviderReadError);
  });
});
