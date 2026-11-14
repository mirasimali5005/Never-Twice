// Beat 3: the passengers a judge may choose from, shown before `demo:go`. The same table as KILL_TARGETS in scripts/lib/state.ts
// (DEMO_RUNBOOK sections 3 and 4): S0 has one valid target; S1 has six. Names are the fixture's invented people (HANDOVER 7.4).
export const KILL_TARGETS: Record<"S0" | "S1", readonly string[]> = {
  S0: ["P02"],
  S1: ["P01", "P02", "P03", "P05", "P06", "P07"],
};
export const PASSENGER_NAMES: Record<string, string> = {
  P01: "Amara Okafor",
  P02: "Daniel Whitlock",
  P03: "Sofia Marchetti",
  P05: "Tomasz Nowak",
  P06: "Ewa Nowak",
  P07: "Jan Nowak",
};

export function ChoiceStrip(props: { scenario: "S0" | "S1" | null }) {
  if (!props.scenario) return null;
  const list = KILL_TARGETS[props.scenario] ?? [];
  return (
    <section className="choice" aria-label="Passengers a judge may choose">
      <b>{list.length === 1 ? "The kill lands on" : "Name a passenger. Both desks die there"}:</b>
      <ul>
        {list.map((id) => (
          <li key={id}>
            <span className="choice__id mono">{id}</span> {PASSENGER_NAMES[id] ?? ""}
          </li>
        ))}
      </ul>
      <span className="muted small">
        {list.length === 1 ? "scenario S0: the target is fixed" : `scenario ${props.scenario}`}
      </span>
    </section>
  );
}
