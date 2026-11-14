// A short row of cards, one per payment, coloured by state. Not a table: no headers, no sorting, no filters.
import { passengerName, typeShort } from "../copy";
import { formatMoney } from "../format";
import { COLOUR_LABEL, CONFIRMED_MEANS, REVERSED_STATUSES, quarantineWords, stateColour, stateLabel } from "../stateColour";
import type { ApiResult } from "../api";
import type { PaymentRow, ProviderStatement } from "../types";

export function colourOfRow(r: PaymentRow) {
  return stateColour({ intentState: r.state, reversed: r.reversed_at_provider === true });
}

export function PaymentChips(props: {
  rows: ApiResult<PaymentRow[]> | null;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  baseline: boolean;
  statement: ApiResult<ProviderStatement> | null;
}) {
  const { rows } = props;
  if (rows === null) return <div className="cards cards--note">Loading payments…</div>;
  if (!rows.ok) return <div className="cards cards--note">Payments unavailable ({rows.error})</div>;
  if (rows.data.length === 0) return <div className="cards cards--note">No payments yet.</div>;
  const counts = new Map<string, number>();
  const reversedAtProvider = new Set<string>(); // control column: the provider statement shows an object undone after acceptance
  if (props.statement?.ok) {
    for (const e of props.statement.data.entitlements) {
      counts.set(e.effect_key, e.count);
      if (e.objects.some((o) => REVERSED_STATUSES.has(o.status))) reversedAtProvider.add(e.effect_key);
    }
  }
  const stmtKnown = props.statement?.ok === true;
  return (
    <div className="cards" role="list">
      {rows.data.map((r) => {
        const baselineReversed = props.baseline && reversedAtProvider.has(r.effect_key);
        const colour = baselineReversed ? "red" : colourOfRow(r);
        const selected = r.effect_key === props.selectedKey;
        const n = counts.get(r.effect_key) ?? 0;
        return (
          <button
            key={r.effect_key}
            role="listitem"
            type="button"
            className={`card card--${colour}${selected ? " card--selected" : ""}`}
            onClick={() => props.onSelect(r.effect_key)}
            title={colour === "green" ? `Confirmed: ${CONFIRMED_MEANS}` : COLOUR_LABEL[colour] || undefined}
            aria-pressed={selected}
          >
            <span className="card__who">
              <b>{r.passenger_id}</b> {passengerName(r.passenger_id)}
            </span>
            <span className="card__what">
              {formatMoney(r.amount_minor)} <span className="muted">{typeShort(r.entitlement_type)}</span>
            </span>
            {props.baseline ? (
              <span className={`card__state${stmtKnown && n >= 2 ? " card__state--twice" : ""}`}>
                {r.provider === "stripe_refund"
                  ? "refund at Stripe (test mode)"
                  : stmtKnown
                    ? `${n} ${n === 1 ? "payment" : "payments"} at the provider`
                    : "provider statement unavailable"}
              </span>
            ) : (
              <span className="card__state">{stateLabel(r.state, r.reversed_at_provider === true)}</span>
            )}
            {baselineReversed && <span className="card__reason card__reason--red">{COLOUR_LABEL.red}</span>}
            {r.state === "QUARANTINED" && <span className="card__reason">{quarantineWords(r.quarantine_reason)}</span>}
          </button>
        );
      })}
    </div>
  );
}
