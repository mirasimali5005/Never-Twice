// Deterministic claim resolver (HANDOVER.md §13). Pure: no model, no I/O, no clock, no database. The caller passes the run's bookings.
// Candidates: bookings whose reference appears in booking_refs; otherwise bookings on a named flight and date whose passenger names are
// similar (normalised token similarity >= 0.85) to a claimant name. One booking resolves; none is BOOKING_UNRESOLVED; more than one is
// BOOKING_AMBIGUOUS. Each claimed-for name must match a passenger on that booking, else PASSENGER_UNMATCHED. Hold order is fixed:
// BOOKING_UNRESOLVED, BOOKING_AMBIGUOUS, PASSENGER_UNMATCHED, then CLAIM_TEXT_SUSPICIOUS (booking and passengers resolved, injection suspected).
import type { Booking, ClaimExtraction, ClaimHoldReason, GoodwillKind } from "@nt/contracts";

export const NAME_SIMILARITY_THRESHOLD = 0.85;

/** The part of a bookings document the resolver reads. A stored Booking and an OpsBooking both satisfy it. */
export type ResolverBooking = {
  booking_ref: Booking["booking_ref"];
  passenger_id: Booking["passenger_id"];
  flight_no: Booking["flight_no"];
  passenger: { name: string };
  disruption: { scheduled_departure: string | Date };
  /** local departure date YYYY-MM-DD when the caller has it (ops-record flights carry it); otherwise the UTC date of the departure is used */
  flight_date?: string;
};

/** Claim metadata. Carried for the caller's trace; the resolution depends on the extraction and the bookings only. */
export type ClaimMeta = { claim_id?: string; channel?: string; received_at?: string };

export type Resolution =
  | {
      kind: "RESOLVED";
      booking_ref: string;
      passenger_ids: string[];
      method: "REFERENCE" | "NAME_FLIGHT_DATE";
      flags: { payeeChangeRequested: boolean; goodwillProposed: GoodwillKind | null };
    }
  | { kind: "HELD"; reason_code: Exclude<ClaimHoldReason, "EXTRACTION_FAILED">; detail: string };

// ---------------------------------------------------------------------------------------------------------------- similarity

/** Lower case, strip diacritics and punctuation, split into tokens. */
export function nameTokens(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

function tokenSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/**
 * Normalised token similarity in [0, 1]. Tokens are compared in any order (so "Whitlock, Daniel" equals "Daniel Whitlock"); each token of
 * the shorter name is matched to a distinct token of the other by edit similarity. The sum is divided by the shorter name's token count
 * (so a missing middle name does not hurt) when it has two or more tokens, otherwise by the longer name's count (a bare surname is weak).
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Set<number>();
  let sum = 0;
  for (const s of short) {
    let best = -1;
    let bestSim = 0;
    long.forEach((l, i) => {
      if (used.has(i)) return;
      const sim = tokenSimilarity(s, l);
      if (sim > bestSim) {
        bestSim = sim;
        best = i;
      }
    });
    if (best >= 0) used.add(best);
    sum += bestSim;
  }
  const denom = short.length >= 2 ? short.length : long.length;
  return sum / denom;
}

// ---------------------------------------------------------------------------------------------------------------- resolver

function flightDate(b: ResolverBooking): string {
  if (b.flight_date) return b.flight_date;
  const d = b.disruption.scheduled_departure;
  return (typeof d === "string" ? d : d.toISOString()).slice(0, 10);
}

const normFlight = (f: string): string => f.replace(/\s+/gu, "").toUpperCase();
const normRef = (r: string): string => r.replace(/\s+/gu, "").toUpperCase();

function distinctRefs(bs: ResolverBooking[]): string[] {
  return [...new Set(bs.map((b) => b.booking_ref))].sort();
}

function hold(reason_code: Exclude<ClaimHoldReason, "EXTRACTION_FAILED">, detail: string): Resolution {
  return { kind: "HELD", reason_code, detail };
}

export function resolve(extraction: ClaimExtraction, bookingsForRun: readonly ResolverBooking[], _claimMeta: ClaimMeta = {}): Resolution {
  // 1. candidate bookings: by reference first
  const refs = new Set(extraction.booking_refs.map(normRef).filter((r) => r.length > 0));
  let candidateRefs = distinctRefs(bookingsForRun.filter((b) => refs.has(b.booking_ref)));
  let method: "REFERENCE" | "NAME_FLIGHT_DATE" = "REFERENCE";

  // 2. otherwise flight + date + similar claimant name
  if (candidateRefs.length === 0) {
    method = "NAME_FLIGHT_DATE";
    const flights = new Set(extraction.flight_numbers.map(normFlight).filter((f) => f.length > 0));
    const names = [...extraction.claimant_names, ...extraction.passengers_claimed_for.map((p) => p.name)];
    if (flights.size > 0 && names.length > 0) {
      const date = extraction.travel_date;
      const onFlight = bookingsForRun.filter((b) => flights.has(normFlight(b.flight_no)) && (date === null || flightDate(b) === date));
      candidateRefs = distinctRefs(
        onFlight.filter((b) => names.some((n) => nameSimilarity(n, b.passenger.name) >= NAME_SIMILARITY_THRESHOLD)),
      );
    }
  }

  if (candidateRefs.length === 0) return hold("BOOKING_UNRESOLVED", "no booking matches a reference, or a flight, date and passenger name");
  if (candidateRefs.length > 1) return hold("BOOKING_AMBIGUOUS", `more than one booking matches: ${candidateRefs.join(", ")}`);
  const bookingRef = candidateRefs[0] as string;
  const onBooking = bookingsForRun.filter((b) => b.booking_ref === bookingRef);

  // 3. every claimed-for name must match one passenger on that booking (the writer, when no one is listed)
  const claimed = extraction.passengers_claimed_for.length > 0 ? extraction.passengers_claimed_for.map((p) => p.name) : extraction.claimant_names;
  if (claimed.length === 0) return hold("PASSENGER_UNMATCHED", "no passenger is named in the claim");
  const passengerIds = new Set<string>();
  const unmatched: string[] = [];
  for (const name of claimed) {
    const scored = onBooking
      .map((b) => ({ id: b.passenger_id, sim: nameSimilarity(name, b.passenger.name) }))
      .filter((s) => s.sim >= NAME_SIMILARITY_THRESHOLD)
      .sort((x, y) => y.sim - x.sim);
    const top = scored[0];
    const tied = top !== undefined && scored.some((s) => s.id !== top.id && s.sim === top.sim);
    if (top === undefined || tied) unmatched.push(name);
    else passengerIds.add(top.id);
  }
  if (unmatched.length > 0) return hold("PASSENGER_UNMATCHED", `not matched to a passenger on ${bookingRef}: ${unmatched.join("; ")}`);

  // 4. resolved, but the text tried to instruct the system: a person looks at it, nothing is paid on it
  if (extraction.injection_suspected) return hold("CLAIM_TEXT_SUSPICIOUS", `booking ${bookingRef} resolved, but the claim text is suspected of carrying instructions`);

  return {
    kind: "RESOLVED",
    booking_ref: bookingRef,
    passenger_ids: [...passengerIds].sort(),
    method,
    flags: {
      payeeChangeRequested: extraction.payee_change_request.requested,
      goodwillProposed: extraction.hardship.kind === "NONE" ? null : extraction.hardship.kind,
    },
  };
}
