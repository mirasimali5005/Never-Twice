// Seeds the P03 ticket purchase in Stripe TEST mode (task C3; HANDOVER §12.3 "Seed"; used by scripts/stripe/seed-ticket-payment.ts and
// task H1's seed script). The resulting pi_ id becomes the booking's ticket_payment_ref and the frozen request's parent_ref.
// Test mode only: refuses any key that is not ^(sk|rk)_test_. Creates test-mode objects; moves no real money.
import Stripe from "stripe";
import { assertStripeTestKey } from "./stripe-refund.ts";
import { ProviderConfigError } from "./http.ts";

export const TICKET_AMOUNT_MINOR = 41260;

export type TestTicketPurchase = { paymentIntentId: string; status: string; amountMinor: number; currency: string };

/** stripe.paymentIntents.create({ amount, currency: "cad", payment_method: "pm_card_visa", confirm: true,
 *    automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { nt_run_id, booking_ref, passenger_id } }).
 *  Throws ProviderConfigError if the key is not a test key or the payment did not succeed (a refund needs a captured payment). */
export async function createTestTicketPurchase(o: {
  secretKey: string;
  runId: string;
  bookingRef: string;
  passengerId: string;
  amountMinor?: number;
  timeoutMs?: number;
}): Promise<TestTicketPurchase> {
  assertStripeTestKey(o.secretKey);
  const amount = o.amountMinor ?? TICKET_AMOUNT_MINOR;
  if (!Number.isSafeInteger(amount) || amount < 1) throw new ProviderConfigError("amountMinor must be a positive integer");
  const stripe = new Stripe(o.secretKey, { maxNetworkRetries: 0, timeout: o.timeoutMs ?? 20_000, telemetry: false });
  const pi = await stripe.paymentIntents.create(
    {
      amount,
      currency: "cad",
      payment_method: "pm_card_visa",
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { nt_run_id: o.runId, booking_ref: o.bookingRef, passenger_id: o.passengerId },
    },
    // A re-run of the same seed (same run, booking and passenger) must not buy the ticket twice.
    { idempotencyKey: `nt-seed:${o.runId}:${o.bookingRef}:${o.passengerId}:${amount}` },
  );
  if (pi.status !== "succeeded") throw new ProviderConfigError(`test ticket purchase did not succeed (status ${pi.status})`);
  return { paymentIntentId: pi.id, status: pi.status, amountMinor: pi.amount, currency: pi.currency.toUpperCase() };
}
