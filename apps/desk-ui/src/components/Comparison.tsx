// The centrepiece: the two agents side by side. Every figure comes from the provider statement, the payment rows or the
// auditor's certificate; colours follow the certificate (red only on FAIL, green only on PASS), neutral before the audit.
import { Hourglass, ShieldAlert, ShieldCheck } from "lucide-react";
import { formatMoney } from "../format";
import type { RunData } from "../useRunData";

function figures(d: RunData) {
  const s = d.statement?.ok ? d.statement.data : null;
  const rows = d.payments?.ok ? d.payments.data.filter((r) => r.provider !== "stripe_refund") : null;
  return {
    s,
    atProvider: s ? s.entitlements.reduce((n, e) => n + e.amount_minor_total, 0) : null,
    owed: rows ? rows.reduce((n, r) => n + r.amount_minor, 0) : null,
    // extra payment objects beyond the first, per entitlement, as the provider lists them
    duplicates: s ? s.entitlements.reduce((n, e) => n + Math.max(0, e.count - 1), 0) : null,
    cert: d.certificate?.ok ? d.certificate.data : null,
    statementError: d.statement && !d.statement.ok ? d.statement.error : null,
  };
}

function Verdict({ safety }: { safety: "PASS" | "FAIL" | null }) {
  if (safety === null)
    return (
      <span className="verdict-pill">
        <Hourglass size={15} aria-hidden /> Awaiting independent audit
      </span>
    );
  return (
    <span className={`verdict-pill verdict-pill--${safety === "PASS" ? "pass" : "fail"}`}>
      {safety === "PASS" ? <ShieldCheck size={16} aria-hidden /> : <ShieldAlert size={16} aria-hidden />}
      SAFETY {safety === "PASS" ? "PASSED" : "FAILED"}
    </span>
  );
}

function Card(props: { kind: "control" | "nt"; title: string; data: RunData | null; present: boolean; recovered: number | null }) {
  const f = props.data ? figures(props.data) : null;
  const safety = f?.cert?.safety ?? null;
  const tone = safety === "FAIL" ? "fail" : safety === "PASS" ? "pass" : "neutral";
  const isControl = props.kind === "control";
  return (
    <article className={`arm glass arm--${tone}`} aria-label={props.title}>
      <div className="arm__head">
        <span className="arm__title">{props.title}</span>
        <Verdict safety={safety} />
      </div>
      {!props.present || !f ? (
        <p className="arm__wait">{props.present ? "Waiting for data" : "No run of this agent in this group."}</p>
      ) : f.s === null ? (
        <p className="arm__wait">{f.statementError ? `Provider statement unavailable (${f.statementError}); not shown as zero.` : "Reading the provider statement…"}</p>
      ) : (
        <>
          <div className="arm__money">
            <span className="arm__big">{formatMoney(f.atProvider ?? 0)}</span>
            <span className="arm__unit">paid at the provider</span>
          </div>
          <div className="arm__owed">{f.owed !== null ? <>against <b>{formatMoney(f.owed)}</b> owed</> : "amount owed loading…"}</div>
          <div className="arm__stats">
            {isControl ? (
              <div className={`stat${(f.duplicates ?? 0) > 0 ? " stat--red" : ""}`}>
                <span className="stat__n">{f.duplicates}</span>
                <span className="stat__l">duplicate {f.duplicates === 1 ? "payment" : "payments"}</span>
              </div>
            ) : (
              <div className={`stat${(props.recovered ?? 0) > 0 && safety === "PASS" ? " stat--green" : ""}`}>
                <span className="stat__n">{props.recovered ?? "–"}</span>
                <span className="stat__l">{props.recovered === 1 ? "payment" : "payments"} recovered safely</span>
              </div>
            )}
            <div className="stat">
              <span className="stat__n">{f.s.entitlements.reduce((n, e) => n + e.count, 0)}</span>
              <span className="stat__l">payment objects at the provider</span>
            </div>
          </div>
          {isControl && (f.duplicates ?? 0) > 0 && <p className="arm__line arm__line--red">Repeated a payment after losing confirmation.</p>}
          {!isControl && (props.recovered ?? 0) > 0 && <p className="arm__line">Verified provider evidence before continuing.</p>}
        </>
      )}
    </article>
  );
}

export function Comparison(props: { control: RunData | null; nt: RunData | null; hasControl: boolean; hasNt: boolean; recovered: number | null }) {
  return (
    <div className="compare">
      <Card kind="control" title="Ordinary agent" data={props.control} present={props.hasControl} recovered={null} />
      <Card kind="nt" title="Never Twice" data={props.nt} present={props.hasNt} recovered={props.recovered} />
    </div>
  );
}
