import { causeWords, controlWords, typeWords } from "../copy";
import { formatDelay, formatMoney } from "../format";
import { heldWords } from "../stateColour";
import type { ApiResult } from "../api";
import type { ClaimCase, ClaimRow } from "../types";

function channelWords(channel: string): string {
  if (/agency/i.test(channel) || /letter/i.test(channel)) return "agency letter";
  return channel.replace(/-/g, " ");
}

export function DecisionCard(props: { claim: ApiResult<ClaimCase> | null; claims: ClaimRow[]; compact: boolean; onToggle: () => void }) {
  const r = props.claim;
  if (r === null) return <section className="decision decision--empty">Loading the case file…</section>;
  if (!r.ok) return <section className="decision decision--empty">Case file unavailable ({r.error})</section>;
  const c = r.data;
  const merged = c.merged_claims.map((id) => {
    const row = props.claims.find((x) => x.claim_id === id);
    return { id, words: row ? channelWords(row.channel) : "claim" };
  });
  const fact = c.record_facts[0];
  const asked = c.extraction?.requested_amount;

  if (props.compact) {
    const o = c.obligations[0];
    return (
      <section className="decision decision--compact" onClick={props.onToggle} title="click to expand the case file">
        <b>{c.extraction?.claimant_names[0] ?? c.claim_id}</b>
        <span>claim {c.claim_id}</span>
        {o && (
          <span>
            {typeWords(o.entitlement_type)} <b>{formatMoney(o.amount_minor)}</b> · {o.rule_citation} · {o.policy_version}
          </span>
        )}
        {merged.map((m) => (
          <span key={m.id} className="chip">duplicate merged: {m.words} {m.id}</span>
        ))}
      </section>
    );
  }

  return (
    <section className="decision" onClick={props.onToggle}>
      <div className="decision__claim">
        <h2>
          Claim {c.claim_id} <small>{channelWords(c.channel)}</small>
        </h2>
        <pre className="claimtext">{c.raw_text}</pre>
      </div>
      <div className="decision__record">
        <h2>The airline's record</h2>
        {fact ? (
          <ul className="facts">
            <li>
              Flight <b>{fact.flight_no}</b>
            </li>
            <li>
              Cause: <b>{causeWords(fact.cause_code)}</b>
            </li>
            <li>{controlWords(fact.control_class)}</li>
            <li>
              Arrived <b>{formatDelay(fact.arrival_delay_minutes)}</b> late
            </li>
          </ul>
        ) : (
          <p className="muted">No record facts for this claim.</p>
        )}
        {c.resolution && (
          <p className="muted small">
            Booking {c.resolution.booking_ref} found by {c.resolution.method.toLowerCase().replace(/_/g, " ")}
          </p>
        )}
      </div>
      <div className="decision__card">
        <h2>Decision</h2>
        {c.obligations.length === 0 && <p className="muted">{c.hold_reason ? `Held: ${heldWords(c.hold_reason)}` : "No obligation decided yet."}</p>}
        {c.obligations.map((o) => (
          <div key={o.effect_key} className="obl">
            {o.status === "OWED" && (
              <>
                <div className="obl__amount">{formatMoney(o.amount_minor)}</div>
                <div className="obl__what">
                  {typeWords(o.entitlement_type)} · {o.rule_citation}
                </div>
              </>
            )}
            {o.status === "NOT_OWED" && <div className="obl__what">Not owed: {o.reason_code ?? "refused"} · {o.rule_citation}</div>}
            {o.status === "HELD" && <div className="obl__what">Held: {heldWords(o.reason_code)}</div>}
            <div className="obl__policy mono">{o.policy_version}</div>
          </div>
        ))}
        {asked && <p className="small muted">The claim asked for ${asked}; the regulation fixes the amount.</p>}
        {merged.map((m) => (
          <p key={m.id} className="merged">
            duplicate merged: {m.words} {m.id}
          </p>
        ))}
      </div>
    </section>
  );
}
