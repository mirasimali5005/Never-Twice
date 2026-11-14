// The auditor at a glance: one tile per arm with the certificate's own verdict. Findings, completion, manifest and key scopes
// live in the Technical evidence drawer (AuditorPanel).
import { Eye, Hourglass, ShieldAlert, ShieldCheck } from "lucide-react";
import { CONFIRMED_SENTENCE } from "../copy";
import { formatMoney } from "../format";
import { auditable, mutationName } from "./AuditorPanel";
import type { ApiResult } from "../api";
import type { Certificate, GroupRun } from "../types";

type Entry = { run: GroupRun; cert: ApiResult<Certificate> | null };
const ORDER = ["nt", "control", "nt_mutant"];
const NAME: Record<string, string> = { nt: "Never Twice", control: "Ordinary agent", documented: "Documented practice", nt_mutant: "Labelled mutant" };

export function AuditorSummary(props: { entries: Entry[]; stripeAmountMinor: number | null }) {
  const entries = [...props.entries].sort((a, b) => ORDER.indexOf(a.run.arm) - ORDER.indexOf(b.run.arm));
  const certs = entries.map((e) => (auditable(e.cert) ? e.cert.data : null));
  const any = certs.find((c) => c !== null) ?? null;
  const stripeObjects = certs.find((c) => c?.arm === "nt")?.ledger.stripe_objects ?? null;
  return (
    <section className="glass audit" aria-label="Independent auditor">
      <div className="audit__head">
        <span className="eyebrow">Independent auditor</span>
        <span className="audit__scope">
          <Eye size={13} aria-hidden /> Verified against provider records (read-only, no database access)
        </span>
      </div>
      <div className="audit__tiles">
        {entries.map((e, i) => {
          const c = certs[i];
          const checks = c ? Object.values(c.checks) : [];
          const passed = checks.filter((v) => v.status === "PASS").length;
          const dup = c ? c.checks.C1?.count ?? 0 : null;
          const mut = c ? mutationName(c) : e.run.arm === "nt_mutant" ? "M2" : null;
          const tone = c ? (c.safety === "PASS" ? "pass" : "fail") : "neutral";
          return (
            <div key={e.run.run_id} className={`atile atile--${tone}`}>
              <div className="atile__name">
                {NAME[e.run.arm] ?? e.run.arm}
                {e.run.arm === "nt_mutant" && mut && <span className="atile__tag">{mut} · auditor test</span>}
              </div>
              <div className="atile__verdict">
                {c ? (c.safety === "PASS" ? <ShieldCheck size={22} aria-hidden /> : <ShieldAlert size={22} aria-hidden />) : <Hourglass size={18} aria-hidden />}
                {c ? c.safety : <span className="atile__pending">Pending</span>}
              </div>
              <div className="atile__meta">
                {c ? (
                  <>
                    <span>
                      <b>{passed}</b>/{checks.length} checks passed
                    </span>
                    <span className={dup ? "red" : undefined}>
                      <b>{dup}</b> duplicate {dup === 1 ? "payment" : "payments"} detected
                    </span>
                  </>
                ) : (
                  <span>{e.cert && !e.cert.ok && e.cert.error !== "NOT_AUDITED" && e.cert.status !== 404 ? `certificate unavailable (${e.cert.error})` : "not audited yet"}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="audit__foot">
        {any && stripeObjects !== null && stripeObjects > 0 && (
          <span>
            {props.stripeAmountMinor != null && stripeObjects === 1 ? `${formatMoney(props.stripeAmountMinor)} ` : ""}ticket refund read from Stripe (test mode)
          </span>
        )}
        <span className="muted">{CONFIRMED_SENTENCE}</span>
      </div>
    </section>
  );
}
