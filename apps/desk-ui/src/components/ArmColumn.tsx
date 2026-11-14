import { EvidenceTrail } from "./EvidenceTrail";
import { PaymentChips } from "./PaymentChips";
import { ProviderStatement } from "./ProviderStatement";
import type { GroupRun } from "../types";
import type { RunData } from "../useRunData";

export function ArmColumn(props: {
  title: string;
  kind: "control" | "nt";
  run: GroupRun | undefined;
  data: RunData;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  groupReady: boolean;
}) {
  const { data, run } = props;
  const isControl = props.kind === "control";
  const rows = data.payments?.ok ? data.payments.data : [];
  const selected = rows.find((r) => r.effect_key === props.selectedKey) ?? null;
  const c = data.summary?.ok ? data.summary.data.colours : null;
  return (
    <section className={`col col--${props.kind}`} aria-label={props.title}>
      <header className="col__head">
        <h1>{props.title}</h1>
        {run && <span className="mono muted">{run.run_id}</span>}
        {!isControl && c && (
          <span className="counts">
            <span className="count count--amber">{c.in_doubt} in doubt</span>
            <span className="count count--green">{c.confirmed} confirmed</span>
            <span className="count count--grey-blue">{c.needs_person} needs a person</span>
          </span>
        )}
        {isControl && <span className="muted small">no write-ahead record, no investigation; a 2xx counts as paid</span>}
      </header>
      {!run ? (
        <div className="cards cards--note">
          {props.groupReady ? `This group has no ${isControl ? "control" : "Never Twice"} run.` : "Waiting for the group: unavailable, not zero."}
        </div>
      ) : (
        <>
          <div className="col__body">
            <PaymentChips rows={data.payments} selectedKey={props.selectedKey} onSelect={props.onSelect} baseline={isControl} statement={data.statement} />
            <EvidenceTrail trail={data.trail} selectedKey={props.selectedKey} />
          </div>
          <ProviderStatement statement={data.statement} selected={selected} isControl={isControl} />
        </>
      )}
    </section>
  );
}
