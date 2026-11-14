// Pure renderer for the terminal fallback: two columns (ordinary agent | Never Twice), three payment colours, the certificate.
// Amber = in doubt (sent, outcome unknown); green = confirmed; grey-blue = needs a person. Wording follows HANDOVER §2.

export type RowState = "CONFIRMED" | "IN_DOUBT" | "NEEDS_PERSON" | "PENDING" | "NO_EFFECT" | "DUPLICATE";
export type PaymentRow = { effect_key: string; state: string | null; amount_minor: number; provider_count: number | null };
export type CertSummary = { safety: "PASS" | "FAIL"; findings: { check: string; subject: string }[]; manifest_matches: boolean | null };
export type RunView = {
  run_id: string;
  arm: string;
  status: string;
  claims: Record<string, number>;
  rows: PaymentRow[];
  provider_statement: { objects: number; total_minor: number } | null;
  certificate: CertSummary | null;
};
export type Snapshot = { group_id: string; scenario: string; manifest_sha256: string | null; db_label: string; runs: RunView[]; at: string };

const COLOURS = { amber: 214, green: 42, blue: 110, red: 203, dim: 245 } as const;
type Colour = keyof typeof COLOURS;

export function paint(text: string, colour: Colour | null, on: boolean, bold = false): string {
  if (!on || (colour === null && !bold)) return text;
  const codes = [bold ? "1" : "", colour ? `38;5;${COLOURS[colour]}` : ""].filter(Boolean).join(";");
  return `\u001b[${codes}m${text}\u001b[0m`;
}

/** Maps an intent state (or provider-only evidence) to the three display classes. */
export function classify(row: PaymentRow): RowState {
  if (row.provider_count !== null && row.provider_count > 1) return "DUPLICATE";
  switch (row.state) {
    case "CONFIRMED":
      return "CONFIRMED";
    case "DISPATCHING":
    case "OUTCOME_UNKNOWN":
      return "IN_DOUBT";
    case "QUARANTINED":
      return "NEEDS_PERSON";
    case "FAILED_NO_EFFECT":
    case "RELEASED":
      return "NO_EFFECT";
    case null:
      return row.provider_count && row.provider_count > 0 ? "CONFIRMED" : "PENDING";
    default:
      return "PENDING";
  }
}

const STATE_STYLE: Record<RowState, { colour: Colour | null; label: string }> = {
  CONFIRMED: { colour: "green", label: "Confirmed" },
  IN_DOUBT: { colour: "amber", label: "In doubt: sent, outcome unknown" },
  NEEDS_PERSON: { colour: "blue", label: "Needs a person" },
  PENDING: { colour: "dim", label: "Waiting" },
  NO_EFFECT: { colour: "dim", label: "No effect" },
  DUPLICATE: { colour: "red", label: "PAID TWICE" },
};
export function stateStyle(s: RowState): { colour: Colour | null; label: string } {
  return STATE_STYLE[s];
}

const money = (m: number) => `${Math.trunc(m / 100)}.${String(m % 100).padStart(2, "0")}`;
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
export const visibleLength = (s: string) => stripAnsi(s).length;
function fit(s: string, w: number): string {
  const plain = stripAnsi(s);
  if (plain.length <= w) return s + " ".repeat(w - plain.length);
  return plain.slice(0, Math.max(0, w - 1)) + "…";
}

function rowLabel(effectKey: string): string {
  const [, pax = "?", , type = "?"] = effectKey.split(".");
  return `${pax} ${type.replace(/^APPR_/, "")}`;
}

function column(run: RunView | undefined, title: string, w: number, color: boolean): string[] {
  const out: string[] = [];
  out.push(paint(title, null, color, true));
  if (!run) return [...out, paint("(no run for this arm in the group)", "dim", color)];
  out.push(paint(`${run.run_id}  ${run.status}`, "dim", color));
  const claims = Object.entries(run.claims).map(([k, v]) => `${v} ${k}`).join(", ");
  out.push(paint(`claims: ${claims || "none"}`, "dim", color));
  out.push("");
  if (run.rows.length === 0) out.push(paint("no payments yet", "dim", color));
  for (const r of [...run.rows].sort((x, y) => x.effect_key.localeCompare(y.effect_key))) {
    const st = classify(r);
    const { colour, label } = stateStyle(st);
    const dup = r.provider_count !== null && r.provider_count > 1 ? ` x${r.provider_count} at provider` : "";
    const left = `${rowLabel(r.effect_key).padEnd(22)} ${money(r.amount_minor).padStart(8)}`;
    out.push(paint(fit(`● ${left}  ${label}${dup}`, w), colour, color, st === "DUPLICATE"));
  }
  if (run.provider_statement) {
    out.push("");
    out.push(paint(fit(`SIMULATOR statement: ${run.provider_statement.objects} payouts, ${money(run.provider_statement.total_minor)} CAD`, w), "dim", color));
  }
  const c = run.certificate;
  out.push("");
  if (c) {
    out.push(paint(`AUDITOR  SAFETY: ${c.safety}`, c.safety === "PASS" ? "green" : "red", color, true));
    for (const f of c.findings.slice(0, 4)) out.push(paint(fit(`  ${f.check} ${f.subject}`, w), "red", color));
    if (c.manifest_matches !== null) out.push(paint(c.manifest_matches ? "  manifest hash matches pre-run commitment" : "  MANIFEST HASH DIFFERS", c.manifest_matches ? "dim" : "red", color));
  } else out.push(paint("AUDITOR  no certificate yet", "dim", color));
  return out;
}

export function render(s: Snapshot, opts: { width?: number; color?: boolean } = {}): string {
  const width = Math.max(60, opts.width ?? 120);
  const color = opts.color ?? true;
  const w = Math.floor((width - 3) / 2);
  const byArm = (arm: string) => s.runs.find((r) => r.arm === arm);
  const left = column(byArm("control"), "ORDINARY AGENT (control)", w, color);
  const right = column(byArm("nt"), "NEVER TWICE", w, color);
  const n = Math.max(left.length, right.length);
  const lines: string[] = [];
  lines.push(`Never Twice   group ${s.group_id}   scenario ${s.scenario}   ${s.db_label}   SIMULATOR provider   ${s.at}`);
  lines.push(s.manifest_sha256 ? `manifest sha256 ${s.manifest_sha256} (committed before the run)` : "manifest: not found");
  lines.push("─".repeat(Math.min(width, 140)));
  for (let i = 0; i < n; i++) lines.push(`${fit(left[i] ?? "", w)} │ ${right[i] ?? ""}`.trimEnd());
  const mutant = byArm("nt_mutant");
  if (mutant) {
    lines.push("─".repeat(Math.min(width, 140)));
    const c = mutant.certificate;
    const confirmed = mutant.rows.filter((r) => classify(r) === "CONFIRMED").length;
    lines.push(
      paint(`MUTANT RUN — M2 — test of the auditor   ${mutant.run_id}  ${mutant.status}  ${confirmed}/${mutant.rows.length} payments marked confirmed   `, "dim", color) +
        (c ? paint(`SAFETY: ${c.safety}${c.findings.length ? " " + [...new Set(c.findings.map((f) => f.check))].join(",") : ""}`, c.safety === "PASS" ? "green" : "red", color, true) : paint("no certificate yet", "dim", color)),
    );
  }
  lines.push("");
  lines.push(
    [paint("● Confirmed", "green", color), paint("● In doubt: sent, outcome unknown", "amber", color), paint("● Needs a person", "blue", color)].join("   ") +
      "   Confirmed means: the provider holds one matching payment, not that money arrived.",
  );
  return lines.join("\n");
}

/** A mock group for the renderer's tests and for a quick look without a database. */
export function mockSnapshot(): Snapshot {
  const mk = (arm: string, rows: PaymentRow[], cert: CertSummary | null): RunView => ({
    run_id: arm === "nt" ? "r7k2m9qa" : arm === "control" ? "r4c1ntr0" : "rmut4nt0",
    arm,
    status: "RUNNING",
    claims: { RESOLVED: 4, HELD: 1 },
    rows,
    provider_statement: { objects: rows.length, total_minor: rows.reduce((t, r) => t + r.amount_minor, 0) },
    certificate: cert,
  });
  const k = (p: string, t: string) => `K${p}.${p}.NT101-20261110.${t}`;
  return {
    group_id: "gq4w8n2c",
    scenario: "S0",
    manifest_sha256: "0".repeat(64),
    db_label: "LOCAL DATABASE",
    at: "00:00:00",
    runs: [
      mk("control", [{ effect_key: k("P02", "APPR_DELAY"), state: null, amount_minor: 70000, provider_count: 2 }, { effect_key: k("P13", "APPR_DELAY"), state: null, amount_minor: 70000, provider_count: 1 }], { safety: "FAIL", findings: [{ check: "C1", subject: k("P02", "APPR_DELAY") }], manifest_matches: true }),
      mk("nt", [{ effect_key: k("P02", "APPR_DELAY"), state: "CONFIRMED", amount_minor: 70000, provider_count: 1 }, { effect_key: k("P11", "APPR_DENIED_BOARDING"), state: "QUARANTINED", amount_minor: 90000, provider_count: 0 }, { effect_key: k("P13", "APPR_DELAY"), state: "OUTCOME_UNKNOWN", amount_minor: 70000, provider_count: 0 }], { safety: "PASS", findings: [], manifest_matches: true }),
      mk("nt_mutant", [{ effect_key: k("P13", "APPR_DELAY"), state: "CONFIRMED", amount_minor: 70000, provider_count: 0 }], { safety: "FAIL", findings: [{ check: "C5", subject: k("P13", "APPR_DELAY") }], manifest_matches: true }),
    ],
  };
}
