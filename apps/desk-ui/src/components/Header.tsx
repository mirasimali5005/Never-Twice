import { shortHash } from "../format";
import type { ApiResult } from "../api";
import type { GroupView } from "../types";
import type { StreamStatus } from "../useEvents";

const ARM_LABEL: Record<string, string> = {
  nt: "Never Twice",
  control: "Ordinary agent (control)",
  nt_mutant: "Labelled mutant (test of the auditor)",
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
          {g?.recorded && <span className="label label--recorded">Recorded run</span>}
          {props.mock && <span className="label label--mock">Mock data</span>}
          <span className="label">Compensation provider: simulator</span>
          {props.intakeReplay && <span className="label">Intake: replayed from a recording</span>}
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
          {hash && <>committed before the run{equal === true && <span className="ok"> · equals the commitment</span>}{equal === false && <span className="bad"> · DIFFERS from the commitment</span>}</>}
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
