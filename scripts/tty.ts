// pnpm demo:tty -- [--group g...] [--once] [--no-color] [--mock] [--interval ms]
// Terminal fallback for the desk UI. Polls MongoDB with the read-only desk role (no write path), the simulator's read endpoint,
// and the evaluator's certificate files; renders two columns. Reads nothing from evaluator/hidden.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { parseArgs, runMain, UsageError } from "./lib/args.ts";
import { dbLabel, openOwnerDb, simUrl } from "./lib/env.ts";
import { EVALUATOR_OUT, NT_DIR } from "./lib/paths.ts";
import { readCurrent } from "./lib/state.ts";
import { mockSnapshot, render, type CertSummary, type PaymentRow, type RunView, type Snapshot } from "./lib/tty-render.ts";
import { simAccountOf } from "./lib/ids.ts";
import type { NtDb } from "../packages/db/src/index.ts";

function readCertificate(runId: string): CertSummary | null {
  const f = join(EVALUATOR_OUT, `${runId}.certificate.json`);
  if (!existsSync(f)) return null;
  try {
    const c = JSON.parse(readFileSync(f, "utf8")) as { safety: "PASS" | "FAIL"; findings?: { check: string; effect_key?: string | null; claim_id?: string | null }[]; manifest_sha256?: string; commitment_sha256?: string | null };
    return {
      safety: c.safety,
      findings: (c.findings ?? []).map((x) => ({ check: x.check, subject: x.effect_key ?? x.claim_id ?? "-" })),
      manifest_matches: c.commitment_sha256 ? c.commitment_sha256 === c.manifest_sha256 : null,
    };
  } catch {
    return null;
  }
}

type Payout = { amount_minor: number; metadata?: Record<string, string> };
async function providerStatement(runId: string): Promise<Payout[] | null> {
  const key = process.env.NT_SIM_READ_KEY;
  if (!key) return null;
  const out: Payout[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < 20; page++) {
      const url = `${simUrl()}/v1/payouts?account=${simAccountOf(runId)}&limit=100${cursor ? `&starting_after=${cursor}` : ""}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const body = (await res.json()) as { data: (Payout & { id: string })[]; has_more: boolean; next_cursor: string | null };
      out.push(...body.data);
      if (!body.has_more || !body.next_cursor) break;
      cursor = body.next_cursor;
    }
    return out;
  } catch {
    return null;
  }
}

export async function snapshot(db: NtDb, groupId: string, manifest: string | null): Promise<Snapshot> {
  const runDocs = await db.runs.find({ group_id: groupId }).toArray();
  const runs: RunView[] = [];
  for (const r of runDocs) {
    const [intents, claimAgg, payouts] = await Promise.all([
      db.intents.find({ run_id: r._id }).toArray(),
      db.claims.aggregate<{ _id: string; n: number }>([{ $match: { run_id: r._id } }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
      providerStatement(r._id),
    ]);
    const counts = new Map<string, number>();
    for (const p of payouts ?? []) {
      const k = p.metadata?.nt_effect_key;
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const rows = new Map<string, PaymentRow>();
    for (const i of intents) rows.set(i.effect_key, { effect_key: i.effect_key, state: i.state, amount_minor: i.amount_minor, provider_count: payouts ? (counts.get(i.effect_key) ?? 0) : null });
    for (const p of payouts ?? []) {
      const k = p.metadata?.nt_effect_key;
      if (k && !rows.has(k)) rows.set(k, { effect_key: k, state: null, amount_minor: p.amount_minor, provider_count: counts.get(k) ?? 0 });
    }
    runs.push({
      run_id: r._id,
      arm: r.arm,
      status: r.status,
      claims: Object.fromEntries(claimAgg.map((c) => [c._id, c.n])),
      rows: [...rows.values()],
      provider_statement: payouts ? { objects: payouts.length, total_minor: payouts.reduce((t, p) => t + p.amount_minor, 0) } : null,
      certificate: readCertificate(r._id),
    });
  }
  return { group_id: groupId, scenario: runDocs[0]?.scenario ?? "?", manifest_sha256: manifest, db_label: dbLabel(), runs, at: new Date().toTimeString().slice(0, 8) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain(async () => {
    const a = parseArgs(process.argv.slice(2), ["group", "interval"]);
    const color = !a.flags.has("no-color") && process.stdout.isTTY !== false;
    const width = process.stdout.columns ?? 120;
    if (a.flags.has("mock")) {
      console.log(render(mockSnapshot(), { width, color }));
      return;
    }
    const cur = readCurrent(NT_DIR);
    const group = a.values.get("group") ?? cur?.group_id;
    if (!group) throw new UsageError("no current group: pass --group <group_id> or run `pnpm demo:reset` first");
    const manifest = cur && cur.group_id === group ? cur.manifest_sha256 : null;
    const db = await openOwnerDb("desk"); // read-only use: this script only calls find/aggregate
    const interval = Number(a.values.get("interval") ?? "1000");
    let stop = false;
    process.on("SIGINT", () => (stop = true));
    try {
      do {
        const text = render(await snapshot(db, group, manifest), { width: process.stdout.columns ?? width, color });
        if (a.flags.has("once")) console.log(text);
        else process.stdout.write(`\u001b[2J\u001b[H${text}\n`);
        if (a.flags.has("once")) break;
        await new Promise((r) => setTimeout(r, interval));
      } while (!stop);
    } finally {
      await db.close();
    }
  });
}
