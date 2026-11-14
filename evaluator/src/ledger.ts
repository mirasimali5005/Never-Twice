// Ledger object shape shared by every ledger source the evaluator reads, and the plug-in point for sources.
// A source only ever issues GET requests with a read-only key.

export class LedgerError extends Error {}

export type LedgerSourceId = "sim" | "stripe";

export type LedgerObject = {
  source: LedgerSourceId;
  id: string;
  kind: string;               // "payout" | "refund"
  status: string;
  amount_minor: number;
  currency: string;
  payee_ref: string | null;   // Stripe refunds carry it in metadata.nt_payee_ref (task F4); null when absent (check C9)
  parent_ref: string | null;
  metadata: Record<string, string>;
  created_at: string;
};

/** Statuses that count as a payment, per source (ARCHITECTURE §6.3 ACCEPTED_STATUSES, the evaluator's own copy). */
export const ACCEPTED_STATUSES: Record<LedgerSourceId, ReadonlySet<string>> = {
  sim: new Set(["paid"]),
  stripe: new Set(["succeeded", "pending"]),
};

export function isPayment(o: LedgerObject): boolean {
  return ACCEPTED_STATUSES[o.source].has(o.status);
}

export interface LedgerSource {
  readonly id: LedgerSourceId;
  /** Every object for the run, all pages. Throws LedgerError when the ledger cannot be read completely. */
  readAll(runId: string): Promise<LedgerObject[]>;
}

// ---------------------------------------------------------------------------------------------
// SECOND LEDGER SOURCE PLUG-IN POINT (task F4, Stripe refund reader).
// F4 adds evaluator/src/ledger-stripe.ts exporting a LedgerSource with id "stripe" that:
//   - refuses to start unless EVAL_STRIPE_KEY matches ^rk_test_ (exit 2 before any request);
//   - lists refunds over HTTPS (top-level list, never Search), keeps metadata.nt_run_id === runId;
//   - maps each refund to LedgerObject with source "stripe", payee_ref from metadata.nt_payee_ref.
// Then cli.ts `buildLedgerSources` returns it beside the simulator source. Nothing else changes:
// checker.ts already treats source "stripe" objects with ACCEPTED_STATUSES.stripe.
// ---------------------------------------------------------------------------------------------

export async function readAllSources(sources: LedgerSource[], runId: string): Promise<{ objects: LedgerObject[]; counts: Partial<Record<LedgerSourceId, number>> }> {
  const objects: LedgerObject[] = [];
  const counts: Partial<Record<LedgerSourceId, number>> = {};
  for (const src of sources) {
    const got = await src.readAll(runId);
    counts[src.id] = got.length;
    objects.push(...got);
  }
  return { objects, counts };
}
