// pnpm demo:late-commit [--payee payee_P11] [--no-audit]
// Finals beat: P11's held late commit lands (POST /admin/faults/release on the nt and control accounts). Then the reconciler runs one pass with
// --watch on the nt run: the watcher finds the payment from positive evidence and confirms the parked P11 (T12). Then re-audit.
// DEMO_RUNBOOK §12: "Had we re-sent, she would have been paid twice."
import { parseArgs, runMain } from "../lib/args.ts";
import { openSimAdmin } from "../lib/env.ts";
import { childEnv, currentGroup, DESK_API, reconcileCmd, runCmd, runOf, secs, TSX } from "./lib.ts";
import { simAccountOf } from "../lib/ids.ts";

type Statement = { paid_twice: number; entitlements: { effect_key: string; count: number; amount_minor_total: number }[] };

async function p11Line(arm: string, runId: string, key: string): Promise<string> {
  try {
    const res = await fetch(`${DESK_API}/api/runs/${runId}/provider-statement`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return `${arm}: provider statement unavailable (${res.status})`;
    const st = (await res.json()) as Statement;
    const e = st.entitlements.find((x) => x.effect_key === key);
    if (!e) return `${arm.padEnd(8)} provider holds no payment for P11`;
    return `${arm.padEnd(8)} provider holds ${e.count} payment(s) for P11, ${(e.amount_minor_total / 100).toFixed(2)} CAD against 900.00 owed${e.count > 1 ? "   ** PAID TWICE **" : ""}`;
  } catch (e) {
    return `${arm}: provider statement unavailable (${e instanceof Error ? e.message : String(e)})`;
  }
}

await runMain(async () => {
  const a = parseArgs(process.argv.slice(2), ["payee"]);
  const payee = a.values.get("payee") ?? "payee_P11";
  const cur = currentGroup();
  const nt = runOf(cur, "nt");
  const ctl = runOf(cur, "control");
  const t0 = Date.now();
  const key = cur.scenario === "S0" || cur.scenario === "S1" ? "PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING" : "";

  const sim = openSimAdmin();
  console.log(`before: ${await p11Line("control", ctl, key)}`);
  console.log(`before: ${await p11Line("nt", nt, key)}`);
  for (const [arm, runId] of [["nt", nt], ["control", ctl]] as const) {
    const r = await sim.releaseHeld(simAccountOf(runId), { payee_ref: payee });
    console.log(`release ${arm.padEnd(7)} ${simAccountOf(runId)} ${payee}: ${JSON.stringify(r)}`);
  }
  console.log(`released in ${secs(Date.now() - t0)}`);

  console.log("\nwatcher: one reconciler pass with --watch on the nt run");
  const w = await runCmd({ ...reconcileCmd(nt, ["--once", "--watch"]), env: childEnv({ NT_MODEL_MODE: "live", NT_MODEL_BACKEND: process.env.NT_MODEL_BACKEND || "cli" }), prefix: "[recon nt]", log: "reconciler-late-commit" });
  console.log(`watcher pass: exit ${w.code} after ${secs(w.ms)}`);

  console.log("");
  console.log(`after:  ${await p11Line("control", ctl, key)}`);
  console.log(`after:  ${await p11Line("nt", nt, key)}`);

  if (!a.flags.has("no-audit")) {
    console.log("\nre-audit");
    await runCmd({ command: TSX, args: ["--env-file-if-exists=.env", "scripts/demo/audit.ts", "--brief"], prefix: "" });
  }
  console.log(`\nlate-commit done in ${secs(Date.now() - t0)}`);
});
