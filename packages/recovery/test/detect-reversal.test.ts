// CP-REV-1: detectReversal is pure and acts only on positive evidence (a missing object never counts as a reversal).
import { describe, expect, it } from "vitest";
import type { Intent, ProviderObject } from "@nt/contracts";
import { detectReversal } from "../src/pure/index.ts";

const intent = (o: Partial<Intent> = {}) =>
  ({
    _id: "r1:K", state: "CONFIRMED", provider: "sim_payout", amount_minor: 70000, currency: "CAD", payee_ref: "payee_P02",
    evidence: { source: "RESPONSE", provider_object_id: "po_1", status: "paid", amount_minor: 70000, currency: "CAD", payee_ref: "payee_P02", marker: "r1:K", retrieved_at: new Date() },
    ...o,
  }) as Intent;
const object = (o: Partial<ProviderObject> = {}): ProviderObject => ({
  id: "po_1", kind: "payout", status: "paid", amount_minor: 70000, currency: "CAD", payee_ref: "payee_P02", parent_ref: null,
  metadata: { nt_marker: "r1:K" }, created_at: "2026-11-14T00:00:00Z", ...o,
});

describe("detectReversal", () => {
  it("paid → STILL_PAID; reversed or failed → REVERSED", () => {
    expect(detectReversal(intent(), object())).toEqual({ kind: "STILL_PAID" });
    expect(detectReversal(intent(), object({ status: "reversed" }))).toEqual({ kind: "REVERSED", status: "reversed" });
    expect(detectReversal(intent(), object({ status: "failed" }))).toEqual({ kind: "REVERSED", status: "failed" });
  });
  it("stripe: succeeded/pending still paid; failed/canceled reversed", () => {
    const s = intent({ provider: "stripe_refund" });
    expect(detectReversal(s, object({ status: "pending" })).kind).toBe("STILL_PAID");
    expect(detectReversal(s, object({ status: "canceled" })).kind).toBe("REVERSED");
  });
  it("anything that is not positive evidence changes nothing", () => {
    expect(detectReversal(intent(), null)).toEqual({ kind: "NOT_EVIDENCE", why: "OBJECT_NOT_FOUND" });
    expect(detectReversal(intent({ state: "QUARANTINED" }), object({ status: "reversed" })).kind).toBe("NOT_EVIDENCE");
    expect(detectReversal(intent({ evidence: null }), object({ status: "reversed" })).kind).toBe("NOT_EVIDENCE");
    expect(detectReversal(intent(), object({ status: "reversed", id: "po_2" })).kind).toBe("NOT_EVIDENCE");
    expect(detectReversal(intent(), object({ status: "reversed", metadata: { nt_marker: "r1:OTHER" } })).kind).toBe("NOT_EVIDENCE");
    expect(detectReversal(intent(), object({ status: "reversed", amount_minor: 1 })).kind).toBe("NOT_EVIDENCE");
    expect(detectReversal(intent(), object({ status: "in_transit" }))).toEqual({ kind: "NOT_EVIDENCE", why: "STATUS_in_transit" });
  });
});
