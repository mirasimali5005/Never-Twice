// B2-UNIT-01: buildFrozenRequest and providerFor.
import { describe, expect, it } from "vitest";
import { FrozenRequest, hashFrozenRequest } from "@nt/contracts";
import { ProgrammerError, buildFrozenRequest, idempotencyKeyFor, providerFor } from "../src/index.ts";
import { capsOnlyProvider, obligation } from "./support/world.ts";

const RUN = "r7k2m9qa";

describe("providerFor", () => {
  it("routes TICKET_REFUND to Stripe only when enabled, otherwise by rail", () => {
    expect(providerFor({ entitlement_type: "TICKET_REFUND", rail: "instant" }, true)).toBe("stripe_refund");
    expect(providerFor({ entitlement_type: "TICKET_REFUND", rail: "instant" }, false)).toBe("sim_payout");
    expect(providerFor({ entitlement_type: "TICKET_REFUND", rail: "legacy" }, false)).toBe("sim_keyless");
    for (const t of ["APPR_DELAY", "APPR_DENIED_BOARDING", "APPR_REFUND_COMP", "GOODWILL"] as const) {
      expect(providerFor({ entitlement_type: t, rail: "instant" }, true)).toBe("sim_payout");
      expect(providerFor({ entitlement_type: t, rail: "legacy" }, true)).toBe("sim_keyless");
    }
  });
});

describe("buildFrozenRequest", () => {
  it("builds the simulator payout of HANDOVER §9.3 from the obligation", () => {
    const ob = obligation(RUN, { passenger_id: "P02" });
    const fr = buildFrozenRequest(ob, "sim_payout", { runId: RUN });
    expect(FrozenRequest.parse(fr)).toEqual(fr);
    expect(fr).toEqual({
      provider: "sim_payout", operation: "PAYOUT", account: "acct_r7k2m9qa", rail: "instant", amount_minor: 70000, currency: "CAD",
      payee_ref: "payee_P02", parent_ref: null,
      metadata: { nt_marker: "r7k2m9qa:ZT4H9X.P02.NT101-20261110.APPR_DELAY", nt_effect_key: "ZT4H9X.P02.NT101-20261110.APPR_DELAY", nt_run_id: RUN, nt_type: "APPR_DELAY" },
    });
  });

  it("identical inputs give an identical hash; a different amount a different hash", () => {
    const ob = obligation(RUN, { passenger_id: "P03" });
    const a = hashFrozenRequest(buildFrozenRequest(ob, "sim_payout", { runId: RUN }));
    const b = hashFrozenRequest(buildFrozenRequest({ ...ob }, "sim_payout", { runId: RUN }));
    const c = hashFrozenRequest(buildFrozenRequest({ ...ob, amount_minor: 40000 }, "sim_payout", { runId: RUN }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("a simulator ticket refund is a REFUND; a Stripe refund needs the booking's payment reference", () => {
    const ob = obligation(RUN, { entitlement_type: "TICKET_REFUND", rail: "legacy" });
    expect(buildFrozenRequest(ob, "sim_keyless", { runId: RUN })).toMatchObject({ operation: "REFUND", rail: "legacy", parent_ref: null });
    expect(buildFrozenRequest(ob, "stripe_refund", { runId: RUN, ticketPaymentRef: "pi_123" })).toMatchObject({
      provider: "stripe_refund", operation: "REFUND", account: "stripe", rail: null, parent_ref: "pi_123",
    });
    expect(() => buildFrozenRequest(ob, "stripe_refund", { runId: RUN })).toThrow(ProgrammerError);
  });

  it("the keyless rail has a null idempotency key; a deduplicating rail uses the marker", () => {
    expect(idempotencyKeyFor("r7k2m9qa:K", capsOnlyProvider("sim_keyless", false).capabilities)).toBeNull();
    expect(idempotencyKeyFor("r7k2m9qa:K", capsOnlyProvider("sim_payout", true).capabilities)).toBe("r7k2m9qa:K");
  });
});
