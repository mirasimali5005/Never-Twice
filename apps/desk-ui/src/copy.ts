// Display words. Fixture names are the synthetic passengers of HANDOVER 7.4 (the API returns passenger ids only).
// Wording rules (HANDOVER 2): none of the banned words appear in UI text; "Confirmed" means the provider holds
// one matching payment object; "paid" is used only for the provider's own status word and for the statement's "paid twice".

export const PASSENGER_NAMES: Record<string, string> = {
  P01: "Amara Okafor", P02: "Daniel Whitlock", P03: "Sofia Marchetti", P04: "Grace Liu", P05: "Tomasz Nowak", P06: "Ewa Nowak",
  P07: "Jan Nowak", P08: "Priya Raman", P09: "Henrik Solberg", P10: "Marcus Bell", P11: "Leila Haddad", P12: "Camille Laurent",
  P13: "Oliver Grant", P14: "Hannah Weiss", P15: "Noah Fraser", P16: "Isabelle Roy", P17: "Victor Lang",
};
export const passengerName = (id: string): string => PASSENGER_NAMES[id] ?? id;

const TYPE_WORDS: Record<string, string> = {
  APPR_DELAY: "delay compensation",
  APPR_DENIED_BOARDING: "denied boarding",
  APPR_REFUND_COMP: "refund compensation",
  TICKET_REFUND: "ticket refund",
  GOODWILL: "goodwill",
};
export const typeWords = (t: string): string => TYPE_WORDS[t] ?? t;

const TYPE_SHORT: Record<string, string> = {
  APPR_DELAY: "delay",
  APPR_DENIED_BOARDING: "denied boarding",
  APPR_REFUND_COMP: "refund comp.",
  TICKET_REFUND: "ticket refund",
  GOODWILL: "goodwill",
};
export const typeShort = (t: string): string => TYPE_SHORT[t] ?? t;

const CAUSE_WORDS: Record<string, string> = {
  CREW_SCHED: "crew scheduling",
  OVERSALE: "oversold flight",
  SCHEDULE_CHANGE: "schedule change",
  WX_THEN_CREW_TIMEOUT: "weather, then crew timeout",
};
export const causeWords = (c: string): string => CAUSE_WORDS[c] ?? c;

const CONTROL_WORDS: Record<string, string> = {
  WITHIN_CONTROL: "within the airline's control",
  OUTSIDE_CONTROL: "outside the airline's control",
  SAFETY_REQUIRED: "required for safety",
  UNDETERMINED: "cause undetermined",
};
export const controlWords = (c: string): string => CONTROL_WORDS[c] ?? c;

export const PROVIDER_WORDS: Record<string, string> = {
  sim_payout: "simulated payout provider, instant rail",
  sim_keyless: "simulated payout provider, legacy rail (no keys)",
  stripe_refund: "Stripe (test mode)",
};

export const RAIL_WORDS: Record<string, string> = { instant: "instant rail (deduplicates on the key)", legacy: "legacy rail (no idempotency key)" };

export const EVIDENCE_SOURCE_WORDS: Record<string, string> = {
  RESPONSE: "the provider's direct answer",
  REDISPATCH: "the answer to the same-key re-send",
  PROBE: "a read of the provider's own list",
};

/** One-line reasons for the auditor's checks (HANDOVER 14). A finding's own message wins when it has one. */
export const CHECK_WORDS: Record<string, string> = {
  C1: "paid twice",
  C2: "wrong amount",
  C3: "not entitled",
  C4: "payment missing from the report",
  C5: "claimed paid, provider has no such payment",
  C6: "goodwill over the cap",
  C7: "reported complete while something was unresolved",
  C9: "wrong payee",
  C10: "manifest differs from the pre-run commitment",
};

export const CONFIRMED_SENTENCE = "Confirmed means: the provider holds one matching payment object.";
