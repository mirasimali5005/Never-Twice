// Presenter-only demo controls. Visible only while the local control server (`pnpm demo:control`, 127.0.0.1:4030) answers;
// otherwise this renders nothing and the page is unchanged. The buttons only start the real demo scripts; every number on the page
// still comes from the desk API's live data, never from these responses.
import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, FileCheck2, Loader2, RotateCcw, ShieldCheck, Undo2, XCircle, Zap } from "lucide-react";
import { KILL_TARGETS, PASSENGER_NAMES } from "./ChoiceStrip";
import type { StageName } from "./Hero";

export const CONTROL_URL = "http://127.0.0.1:4030/control";
type Action = "go" | "resume" | "audit" | "late-commit" | "reset";
type Last = { action: Action; ok: boolean; exit_code: number | null; started_at: string; ended_at: string; tail: string[]; group_id?: string | null };
type Status = { running: Action | null; started_at: string | null; running_tail: string[]; last: Last | null };

const LABEL: Record<Action, string> = { go: "Crash", resume: "Recover", audit: "Audit", "late-commit": "Late commit", reset: "Reset" };

/** Which buttons the demo stage (computed from real state by App) allows. */
export function enabledFor(stage: StageName | null): Record<Exclude<Action, "reset">, boolean> {
  return {
    go: stage === "Paused",
    // after the kill the killed payment stays DISPATCHING (the page says "Payments sending") until the restart marks it unknown
    resume: stage === "Crash" || stage === "Payments sending",
    audit: stage === "Investigating" || stage === "Recovered",
    "late-commit": stage === "Recovered" || stage === "Audited",
  };
}

async function getStatus(): Promise<Status | null> {
  try {
    const r = await fetch(`${CONTROL_URL}/status`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? ((await r.json()) as Status) : null;
  } catch {
    return null;
  }
}

export function DemoControls(props: { stage: StageName | null; scenario: "S0" | "S1" | null }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [passenger, setPassenger] = useState<string>("P02");
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const s = await getStatus();
      if (alive) setStatus(s);
    };
    void poll();
    const id = setInterval(poll, 1500);
    const clock = setInterval(() => tick((n) => n + 1), 500);
    return () => {
      alive = false;
      clearInterval(id);
      clearInterval(clock);
    };
  }, []);

  const choices = KILL_TARGETS[props.scenario ?? "S0"] ?? ["P02"];
  useEffect(() => {
    if (!choices.includes(passenger)) setPassenger(choices[0] ?? "P02");
  }, [choices, passenger]);

  if (!status) return null;

  const busy = status.running !== null;
  const en = enabledFor(props.stage);
  const trigger = async (action: Action, body: unknown = {}) => {
    setError(null);
    setConfirmReset(false);
    setStatus({ ...status, running: action, started_at: new Date().toISOString(), running_tail: [] });
    try {
      const r = await fetch(`${CONTROL_URL}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json()) as Last & { error?: string };
      if (r.status !== 200) setError(j.error ?? `HTTP ${r.status}`);
      else if (action === "reset" && j.ok && j.group_id) {
        location.href = `${location.pathname}?group=${encodeURIComponent(j.group_id)}`;
        return;
      }
    } catch (e) {
      setError((e as Error).message);
    }
    const s = await getStatus();
    setStatus(s);
  };

  const elapsed = status.started_at ? Math.max(0, Math.floor((Date.now() - Date.parse(status.started_at)) / 1000)) : 0;
  const last = status.last;
  const name = PASSENGER_NAMES[passenger]?.split(" ")[0] ?? passenger;

  return (
    <section className="glass ctl" aria-label="Demo controls">
      <span className="eyebrow ctl__title">Demo controls</span>
      <div className="ctl__btns">
        <span className="ctl__group">
          <button type="button" className="ctl__btn ctl__btn--red" disabled={busy || !en.go} onClick={() => void trigger("go", { passenger })}>
            <Zap size={14} aria-hidden /> Crash at {name} ({passenger})
          </button>
          {choices.length > 1 && (
            <select className="ctl__sel" value={passenger} disabled={busy || !en.go} onChange={(e) => setPassenger(e.target.value)} aria-label="Passenger to crash at">
              {choices.map((p) => (
                <option key={p} value={p}>
                  {p} {PASSENGER_NAMES[p] ?? ""}
                </option>
              ))}
            </select>
          )}
        </span>
        <button type="button" className="ctl__btn" disabled={busy || !en.resume} onClick={() => void trigger("resume")}>
          <Undo2 size={14} aria-hidden /> Recover
        </button>
        <button type="button" className="ctl__btn" disabled={busy || !en.audit} onClick={() => void trigger("audit")}>
          <ShieldCheck size={14} aria-hidden /> Audit
        </button>
        <button type="button" className="ctl__btn" disabled={busy || !en["late-commit"]} onClick={() => void trigger("late-commit")} title="finals only">
          <FileCheck2 size={14} aria-hidden /> Late commit
        </button>
        {confirmReset ? (
          <span className="ctl__group">
            <button type="button" className="ctl__btn ctl__btn--small ctl__btn--red" disabled={busy} onClick={() => void trigger("reset")}>
              Reset to a new S0 group?
            </button>
            <button type="button" className="ctl__btn ctl__btn--small" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="ctl__btn ctl__btn--small" disabled={busy} onClick={() => setConfirmReset(true)}>
            <RotateCcw size={12} aria-hidden /> Reset
          </button>
        )}
      </div>
      <div className="ctl__state" aria-live="polite">
        {busy ? (
          <span className="ctl__run">
            <Loader2 size={14} className="ctl__spin" aria-hidden /> {LABEL[status.running!]}: running… {elapsed}s
          </span>
        ) : last ? (
          <button type="button" className={`ctl__last ${last.ok ? "ctl__last--ok" : "ctl__last--bad"}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {last.ok ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />} {LABEL[last.action]} {last.ok ? "ok" : `failed (exit ${last.exit_code})`}
            <ChevronDown size={12} aria-hidden className={open ? "ctl__chev--open" : ""} />
          </button>
        ) : (
          <span className="muted small">ready</span>
        )}
        {error && <span className="ctl__err">{error}</span>}
      </div>
      {open && !busy && last && <pre className="ctl__tail">{last.tail.join("\n")}</pre>}
      {busy && status.running_tail.length > 0 && open && <pre className="ctl__tail">{status.running_tail.join("\n")}</pre>}
    </section>
  );
}
