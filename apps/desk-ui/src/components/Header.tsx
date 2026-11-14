import { formatStamp, shortHash } from "../format";
import type { ApiResult } from "../api";
import type { GroupView } from "../types";
import type { StreamStatus } from "../useEvents";

const ARM_LABEL: Record<string, string> = {
  nt: "Never Twice",
  control: "Ordinary agent (control)",
  nt_mutant: "Labelled mutant M2 (test of the auditor)",
  documented: "Documented practice",
  rules_only: "Rules only",
};

export function Header(props: {
  groupId: string;
  group: ApiResult<GroupView> | null;
  manifest: { hash: string | null; commitment: string | null };
  mock: boolean;
  stream: StreamStatus;
  intakeReplay: boolean;
  onHowItWorks?: () => void;
}) {
  const g = props.group && props.group.ok ? props.group.data : null;
  const { hash, commitment } = props.manifest;
  const equal = hash && commitment ? hash === commitment : null;
  return (
    <header className="header">
      <div className="header__top">
        <div className="brand">
          <span className="brand__name">Never Twice</span>
          <span className="brand__thesis">the claims desk that refuses to guess</span>
        </div>
        <div className="labels">
          {g?.recorded && (
            <span className="label label--recorded">
              RECORDED{g.recorded_at && formatStamp(g.recorded_at) ? ` ${formatStamp(g.recorded_at)}` : ""}
            </span>
          )}
          {g?.database === "local" && <span className="label label--local" title="Not the Atlas sandbox: this desk reads a local database">LOCAL DATABASE</span>}
          {props.mock && <span className="label label--mock">Mock data</span>}
          <span className="label">Compensation provider: simulator</span>
          <span className="label label--stripe">Stripe: test mode</span>
          {props.intakeReplay && <span className="label">Intake: replayed from a recording</span>}
          {props.onHowItWorks && (
            <button type="button" className="label label--button" onClick={props.onHowItWorks} title="beat 13: what is built, what is simulated">
              How it works
            </button>
          )}
          <span className={`dot dot--${props.stream}`} title={`event stream: ${props.stream}`} aria-label={`event stream ${props.stream}`} />
        </div>
      </div>
      <div className="header__meta">
        <span>
          Group <b className="mono">{props.groupId}</b>
          {g && <> · scenario {g.scenario}</>}
        </span>
        <span title={hash ?? undefined}>
          Manifest sha256{" "}
          {hash ? (
            <b className="mono">{shortHash(hash, 12)}</b>
          ) : (
            <i>appears here once the auditor has run</i>
          )}{" "}
          {hash && <><span className="badge badge--green">committed before the run</span>{equal === true && <span className="ok"> · equals the commitment</span>}{equal === false && <span className="bad"> · DIFFERS from the commitment</span>}</>}
        </span>
        <span className="runs">
          {g === null && props.group && !props.group.ok && <span className="bad">group unavailable ({props.group.error})</span>}
          {g?.runs.map((r) => (
            <span key={r.run_id} className={`runid runid--${r.arm}`}>
              {ARM_LABEL[r.arm] ?? r.arm} <b className="mono">{r.run_id}</b>
            </span>
          ))}
        </span>
      </div>
    </header>
  );
}
