// The story of the selected Never Twice payment as a strip: Claim → Reserved → Sent → Crash → In doubt → Investigation → Recovered.
// Derived only from that payment's trail (attempts, investigations, intent state) and the run's status; no step is invented.
import { AlertTriangle, CircleCheck, FileText, Lock, Search, Send, UserRound, Zap, Hourglass } from "lucide-react";
import { isBaseline } from "../trailSteps";
import type { ApiResult } from "../api";
import type { AnyTrail, RunSummary } from "../types";

type Stage = { id: string; label: string; icon: typeof Send; done: boolean; tone?: "amber" | "green" | "blue" | "red" };

export function Timeline(props: { trail: ApiResult<AnyTrail> | null; summary: ApiResult<RunSummary> | null }) {
  const status = props.summary?.ok ? props.summary.data.status : null;
  const t = props.trail?.ok && !isBaseline(props.trail.data) ? props.trail.data : null;
  if (!t) {
    return (
      <div className="timeline timeline--idle">
        <Hourglass size={16} aria-hidden />
        {status === "PAUSED" || status === "SEEDED" ? "Waiting for the judge's go" : "The timeline appears once a Never Twice payment is selected"}
      </div>
    );
  }
  const i = t.intent;
  const attempts = i.attempts ?? [];
  const invs = (t.investigations ?? []).filter(Boolean);
  // a send with no answer counts as lost only once the desk itself has said so (outcome unknown, or an investigation opened);
  // a DISPATCHING mark alone may still be in flight
  const lost =
    attempts.some((a) => a.result != null && (a.result.kind === "INDETERMINATE" || a.result.kind === "LEASE_EXPIRED")) ||
    (attempts.some((a) => a.result == null) && (i.state !== "DISPATCHING" || invs.length > 0));
  const inDoubt = lost || invs.length > 0 || i.state === "DISPATCHING" || i.state === "OUTCOME_UNKNOWN";
  const last = invs[invs.length - 1];
  const decision = last?.decision?.kind ?? null;
  let recovered: Stage = { id: "rec", label: "Recovered", icon: CircleCheck, done: false };
  if (i.state === "CONFIRMED" && invs.length > 0) {
    recovered = { id: "rec", label: decision === "REDISPATCH_SAME_KEY" ? "Re-sent, same key" : "Confirmed on evidence", icon: CircleCheck, done: true, tone: "green" };
  } else if (i.state === "CONFIRMED") {
    recovered = { id: "rec", label: "Confirmed", icon: CircleCheck, done: true, tone: "green" };
  } else if (i.state === "QUARANTINED") {
    const reversed = i.quarantine?.reason === "PROVIDER_REVERSAL";
    recovered = { id: "rec", label: reversed ? "Reversed: needs a person" : "Needs a person", icon: UserRound, done: true, tone: reversed ? "red" : "blue" };
  }
  const stages: Stage[] = [
    { id: "claim", label: "Claim", icon: FileText, done: true },
    { id: "res", label: "Reserved", icon: Lock, done: true },
    { id: "sent", label: "Sent", icon: Send, done: attempts.length > 0 || i.state !== "RESERVED" },
    { id: "crash", label: "Crash / kill", icon: Zap, done: lost, tone: lost ? "red" : undefined },
    { id: "doubt", label: "In doubt", icon: AlertTriangle, done: inDoubt, tone: inDoubt ? "amber" : undefined },
    { id: "inv", label: "Investigation", icon: Search, done: invs.length > 0, tone: invs.length > 0 && !last?.decision ? "amber" : undefined },
    recovered,
  ];
  return (
    <ol className="timeline" aria-label="What happened to the selected payment">
      {stages.map((s) => {
        const Icon = s.icon;
        return (
          <li key={s.id} className={`tl${s.done ? " tl--done" : ""}${s.tone ? ` tl--${s.tone}` : ""}`}>
            <span className="tl__dot">
              <Icon size={15} aria-hidden />
            </span>
            <span className="tl__label">{s.label}</span>
          </li>
        );
      })}
      {status === "PAUSED" && <li className="tl__status">paused: waiting for the judge's go</li>}
    </ol>
  );
}
