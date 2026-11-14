// C3-INT-01 / PAY-16 (provider half): the real Stripe API in TEST mode. Skipped unless STRIPE_SECRET_KEY is set (it is read from the
// repository's .env when present). Creates test-mode objects only; a key that is not ^(sk|rk)_test_ fails the suite instead of being used.
// Needs network. Never prints the key.
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ACCEPTED_STATUSES, STRIPE_TEST_KEY_RE } from "@nt/contracts";
import type { FrozenRequest, ProviderObject } from "@nt/contracts";
import { FaultInjectingProvider } from "../src/index.ts";
import { StripeRefundProvider } from "../src/stripe-refund.ts";
import { createTestTicketPurchase } from "../src/stripe-seed.ts";

if (!process.env["STRIPE_SECRET_KEY"]) {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  } catch {
    /* no .env: the suite is skipped */
  }
}
const SECRET = process.env["STRIPE_SECRET_KEY"] ?? "";
const enabled = SECRET !== "";

const RUN = `r${Math.random().toString(36).slice(2, 9).padEnd(7, "0")}`;
const EFFECT = "LM2P8D.P03.NT101-20261110.TICKET_REFUND";
const MARKER = `${RUN}:${EFFECT}`;
const OPTS = { idempotencyKey: MARKER, timeoutMs: 30_000 };

function refundReq(pi: string, o: { amount?: number; marker?: string } = {}): FrozenRequest {
  const marker = o.marker ?? MARKER;
  return {
    provider: "stripe_refund",
    operation: "REFUND",
    account: "stripe",
    rail: null,
    amount_minor: o.amount ?? 41260,
    currency: "CAD",
    payee_ref: "payee_P03",
    parent_ref: pi,
    metadata: { nt_marker: marker, nt_effect_key: marker.split(":")[1]!, nt_run_id: RUN, nt_type: "TICKET_REFUND" },
  };
}

describe.skipIf(!enabled)("Stripe test mode: the ticket-refund leg", () => {
  let provider: StripeRefundProvider;
  let pi = "";
  let first: ProviderObject;

  beforeAll(() => {
    expect(STRIPE_TEST_KEY_RE.test(SECRET), "STRIPE_SECRET_KEY must be a test-mode key").toBe(true);
    provider = new StripeRefundProvider({ secretKey: SECRET, timeoutMs: 30_000, runId: RUN });
  });

  it("seeds the P03 ticket purchase (41260 CAD) in test mode", async () => {
    const purchase = await createTestTicketPurchase({ secretKey: SECRET, runId: RUN, bookingRef: "LM2P8D", passengerId: "P03" });
    pi = purchase.paymentIntentId;
    expect(pi).toMatch(/^pi_/);
    expect(purchase).toMatchObject({ status: "succeeded", amountMinor: 41260, currency: "CAD" });
  }, 60_000);

  it("refunds 41260 with the marker: ACCEPTED, replayed false, fields as frozen", async () => {
    const res = await provider.createPaymentOrRefund(refundReq(pi), OPTS);
    expect(res.kind).toBe("ACCEPTED");
    if (res.kind !== "ACCEPTED") return;
    first = res.object;
    expect(res.replayed).toBe(false);
    expect(first).toMatchObject({ kind: "refund", amount_minor: 41260, currency: "CAD", payee_ref: "payee_P03", parent_ref: pi });
    expect(first.id).toMatch(/^re_/);
    expect(first.metadata).toMatchObject({ nt_marker: MARKER, nt_effect_key: EFFECT, nt_run_id: RUN, nt_payee_ref: "payee_P03" });
    expect(ACCEPTED_STATUSES.stripe_refund.has(first.status)).toBe(true);
  }, 60_000);

  it("replays the same key and the same parameters: the same refund comes back, replayed true", async () => {
    const res = await provider.createPaymentOrRefund(refundReq(pi), OPTS);
    expect(res.kind).toBe("ACCEPTED");
    if (res.kind !== "ACCEPTED") return;
    expect(res.object.id).toBe(first.id);
    expect(res.replayed).toBe(true);
  }, 60_000);

  it("lists evidence by payment intent: exactly one refund carries the marker; getOperation reads the same object", async () => {
    const ev = await provider.findOperationEvidence({ account: "stripe", payeeRef: "payee_P03", parentRef: pi, since: new Date(Date.now() - 3_600_000) });
    expect(ev.complete).toBe(true);
    const hits = ev.records.filter((r) => r.metadata["nt_marker"] === MARKER);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: first.id, amount_minor: 41260, currency: "CAD", payee_ref: "payee_P03", parent_ref: pi });
    expect(ev.records).toHaveLength(1);
    expect(await provider.getOperation(first.id)).toMatchObject({ id: first.id, status: first.status });
    expect(await provider.getOperation("re_doesnotexist000000000000")).toBeNull();
  }, 60_000);

  it("the same key with different parameters is an idempotency error: CONTRADICTION KEY_REUSED_DIFFERENT_PARAMS; still one refund", async () => {
    const res = await provider.createPaymentOrRefund(refundReq(pi, { amount: 100 }), OPTS);
    expect(res).toMatchObject({ kind: "CONTRADICTION", code: "KEY_REUSED_DIFFERENT_PARAMS" });
    const ev = await provider.findOperationEvidence({ account: "stripe", payeeRef: "payee_P03", parentRef: pi, since: new Date(0) });
    expect(ev.records.filter((r) => r.metadata["nt_marker"] === MARKER)).toHaveLength(1);
  }, 60_000);

  it("an over-refund (a new key; nothing left to refund) is a 4xx: REJECTED_DEFINITIVE, only after the list shows no refund with that marker", async () => {
    const other = `${RUN}:LM2P8D.P03.NT101-20261110.TICKET_REFUND_EXTRA`;
    const res = await provider.createPaymentOrRefund(refundReq(pi, { marker: other }), { idempotencyKey: other, timeoutMs: 30_000 });
    expect(res.kind).toBe("REJECTED_DEFINITIVE");
    if (res.kind === "REJECTED_DEFINITIVE") {
      expect(res.replayed).toBe(false);
      expect(res.code).not.toBe("");
    }
    const ev = await provider.findOperationEvidence({ account: "stripe", payeeRef: "payee_P03", parentRef: pi, since: new Date(0) });
    expect(ev.records.filter((r) => r.metadata["nt_marker"] === other)).toHaveLength(0);
  }, 60_000);

  it("a refund for a payment intent that does not exist is never ACCEPTED", async () => {
    const m = `${RUN}:LM2P8D.P03.NT101-20261110.TICKET_REFUND_NOPI`;
    const res = await provider.createPaymentOrRefund(refundReq("pi_doesnotexist0000000000000", { marker: m }), { idempotencyKey: m, timeoutMs: 30_000 });
    expect(["REJECTED_DEFINITIVE", "INDETERMINATE"]).toContain(res.kind);
  }, 60_000);

  it("listOperations (invariant scan) yields this run's refund and no other run's", async () => {
    const mine: ProviderObject[] = [];
    for await (const o of provider.listOperations({ account: "stripe", since: new Date(Date.now() - 3_600_000) })) mine.push(o);
    expect(mine.map((o) => o.id)).toContain(first.id);
    expect(mine.every((o) => o.metadata["nt_run_id"] === RUN)).toBe(true);
  }, 60_000);

  it("client-side fault: the response is discarded after Stripe applied the refund; the evidence list finds it; the same-key re-send replays it", async () => {
    const m = `${RUN}:LM2P8D.P03.NT101-20261110.TICKET_REFUND_FAULT`;
    const purchase = await createTestTicketPurchase({ secretKey: SECRET, runId: RUN, bookingRef: "LM2P8D", passengerId: "P03F", amountMinor: 5000 });
    const faulty = new FaultInjectingProvider(provider, [{ match: { marker: m }, fault: "DISCARD_RESPONSE_AFTER_APPLY", times: 1 }]);
    const req = refundReq(purchase.paymentIntentId, { amount: 5000, marker: m });
    const o = { idempotencyKey: m, timeoutMs: 30_000 };
    expect(await faulty.createPaymentOrRefund(req, o)).toMatchObject({ kind: "INDETERMINATE", cause: "TIMEOUT" });
    const ev = await faulty.findOperationEvidence({ account: "stripe", payeeRef: "payee_P03", parentRef: purchase.paymentIntentId, since: new Date(Date.now() - 3_600_000) });
    const hits = ev.records.filter((r) => r.metadata["nt_marker"] === m);
    expect(hits).toHaveLength(1); // read-after-write: the list is immediately consistent
    const resend = await faulty.createPaymentOrRefund(req, o);
    expect(resend.kind === "ACCEPTED" && resend.replayed && resend.object.id === hits[0]!.id).toBe(true);
    const after = await faulty.findOperationEvidence({ account: "stripe", payeeRef: "payee_P03", parentRef: purchase.paymentIntentId, since: new Date(0) });
    expect(after.records.filter((r) => r.metadata["nt_marker"] === m)).toHaveLength(1);
  }, 120_000);
});
