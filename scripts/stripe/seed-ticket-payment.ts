// Creates the P03 test ticket purchase in Stripe TEST mode and prints the PaymentIntent id (pi_...) on stdout.
// The id becomes the booking's ticket_payment_ref and the frozen request's parent_ref for the TICKET_REFUND obligation.
//
//   node --env-file=.env scripts/stripe/seed-ticket-payment.ts [--run-id r2n6d4kx] [--booking-ref LM2P8D] [--passenger-id P03] [--amount-minor 41260]
//
// Reads STRIPE_SECRET_KEY from the environment; refuses anything that is not a test-mode key (^(sk|rk)_test_). Creates test-mode
// objects only. Diagnostics go to stderr; stdout carries only the pi_ id so a caller can capture it. The key is never printed.
import { parseArgs } from "node:util";
import { createTestTicketPurchase, TICKET_AMOUNT_MINOR } from "../../packages/providers/src/stripe-seed.ts";

function randomRunId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let s = "r";
  for (let i = 0; i < 7; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const { values } = parseArgs({
  options: {
    "run-id": { type: "string" },
    "booking-ref": { type: "string", default: "LM2P8D" },
    "passenger-id": { type: "string", default: "P03" },
    "amount-minor": { type: "string", default: String(TICKET_AMOUNT_MINOR) },
  },
});

const secretKey = process.env["STRIPE_SECRET_KEY"];
if (!secretKey) {
  console.error("STRIPE_SECRET_KEY is not set (run with: node --env-file=.env scripts/stripe/seed-ticket-payment.ts)");
  process.exit(1);
}
const runId = values["run-id"] ?? randomRunId();
if (!/^r[0-9a-z]{7}$/.test(runId)) {
  console.error("--run-id must be 'r' plus 7 lowercase base-36 characters");
  process.exit(1);
}
try {
  const purchase = await createTestTicketPurchase({
    secretKey,
    runId,
    bookingRef: values["booking-ref"]!,
    passengerId: values["passenger-id"]!,
    amountMinor: Number(values["amount-minor"]),
  });
  console.error(`created Stripe TEST-mode PaymentIntent for run ${runId}: ${purchase.amountMinor} ${purchase.currency}, status ${purchase.status}`);
  console.log(purchase.paymentIntentId);
} catch (e) {
  console.error(`seed failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
