// The big comparison number for one arm: what the provider's own statement lists, and the auditor's verdict when one exists.
// Every figure is read from the API (provider statement, payment rows, certificate); nothing here is computed beyond sums.
import { ShieldAlert, ShieldCheck, Hourglass } from "lucide-react";
import { formatMoney } from "../format";
import type { ApiResult } from "../api";
import type { Certificate, PaymentRow, ProviderStatement } from "../types";

export function ArmHero(props: {
  statement: ApiResult<ProviderStatement> | null;
  payments: ApiResult<PaymentRow[]> | null;
  certificate: ApiResult<Certificate> | null;
  isControl: boolean;
}) {
  const s = props.statement?.ok ? props.statement.data : null;
  const rows = props.payments?.ok ? props.payments.data.filter((r) => r.provider !== "stripe_refund") : null;
  const payments = s ? s.entitlements.reduce((n, e) => n + e.count, 0) : null;
  const atProvider = s ? s.entitlements.reduce((n, e) => n + e.amount_minor_total, 0) : null;
  const owed = rows ? rows.reduce((n, r) => n + r.amount_minor, 0) : null;
  const twice = s ? s.paid_twice : null;
  const cert = props.certificate?.ok ? props.certificate.data : null;
  const failing = cert ? Object.entries(cert.checks).filter(([, v]) => v.status === "FAIL").map(([k]) => k) : [];

  return (
    <div className={`hero${twice !== null && twice > 0 ? " hero--alarm" : ""}`}>
      <div className="hero__stmt">
        <div className="hero__label">Provider statement</div>
        {s === null ? (
          <div className="hero__wait">{props.statement && !props.statement.ok ? "Statement unavailable; not shown as zero" : "Reading the statement…"}</div>
        ) : (
          <>
            <div className="hero__big">
              {payments} <span className="hero__unit">{payments === 1 ? "payment" : "payments"}</span>
            </div>
            <div className="hero__money">
              {atProvider !== null && <b>{formatMoney(atProvider)}</b>} at the provider
              {owed !== null && (
                <>
                  {" "}
                  · <b>{formatMoney(owed)}</b> owed
                </>
              )}
            </div>
            {twice !== null && twice > 0 && (
              <span className="badge badge--red">
                PAID TWICE · {twice} {twice === 1 ? "entitlement" : "entitlements"}
              </span>
            )}
            {twice === 0 && <span className="badge badge--quiet">0 paid twice</span>}
          </>
        )}
      </div>
      <div className="hero__safety">
        <div className="hero__label">Auditor</div>
        {cert ? (
          <div className={`safety safety--${cert.safety === "PASS" ? "pass" : "fail"}`}>
            {cert.safety === "PASS" ? <ShieldCheck size={30} aria-hidden /> : <ShieldAlert size={30} aria-hidden />}
            <span>SAFETY {cert.safety}</span>
            {failing.length > 0 && <span className="safety__ids">{failing.join(" ")}</span>}
          </div>
        ) : (
          <div className="placeholder">
            <Hourglass size={16} aria-hidden /> Not audited yet
          </div>
        )}
      </div>
    </div>
  );
}
