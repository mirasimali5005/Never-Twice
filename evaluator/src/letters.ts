// Decision letters (CP-LETTER-1, Tier 3), graded SEPARATELY from payments. A letter is not a payment: it never appears in `paid`, it is
// sent through NotifySim (keyless) and the payment checks C1–C10 never read it (the payment ledger is /v1/payouts only). This module
// reads the run's NotifySim messages (GET /v1/messages with the auditor's read key; GET only) and grades the report's `letters` list:
//   L1 duplicate letter : more than one message carries one letter's marker (a keyless re-send would do this)         → FAIL
//   L2 phantom letter   : the report says CONFIRMED and no message with that id and marker exists                      → FAIL
//   L3 unreported letter: a message carries this run's id and a marker that is not in the report's letters list         → FAIL
//   note                : a message exists for a letter the report holds as QUARANTINED (the system refused to guess)
// Zero dependencies; node: built-ins only.
import { ReportError } from "./report.ts";

export type ReportLetter = { effect_key: string; claim_id: string; marker: string; state: string; provider_object_id: string | null; quarantine_reason: string | null };
export type Message = { id: string; marker: string | null; run_id: string | null };
export type LetterFinding = { check: "L1" | "L2" | "L3"; effect_key: string | null; message: string };
export type LetterGrade = { status: "PASS" | "FAIL" | "NONE"; reported: number; messages: number; findings: LetterFinding[]; notes: string[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The report's optional `letters` list (absent → []). Throws on a malformed entry. */
export function parseLetters(raw: unknown): ReportLetter[] {
  if (!isObj(raw) || raw.letters === undefined) return [];
  if (!Array.isArray(raw.letters)) throw new ReportError("report: letters must be an array");
  return raw.letters.map((x, i) => {
    if (!isObj(x)) throw new ReportError(`report: letters[${i}] must be an object`);
    const s = (k: string) => {
      if (typeof x[k] !== "string") throw new ReportError(`report: letters[${i}].${k} must be a string`);
      return x[k] as string;
    };
    const ns = (k: string) => (x[k] === null || x[k] === undefined ? null : s(k));
    return { effect_key: s("effect_key"), claim_id: s("claim_id"), marker: s("marker"), state: s("state"), provider_object_id: ns("provider_object_id"), quarantine_reason: ns("quarantine_reason") };
  });
}

export function gradeLetters(runId: string, letters: readonly ReportLetter[], messages: readonly Message[]): LetterGrade {
  const findings: LetterFinding[] = [];
  const notes: string[] = [];
  const mine = messages.filter((m) => m.run_id === runId || (m.marker !== null && m.marker.startsWith(`${runId}:`)));
  const byMarker = new Map<string, Message[]>();
  for (const m of mine) if (m.marker !== null) byMarker.set(m.marker, [...(byMarker.get(m.marker) ?? []), m]);
  const reported = new Map(letters.map((l) => [l.marker, l] as const));
  for (const l of letters) {
    const ms = byMarker.get(l.marker) ?? [];
    if (ms.length > 1) findings.push({ check: "L1", effect_key: l.effect_key, message: `${ms.length} messages carry marker ${l.marker}` });
    if (l.state === "CONFIRMED" && !ms.some((m) => m.id === l.provider_object_id)) {
      findings.push({ check: "L2", effect_key: l.effect_key, message: `reported CONFIRMED as ${String(l.provider_object_id)}, no such message with marker ${l.marker}` });
    }
    if (l.state === "QUARANTINED" && ms.length > 0) notes.push(`${l.effect_key}: a message exists but the letter is held for a person (${String(l.quarantine_reason)}); the system did not guess`);
  }
  for (const [mk, ms] of byMarker) {
    if (!reported.has(mk)) findings.push({ check: "L3", effect_key: null, message: `message ${ms[0]!.id} carries marker ${mk}, which the report's letters list does not name` });
  }
  const status = letters.length === 0 && mine.length === 0 ? "NONE" : findings.length === 0 ? "PASS" : "FAIL";
  return { status, reported: letters.length, messages: mine.length, findings, notes };
}

/** GET {base}/v1/messages?account=acct_<run>&limit=20, following next_cursor. GET only, read key only. */
export async function readMessages(o: { baseUrl: string; readKey: string; runId: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<Message[]> {
  const f = o.fetchImpl ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, "");
  const out: Message[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10_000; page++) {
    const q = new URLSearchParams({ account: `acct_${o.runId}`, limit: "20" });
    if (cursor !== null) q.set("starting_after", cursor);
    const res = await f(`${base}/v1/messages?${q.toString()}`, { method: "GET", headers: { Authorization: `Bearer ${o.readKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
    if (res.status !== 200) throw new Error(`NotifySim list: HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!isObj(body) || !Array.isArray(body.data)) throw new Error("NotifySim list: unexpected shape");
    for (const m of body.data) {
      if (!isObj(m) || typeof m.id !== "string") continue;
      const md = isObj(m.metadata) ? m.metadata : {};
      out.push({ id: m.id, marker: typeof md.nt_marker === "string" ? md.nt_marker : null, run_id: typeof md.nt_run_id === "string" ? md.nt_run_id : null });
    }
    cursor = typeof body.next_cursor === "string" && body.next_cursor !== "" ? body.next_cursor : null;
    if (cursor === null) return out;
  }
  throw new Error("NotifySim list: too many pages");
}

export function renderLetters(g: LetterGrade): string {
  if (g.status === "NONE") return "";
  const lines = [`LETTERS (graded separately; letters are not payments): ${g.status} (${g.reported} reported, ${g.messages} message(s) in NotifySim)`];
  for (const f of g.findings) lines.push(`  ${f.check} ${f.effect_key ?? "-"}: ${f.message}`);
  for (const n of g.notes) lines.push(`  note: ${n}`);
  return lines.join("\n") + "\n";
}
