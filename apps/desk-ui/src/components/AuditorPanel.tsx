import { CHECK_WORDS, CONFIRMED_SENTENCE } from "../copy";
import { formatMinor, formatMoney, shortHash } from "../format";
import type { ApiResult } from "../api";
import type { Certificate, GroupRun } from "../types";

type Entry = { run: GroupRun; cert: ApiResult<Certificate> | null };

const TAB_LABEL: Record<string, string> = { nt_mutant: "Mutant run", nt: "Never Twice", control: "Ordinary agent" };
const ORDER = ["nt_mutant", "nt", "control"];

/** What each labelled mutation does, in words. M2 is the one the demo runs. */
export const MUTATION_WORDS: Record<string, string> = { M2: "marks unknown outcomes confirmed without evidence" };

/** The mutation id of a labelled mutant run. The certificate names it in a note when it can; the demo's mutant is M2. */
export function mutationName(c: Certificate): string | null {
  for (const n of c.notes) {
    const m = n.match(/NT_MUTATION=(M\d+)/);
    if (m) return m[1];
  }
  return c.arm === "nt_mutant" ? "M2" : null;
}

/** "Labelled mutant M2: marks unknown outcomes confirmed without evidence — a test of the auditor" */
export function mutantLabel(id: string): string {
  const what = MUTATION_WORDS[id];
  return `Labelled mutant ${id}${what ? `: ${what}` : ""} — a test of the auditor`;
}

/** The finding's own message up to the first colon is its one-line reason; fall back to the check's words. */
export function reasonOf(f: { check: string; message: string }): string {
  const head = f.message.split(":")[0].trim();
  return head || CHECK_WORDS[f.check] || f.message;
}

export function auditable(cert: ApiResult<Certificate> | null): cert is { ok: true; data: Certificate } {
  return cert !== null && cert.ok;
}

const SCOPES = [
  ["gateway", "database and provider write key"],
  ["investigator", "provider read key"],
  ["auditor", "its own read key, no database credential"],
] as const;

export function AuditorPanel(props: {
  entries: Entry[];
  selectedArm: string;
  onSelect: (arm: string) => void;
  /** The ticket refund's amount in cents, from the Never Twice run's payment of provider stripe_refund (the certificate has no amount). */
  stripeAmountMinor?: number | null;
}) {
  const entries = [...props.entries].sort((a, b) => ORDER.indexOf(a.run.arm) - ORDER.indexOf(b.run.arm));
  const sel = entries.find((e) => e.run.arm === props.selectedArm) ?? entries.find((e) => auditable(e.cert)) ?? entries[0];
  const cert = sel && auditable(sel.cert) ? sel.cert.data : null;
  const unavailable = entries.filter((e) => e.cert && !e.cert.ok && e.cert.error !== "NOT_AUDITED" && e.cert.status !== 404);

  const strip = (
    <div className="scopes">
      {SCOPES.map(([who, what]) => (
        <span key={who}>
          <b>{who}</b>: {what}
        </span>
      ))}
    </div>
  );

  if (!cert) {
    return (
      <section className="auditor auditor--idle" aria-label="Auditor">
        <div className="auditor__line">
          <b>Auditor</b> · not run yet. A separate process with read-only access to the provider ledgers and no access to the system's database.
          {unavailable.length > 0 && <span className="bad"> Certificate unavailable for {unavailable.map((u) => u.run.arm).join(", ")}.</span>}
        </div>
        {strip}
      </section>
    );
  }

  const pass = cert.safety === "PASS";
  const failing = (Object.entries(cert.checks) as [string, { status: string; count: number }][]).filter(([, v]) => v.status === "FAIL");
  const passing = (Object.entries(cert.checks) as [string, { status: string; count: number }][]).filter(([, v]) => v.status === "PASS").map(([k]) => k);
  const mut = mutationName(cert);
  const equal = cert.commitment_sha256 === null ? null : cert.commitment_sha256 === cert.manifest_sha256;
  const co = cert.completion;
  return (
    <section className="auditor" aria-label="Auditor certificate">
      <div className="auditor__tabs" role="tablist">
        {entries.map((e) => {
          const c = auditable(e.cert) ? e.cert.data : null;
          const active = e.run === sel.run;
          return (
            <button
              key={e.run.run_id}
              role="tab"
              aria-selected={active}
              className={`tab${active ? " tab--active" : ""}${c ? (c.safety === "PASS" ? " tab--pass" : " tab--fail") : ""}`}
              onClick={() => props.onSelect(e.run.arm)}
            >
              <span className="tab__name">{TAB_LABEL[e.run.arm] ?? e.run.arm}</span>
              <span className="tab__verdict">{c ? c.safety : "not audited"}</span>
            </button>
          );
        })}
      </div>

      <div className="auditor__verdict">
        {mut !== null && <div className="mutant">{mutantLabel(mut)}</div>}
        <div className={`verdict verdict--${pass ? "pass" : "fail"}`}>SAFETY: {cert.safety}</div>
        <div className="small muted">
          {TAB_LABEL[cert.arm] ?? cert.arm} · run <span className="mono">{cert.run_id}</span>
        </div>
      </div>

      <div className="auditor__findings">
        {cert.findings.length === 0 && failing.length === 0 && (
          <div className="muted">
            C1 C2 C3 C4 C5 C6 C7 C9 C10: no findings ({passing.length} checks passed)
          </div>
        )}
        {failing.map(([id, v]) => {
          const fs = cert.findings.filter((f) => f.check === id);
          return (
            <div key={id} className="finding">
              <span className="finding__id">{id}</span>
              <span className="finding__why">
                {fs[0] ? reasonOf(fs[0]) : CHECK_WORDS[id] ?? "failed"}
                {v.count > 1 && <span className="muted"> ×{v.count}</span>}
              </span>
              <span className="finding__who mono">
                {fs
                  .map((f) => f.effect_key?.split(".").slice(1, 2)[0] ?? f.claim_id ?? "")
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </div>
          );
        })}
      </div>

      <div className="auditor__side">
        <div className="completion" title="C8 completion: reported beside the verdict, never mixed into it">
          <b>Completion</b> (not part of the verdict): owed {co.owed_paid[0]} of {co.owed_paid[1]} confirmed · refusals {co.refusals_correct[0]} of{" "}
          {co.refusals_correct[1]} · holds {co.holds_correct[0]} of {co.holds_correct[1]} · parked though owed {co.over_parked}
          {co.goodwill_eligible_minor > 0 && (
            <> · goodwill {formatMinor(co.goodwill_paid_minor)} of {formatMinor(co.goodwill_eligible_minor)}</>
          )}
        </div>
        <div className="small">
          Ledgers: <span className="tag">SIMULATOR</span> simulated payout provider, {cert.ledger.sim_objects} objects
          {cert.ledger.stripe_objects !== null && cert.ledger.stripe_objects > 0 && (
            <>
              {" "}
              ·{" "}
              <b className="stripe">
                {props.stripeAmountMinor != null && cert.ledger.stripe_objects === 1 ? `${formatMoney(props.stripeAmountMinor)} ` : ""}ticket refund read from
                Stripe (test mode)
              </b>
              {cert.ledger.stripe_objects === 1 ? "" : `, ${cert.ledger.stripe_objects} objects`}
            </>
          )}
        </div>
        <div className="small">
          Manifest <span className="mono">{shortHash(cert.manifest_sha256, 12)}</span>{" "}
          {equal === true && <b className="ok">equals the pre-run commitment</b>}
          {equal === false && <b className="bad">DIFFERS from the pre-run commitment</b>}
          {equal === null && <b className="bad">no commitment found</b>}
        </div>
        <div className="small muted">{CONFIRMED_SENTENCE}</div>
      </div>
      {strip}
    </section>
  );
}
