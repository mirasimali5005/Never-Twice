// The recovery story of the selected Never Twice payment: Claim received → Payment reserved → Payment sent → System crash →
// Investigation → Verified recovery. Derived only from that payment's trail (attempts, investigations, intent state) and the
// run's status; no step is invented.
import { CircleCheck, FileText, Hourglass, Lock, Search, Send, UserRound, Zap } from "lucide-react";
import { isBaseline } from "../trailSteps";
import type { ApiResult } from "../api";
import type { AnyTrail, PaymentTrail, RunSummary } from "../types";

type Tone = "red" | "green" | "neutral" | "active";
type Stage = { id: string; label: string; icon: typeof Send; done: boolean; tone?: Tone };

/** What the trail of one Never Twice payment shows, in phases. Pure; shared by the timeline and the hero's stage. */
export function trailPhase(t: PaymentTrail) {
  const i = t.intent;
  const attempts = i.attempts ?? [];
  const invs = (t.investigations ?? []).filter(Boolean);
  // a send with no answer counts as lost only once the desk itself has said so (outcome unknown, or an investigation opened);
  // a DISPATCHING mark alone may still be in flight
  const lost =
    attempts.some((a) => a.result != null && (a.result.kind === "INDETERMINATE" || a.result.kind === "LEASE_EXPIRED")) ||
    (attempts.some((a) => a.result == null) && (i.state !== "DISPATCHING" || invs.length > 0));
  const last = invs[invs.length - 1];
  return {
    sent: attempts.length > 0 || i.state !== "RESERVED",
    lost,
    investigating: invs.length > 0 && !last?.decision,
    investigated: invs.length > 0,
    decision: last?.decision?.kind ?? null,
    confirmed: i.state === "CONFIRMED",
    quarantined: i.state === "QUARANTINED",
    reversed: i.quarantine?.reason === "PROVIDER_REVERSAL",
  };
}

export function Timeline(props: { trail: ApiResult<AnyTrail> | null; summary: ApiResult<RunSummary> | null }) {
  const status = props.summary?.ok ? props.summary.data.status : null;
  const t = props.trail?.ok && !isBaseline(props.trail.data) ? props.trail.data : null;
  const p = t ? trailPhase(t) : null;

  let recovered: Stage = { id: "rec", label: "Verified recovery", icon: CircleCheck, done: false };
  if (p?.confirmed && p.investigated) {
    recovered = { id: "rec", label: p.decision === "REDISPATCH_SAME_KEY" ? "Verified: re-sent, same key" : "Verified recovery", icon: CircleCheck, done: true, tone: "green" };
  } else if (p?.confirmed) {
    recovered = { id: "rec", label: "Verified at provider", icon: CircleCheck, done: true, tone: "green" };
  } else if (p?.quarantined) {
    recovered = { id: "rec", label: p.reversed ? "Reversed: needs a person" : "Parked for a person", icon: UserRound, done: true, tone: p.reversed ? "red" : "neutral" };
  }
  const stages: Stage[] = [
    { id: "claim", label: "Claim received", icon: FileText, done: t !== null },
    { id: "res", label: "Payment reserved", icon: Lock, done: t !== null },
    { id: "sent", label: "Payment sent", icon: Send, done: p?.sent ?? false },
    { id: "crash", label: "System crash", icon: Zap, done: p?.lost ?? false, tone: p?.lost ? "red" : undefined },
    { id: "inv", label: "Investigation", icon: Search, done: p?.investigated ?? false, tone: p?.investigating ? "active" : undefined },
    recovered,
  ];
  const note = !t
    ? status === "PAUSED" || status === "SEEDED"
      ? "Paused: waiting for the go"
      : "Lights up once a Never Twice payment exists"
    : status === "PAUSED"
      ? "Paused: waiting for the go"
      : null;
  return (
    <section className="glass rtl" aria-label="Recovery timeline for the selected payment">
      <div className="rtl__head">
        <span className="eyebrow">Recovery timeline</span>
        {note && (
          <span className="rtl__note">
            <Hourglass size={13} aria-hidden /> {note}
          </span>
        )}
      </div>
      <ol className="rtl__track">
        {stages.map((s) => {
          const Icon = s.icon;
          return (
            <li key={s.id} className={`tl${s.done ? " tl--done" : ""}${s.tone ? ` tl--${s.tone}` : ""}`} aria-current={s.tone === "active" ? "step" : undefined}>
              <span className="tl__dot">
                <Icon size={16} aria-hidden />
              </span>
              <span className="tl__label">{s.label}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
