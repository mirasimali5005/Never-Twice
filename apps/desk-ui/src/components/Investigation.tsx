// The AI investigation of the selected Never Twice payment, as a short human-readable timeline. Every line is derived from
// the payment's own investigation record; model reasoning is tagged "AI", deterministic authorization "Fixed rule".
import { ChevronDown, CircleCheck, CircleHelp, Gavel, Search, Sparkles, UserRound } from "lucide-react";
import { isBaseline } from "../trailSteps";
import { trailPhase } from "./Timeline";
import type { ApiResult } from "../api";
import type { AnyTrail, InvestigationRecord } from "../types";

type Row = { icon: typeof Search; title: string; tag: "AI" | "Fixed rule"; tone?: "red" | "green" | "neutral"; text?: string };

export function decisionPlain(d: InvestigationRecord["decision"]): string {
  if (d == null) return "Investigating…";
  if (d.kind === "SETTLE") return "Existing payment confirmed — no second payment sent";
  if (d.kind === "REDISPATCH_SAME_KEY") return "Identical request re-sent under the same key";
  return "Parked for a person — would not guess";
}

export function Investigation(props: { trail: ApiResult<AnyTrail> | null }) {
  const t = props.trail?.ok && !isBaseline(props.trail.data) ? props.trail.data : null;
  const head = (
    <div className="panel__head">
      <span className="eyebrow">AI investigation</span>
      <span className="legend">
        <span className="ttag ttag--ai">AI</span> reasoning · <span className="ttag">Fixed rule</span> authorization
      </span>
    </div>
  );
  if (!t) {
    return (
      <section className="glass panel" aria-label="AI investigation">
        {head}
        <p className="panel__empty">{props.trail && !props.trail.ok ? `Payment record unavailable (${props.trail.error})` : "Appears when a payment's outcome is unknown."}</p>
      </section>
    );
  }
  const p = trailPhase(t);
  const invs = (t.investigations ?? []).filter(Boolean) as InvestigationRecord[];
  const inv = invs[invs.length - 1];
  const rows: Row[] = [];
  if (p.lost || invs.length > 0 || t.intent.state === "OUTCOME_UNKNOWN") {
    rows.push({ icon: CircleHelp, title: "Payment outcome unknown", tag: "Fixed rule", tone: "red", text: "The send got no usable answer; the desk does not assume either way." });
  }
  if (inv) {
    const ai: Row["tag"] = inv.investigator === "llm" ? "AI" : "Fixed rule";
    rows.push({ icon: Sparkles, title: inv.investigator === "llm" ? "AI selected a verification method" : "Verification method selected", tag: ai });
    const steps = inv.steps ?? [];
    if (steps.length > 0) {
      const n = steps.reduce((a, s) => a + s.record_count, 0);
      rows.push({ icon: Search, title: "Provider records inspected", tag: ai, text: `${steps.length} read-only ${steps.length === 1 ? "query" : "queries"}, ${n} ${n === 1 ? "record" : "records"} returned` });
    }
    if (inv.match === "MATCH") rows.push({ icon: CircleCheck, title: "Matching payment found", tag: "Fixed rule", tone: "green" });
    else if (inv.match === "NO_MATCH") rows.push({ icon: CircleHelp, title: "No matching record", tag: "Fixed rule" });
    else if (inv.match === "CONTRADICTION") rows.push({ icon: CircleHelp, title: "Provider records contradict each other", tag: "Fixed rule", tone: "red" });
    if (inv.decision) {
      rows.push({
        icon: inv.decision.kind === "QUARANTINE" ? UserRound : Gavel,
        title: decisionPlain(inv.decision),
        tag: "Fixed rule",
        tone: inv.decision.kind === "QUARANTINE" ? "neutral" : p.confirmed ? "green" : "neutral",
      });
    }
  }
  return (
    <section className="glass panel" aria-label="AI investigation">
      {head}
      {rows.length === 0 ? (
        <p className="panel__empty">
          {p.confirmed ? "No investigation needed: the provider answered the send directly." : p.sent ? "Sent; waiting for the provider's answer." : "Reserved; nothing sent yet."}
        </p>
      ) : (
        <ol className="vt">
          {rows.map((r, i) => {
            const Icon = r.icon;
            return (
              <li key={i} className={`vt__item${r.tone ? ` vt__item--${r.tone}` : ""}${i === rows.length - 1 && inv?.decision ? " vt__item--final" : ""}`}>
                <span className="vt__dot">
                  <Icon size={14} aria-hidden />
                </span>
                <div className="vt__body">
                  <div className="vt__title">
                    {r.title} <span className={`ttag${r.tag === "AI" ? " ttag--ai" : ""}`}>{r.tag}</span>
                  </div>
                  {r.text && <div className="vt__text">{r.text}</div>}
                </div>
              </li>
            );
          })}
          {inv && !inv.decision && (
            <li className="vt__item vt__item--active">
              <span className="vt__dot">
                <Search size={14} aria-hidden />
              </span>
              <div className="vt__body">
                <div className="vt__title">Investigating…</div>
              </div>
            </li>
          )}
        </ol>
      )}
      {inv && (inv.hypothesis || (inv.steps ?? []).length > 0) && (
        <details className="more">
          <summary>
            Model hypothesis and exact queries <ChevronDown size={14} aria-hidden />
          </summary>
          {inv.hypothesis && (
            <p className="more__p">
              <span className="more__k">Hypothesis</span> {inv.hypothesis}
            </p>
          )}
          {(inv.steps ?? []).map((s, i) => (
            <p key={i} className="more__p">
              <span className="more__k mono">{s.tool}</span> {s.summary} · {s.record_count} {s.record_count === 1 ? "record" : "records"}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
