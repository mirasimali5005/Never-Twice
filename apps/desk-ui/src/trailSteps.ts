// Turns one payment's trail (GET /payments/:effect_key) into ordered, readable steps. Pure: no data is invented, every line
// comes from a field of the response.
import { formatMoney, shortHash } from "./format";
import { EVIDENCE_SOURCE_WORDS, PROVIDER_WORDS, RAIL_WORDS, typeWords } from "./copy";
import { quarantineWords } from "./stateColour";
import type { AnyTrail, Attempt, BaselineTrail, InvestigationRecord, PaymentTrail } from "./types";

export type StepKind = "reserved" | "sent" | "hypothesis" | "query" | "matcher" | "licence" | "decision" | "evidence" | "pending" | "done";
export type Step = { kind: StepKind; label: string; text: string; tone?: "good" | "warn" | "stop" | "muted" };

export function isBaseline(t: AnyTrail): t is BaselineTrail {
  return (t as BaselineTrail).source === "baseline";
}

export function attemptResultWords(a: Attempt): string {
  const r = a.result;
  if (!r) return "no result recorded";
  switch (r.kind) {
    case "ACCEPTED": return r.replayed ? "provider answered: accepted (replay of the earlier request)" : "provider answered: accepted";
    case "REJECTED_DEFINITIVE": return `provider rejected it${r.code ? ` (${r.code})` : ""}`;
    case "INDETERMINATE": return `no usable answer${r.cause ? ` (${r.cause.toLowerCase().replace(/_/g, " ")})` : ""}`;
    case "CONTRADICTION": return `answer contradicts the request${r.code ? ` (${r.code})` : ""}`;
    case "LEASE_EXPIRED": return "no answer recorded: the sender's lease ran out";
    default: return r.kind;
  }
}

export function matchWords(m: InvestigationRecord["match"]): string {
  if (m === "MATCH") return "MATCH: one object agrees on marker, amount, currency and payee";
  if (m === "NO_MATCH") return "NO_MATCH: no object agrees on marker, amount, currency and payee";
  return "CONTRADICTION: the provider's records do not agree";
}

export function decisionWords(d: InvestigationRecord["decision"]): string {
  if (d.kind === "SETTLE") return `SETTLE (row ${d.row}): confirm on this evidence, send nothing`;
  if (d.kind === "REDISPATCH_SAME_KEY") return `REDISPATCH_SAME_KEY (row ${d.row}): send the identical request again under the same key`;
  return `QUARANTINE (row ${d.row}): ${quarantineWords(d.reason)}`;
}

export function trailSteps(trail: PaymentTrail): Step[] {
  const { intent, obligation, investigations } = trail;
  const steps: Step[] = [];
  const amount = formatMoney(intent.amount_minor);
  const keyWords = intent.idempotency_key ? "one key" : intent.provider === "sim_keyless" ? `no key (${RAIL_WORDS.legacy})` : "no key";
  steps.push({
    kind: "reserved",
    label: "Reserved",
    text: `${amount} ${typeWords(String(intent["entitlement_type"] ?? ""))} to ${intent.payee_ref}${
      obligation.rule_citation ? `, ${obligation.rule_citation}` : ""
    }; one frozen request, ${keyWords}`,
  });
  for (const a of intent.attempts) {
    steps.push({
      kind: "sent",
      label: `Send ${a.n}`,
      text: `${a.licence}, ${attemptResultWords(a)}${a.request_sha256 ? ` · request ${shortHash(a.request_sha256, 8)}` : ""}`,
      tone: a.result?.kind === "ACCEPTED" ? "good" : "warn",
    });
  }
  if (intent.state === "DISPATCHING" && investigations.length === 0) {
    steps.push({ kind: "pending", label: "Pending", text: "The send was marked before it left; no answer was recorded. The investigation has not started.", tone: "warn" });
  } else if (intent.state === "OUTCOME_UNKNOWN" && investigations.length === 0) {
    steps.push({ kind: "pending", label: "Waiting", text: "Outcome unknown; the investigation has not started.", tone: "warn" });
  }
  for (const inv of investigations) {
    steps.push({ kind: "hypothesis", label: "Hypothesis", text: `${inv.hypothesis ?? "none recorded"}  (investigator: ${inv.investigator})` });
    for (const s of inv.steps) {
      steps.push({ kind: "query", label: "Query", text: `${s.tool}: ${s.summary} · ${s.record_count} ${s.record_count === 1 ? "record" : "records"}` });
    }
    steps.push({ kind: "matcher", label: "Matcher", text: matchWords(inv.match), tone: inv.match === "MATCH" ? "good" : inv.match === "NO_MATCH" ? "warn" : "stop" });
    steps.push({
      kind: "licence",
      label: "Licence",
      text: inv.licence ? `${inv.licence} recorded before the re-send` : "none: nothing was re-sent",
      tone: inv.licence ? "good" : "muted",
    });
    steps.push({ kind: "decision", label: "Decision", text: decisionWords(inv.decision), tone: inv.decision.kind === "QUARANTINE" ? "stop" : "good" });
  }
  if (intent.evidence) {
    const e = intent.evidence;
    steps.push({
      kind: "evidence",
      label: "Evidence",
      text: `${e.provider_object_id} · status ${e.status} · ${formatMoney(e.amount_minor)} ${e.currency} to ${e.payee_ref} · marker matches · from ${
        EVIDENCE_SOURCE_WORDS[e.source] ?? e.source
      }`,
      tone: "good",
    });
  }
  if (intent.quarantine) {
    steps.push({ kind: "evidence", label: "Parked", text: `${quarantineWords(intent.quarantine.reason)}. The reservation stays held; ${intent.quarantine.detail}`, tone: "stop" });
  }
  return steps;
}

export function providerWords(provider: string): string {
  return PROVIDER_WORDS[provider] ?? provider;
}
