// The top of the page: the claim in three lines, the demo stage derived from real state, and small neutral badges.
import { BookOpen, FileSearch } from "lucide-react";
import { formatStamp } from "../format";
import type { StreamStatus } from "../useEvents";
import type { GroupView } from "../types";

export const STAGES = ["Paused", "Payments sending", "Crash", "Investigating", "Recovered", "Audited"] as const;
export type StageName = (typeof STAGES)[number];

export function Hero(props: {
  group: GroupView | null;
  stage: StageName | null;
  mock: boolean;
  stream: StreamStatus;
  intakeReplay: boolean;
  onHowItWorks: () => void;
  onEvidence: () => void;
}) {
  const g = props.group;
  const idx = props.stage ? STAGES.indexOf(props.stage) : -1;
  return (
    <header className="top">
      <div className="top__copy">
        <div className="top__brand">NEVER TWICE</div>
        <h1 className="top__title">AI agents that finish the job, without repeating it.</h1>
        <p className="top__sub">We crashed two agents during the same payment. One paid twice. One recovered safely.</p>
      </div>
      <div className="top__side">
        <div className="stage" aria-live="polite">
          <div className="stage__row">
            <span className="eyebrow">Demo stage</span>
            <span className={`stage__now${props.stage === "Crash" ? " stage__now--red" : props.stage === "Audited" || props.stage === "Recovered" ? " stage__now--green" : ""}`}>
              <span className={`dot dot--${props.stream}`} aria-hidden />
              {props.stage ?? "Connecting"}
            </span>
          </div>
          <ol className="stage__bar" aria-label={`Stage ${idx + 1} of ${STAGES.length}`}>
            {STAGES.map((s, i) => (
              <li key={s} className={`stage__seg${i <= idx ? " stage__seg--on" : ""}${i === idx ? " stage__seg--now" : ""}`} title={s}>
                <span className="sr">{s}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="pills">
          {g?.recorded && <span className="pill">Recorded{g.recorded_at && formatStamp(g.recorded_at) ? ` ${formatStamp(g.recorded_at)}` : ""}</span>}
          {g?.database === "local" && <span className="pill">Local database</span>}
          {props.mock && <span className="pill">Mock data</span>}
          <span className="pill">Payout provider: simulator</span>
          <span className="pill">Stripe: test mode</span>
          {props.intakeReplay && <span className="pill">Intake replayed</span>}
          <button type="button" className="pill pill--btn" onClick={props.onHowItWorks}>
            <BookOpen size={13} aria-hidden /> How it works
          </button>
          <button type="button" className="pill pill--btn" onClick={props.onEvidence}>
            <FileSearch size={13} aria-hidden /> Technical evidence
          </button>
        </div>
      </div>
    </header>
  );
}
