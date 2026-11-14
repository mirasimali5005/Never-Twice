// Compact case selector (Never Twice payments) and the selected case in four short lines. The original email, booking details
// and regulation citation sit in an expandable "Case details" (the full DecisionCard).
import { ChevronDown } from "lucide-react";
import { passengerName, typeWords } from "../copy";
import { formatMoney } from "../format";
import { heldWords, stateColour } from "../stateColour";
import { isBaseline } from "../trailSteps";
import { DecisionCard } from "./DecisionCard";
import { decisionPlain } from "./Investigation";
import { trailPhase } from "./Timeline";
import type { ApiResult } from "../api";
import type { AnyTrail, ClaimCase, ClaimRow, PaymentRow } from "../types";

const SHORT: Record<string, string> = { amber: "In doubt", green: "Verified", "grey-blue": "Needs a person", red: "Reversed", neutral: "" };

function statusOf(r: PaymentRow): { text: string; tone: string } {
  const c = stateColour({ intentState: r.state, reversed: r.reversed_at_provider === true });
  const text = SHORT[c] || (r.state === "RESERVED" ? "Reserved" : r.state === "FAILED_NO_EFFECT" ? "Rejected" : r.state === "RELEASED" ? "Cancelled" : r.state ?? "");
  return { text, tone: c === "green" ? "green" : c === "red" ? "red" : "neutral" };
}

export function Cases(props: {
  rows: ApiResult<PaymentRow[]> | null;
  selectedKey: string | null;
  onSelect: (k: string) => void;
  claim: ApiResult<ClaimCase> | null;
  claims: ClaimRow[];
  trail: ApiResult<AnyTrail> | null;
}) {
  const rows = props.rows?.ok ? props.rows.data : [];
  const c = props.claim?.ok ? props.claim.data : null;
  const o = c ? c.obligations.find((x) => x.effect_key === props.selectedKey) ?? c.obligations[0] : undefined;
  const t = props.trail?.ok && !isBaseline(props.trail.data) ? props.trail.data : null;
  const p = t ? trailPhase(t) : null;
  const last = t ? (t.investigations ?? []).filter(Boolean).slice(-1)[0] : undefined;
  const who = c?.extraction?.claimant_names[0];
  const asked = c?.extraction?.requested_amount;
  const flight = c?.record_facts[0]?.flight_no ?? c?.extraction?.flight_numbers[0];

  const lines: [string, string][] = [];
  if (c) {
    lines.push(["Requested", `${who ?? "The passenger"} asked for ${asked ? `$${asked.replace(/^\$/, "")}` : "compensation"}${flight ? ` after flight ${flight}` : ""}.`]);
    lines.push([
      "Airline determined",
      o
        ? o.status === "OWED"
          ? `${formatMoney(o.amount_minor)} ${typeWords(o.entitlement_type)} is owed.`
          : o.status === "NOT_OWED"
            ? "Nothing is owed under the regulation."
            : `Held: ${heldWords(o.reason_code)}.`
        : c.hold_reason
          ? `Held: ${heldWords(c.hold_reason)}.`
          : "No decision yet.",
    ]);
  }
  if (t && p) {
    lines.push([
      "System did",
      last?.decision ? `${decisionPlain(last.decision)}.` : p.investigating ? "Investigating the provider's records." : p.confirmed ? "Sent once; the provider answered." : p.sent ? "Sent; waiting for the answer." : "Reserved the payment.",
    ]);
    lines.push([
      "Payment verified",
      t.intent.evidence ? "Yes — the provider holds one matching payment object." : p.quarantined ? "No — parked for a person." : "Not yet.",
    ]);
  }

  return (
    <section className="glass panel cases" aria-label="Cases">
      <div className="panel__head">
        <span className="eyebrow">Cases</span>
        <span className="legend">Never Twice payments</span>
      </div>
      {rows.length === 0 ? (
        <p className="panel__empty">{props.rows && !props.rows.ok ? `Payments unavailable (${props.rows.error})` : "No payments yet. Cases appear as the desk reserves them."}</p>
      ) : (
        <div className="case-list" role="list">
          {rows.map((r) => {
            const s = statusOf(r);
            const sel = r.effect_key === props.selectedKey;
            return (
              <button key={r.effect_key} type="button" role="listitem" aria-pressed={sel} className={`case${sel ? " case--sel" : ""}`} onClick={() => props.onSelect(r.effect_key)}>
                <span className="case__name">{passengerName(r.passenger_id)}</span>
                <span className="case__amt">{formatMoney(r.amount_minor)}</span>
                <span className={`case__st case__st--${s.tone}`}>{s.text}</span>
              </button>
            );
          })}
        </div>
      )}
      {lines.length > 0 && (
        <dl className="four">
          {lines.map(([k, v]) => (
            <div key={k} className="four__row">
              <dt>{k}</dt>
              <dd className={k === "Payment verified" && v.startsWith("Yes") ? "green" : undefined}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {props.claim && (
        <details className="more">
          <summary>
            Case details <ChevronDown size={14} aria-hidden />
          </summary>
          <DecisionCard claim={props.claim} claims={props.claims} compact={false} onToggle={() => {}} />
        </details>
      )}
    </section>
  );
}
