import { formatClock } from "../format";
import { isBaseline, trailSteps } from "../trailSteps";
import { COLOUR_LABEL, CONFIRMED_MEANS, quarantineWords, stateColour, stateLabel } from "../stateColour";
import type { ApiResult } from "../api";
import type { AnyTrail, BaselineTrail } from "../types";

function BaselineTrailView({ t }: { t: BaselineTrail }) {
  return (
    <ol className="steps">
      {t.attempts.map((a) => (
        <li key={a.n} className="step step--warn">
          <span className="step__label">Attempt {a.n}</span>
          <span className="step__text">
            key <span className="mono">{a.idempotency_key}</span> · {a.result} <span className="muted">{formatClock(a.at)}</span>
          </span>
        </li>
      ))}
      <li className={`step ${t.marked_done ? "step--good" : "step--warn"}`}>
        <span className="step__label">Marked done</span>
        <span className="step__text">
          {t.marked_done ? `yes${t.marked_done_at ? `, at ${formatClock(t.marked_done_at)}` : ""}` : "no: the claim stays open and is run again on restart"}
          {t.note ? ` · ${t.note}` : ""}
        </span>
      </li>
      <li className="step step--muted">
        <span className="step__label">Evidence</span>
        <span className="step__text">none read: this arm has no investigation and no matcher; a 2xx is treated as paid.</span>
      </li>
    </ol>
  );
}

export function EvidenceTrail(props: { trail: ApiResult<AnyTrail> | null; selectedKey: string | null }) {
  const { trail } = props;
  if (!props.selectedKey) return <div className="trail trail--note">Select a payment.</div>;
  if (trail === null) return <div className="trail trail--note">Loading the evidence trail…</div>;
  if (!trail.ok) return <div className="trail trail--note">Evidence trail unavailable ({trail.error})</div>;
  const t = trail.data;
  if (isBaseline(t)) {
    return (
      <div className="trail">
        <div className="trail__head">What this arm's own code did</div>
        <BaselineTrailView t={t} />
      </div>
    );
  }
  const colour = stateColour({ intentState: t.intent.state, reversed: t.reversal != null });
  const steps = trailSteps(t);
  return (
    <div className="trail">
      <div className={`trail__head trail__head--${colour}`} title={colour === "green" ? `Confirmed: ${CONFIRMED_MEANS}` : undefined}>
        {colour === "neutral" ? stateLabel(t.intent.state) : COLOUR_LABEL[colour]}
        {t.intent.state === "QUARANTINED" && t.intent.quarantine && <span className="trail__reason"> · {quarantineWords(t.intent.quarantine.reason)}</span>}
        {t.reversal && (
          <span className="trail__reason">
            {" "}· the provider now reports {t.reversal.provider_object_id ?? "the payment"} as {t.reversal.status_now ?? "reversed"}; it was not re-paid
          </span>
        )}
      </div>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={i} className={`step step--${s.tone ?? "plain"} step--${s.kind}`}>
            <span className="step__label">{s.label}</span>
            <span className="step__text">{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
