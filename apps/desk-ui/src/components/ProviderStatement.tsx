import { formatClock, formatMoney } from "../format";
import type { ApiResult } from "../api";
import type { PaymentRow, ProviderStatement as Statement } from "../types";

// The provider's own list for this run's account, read with the read key. Shown for the selected entitlement, with the run's
// "paid twice" count prominent. "paid" here is the provider's own status word.
export function ProviderStatement(props: {
  statement: ApiResult<Statement> | null;
  selected: PaymentRow | null;
  isControl: boolean;
}) {
  const s = props.statement;
  if (s === null) return <div className="stmt stmt--note">Reading the provider statement…</div>;
  if (!s.ok) {
    return (
      <div className="stmt stmt--note">
        Provider statement unavailable ({s.error === "PROVIDER_UNREACHABLE" ? "the simulator is unreachable" : s.error}); not shown as zero.
      </div>
    );
  }
  const st = s.data;
  const sel = props.selected;
  const entry = sel ? st.entitlements.find((e) => e.effect_key === sel.effect_key) : undefined;
  const n = entry?.count ?? 0;
  const isStripe = sel?.provider === "stripe_refund";
  const twice = st.paid_twice;
  return (
    <div className={`stmt${props.isControl && twice > 0 ? " stmt--alarm" : ""}`}>
      <div className="stmt__title">
        Provider statement <span className="tag">SIMULATOR</span>
        <span className="muted small"> acct {st.account} · read {formatClock(st.read_at)}{st.complete ? "" : " · incomplete"}</span>
      </div>
      <div className="stmt__body">
        <div className={`twice${twice > 0 ? " twice--yes" : ""}`} title="entitlements with two or more payments at the provider">
          <span className="twice__n">{twice}</span>
          <span className="twice__l">paid twice</span>
        </div>
        <div className="stmt__sel">
          {sel === null && <span className="muted">Select a payment.</span>}
          {sel !== null && isStripe && <span>Ticket refund: Stripe test mode, not on the simulator's list; the auditor reads it from Stripe.</span>}
          {sel !== null && !isStripe && (
            <>
              <div className={`stmt__count${n >= 2 ? " stmt__count--twice" : ""}`}>
                {n} {n === 1 ? "payment" : "payments"} at the provider
                {n >= 2 && <span> · {formatMoney(entry!.amount_minor_total)} against {formatMoney(sel.amount_minor)} owed</span>}
              </div>
              {n === 0 && !props.isControl && <div className="muted small">None listed. An empty list is not proof that nothing was sent.</div>}
              {entry?.objects.map((o) => (
                <div key={o.id} className="obj mono">
                  {o.id} · {o.status} · {formatMoney(o.amount_minor)} · {formatClock(o.created_at)}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
