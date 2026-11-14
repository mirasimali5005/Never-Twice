// REV-01 (Tier 3, CP-REV-1): provider-side reversal end to end on the simulator (HANDOVER §11.3 PROVIDER_REVERSAL; §21 "a provider's
// acknowledgement is not payment finality").
//
//   seed S0 (nt arm only) → runner → reconciler --until-drained → runner --report-only → auditor SAFETY PASS
//   the simulator later reverses P02's paid payout (POST /admin/payouts/reverse)
//   the stale report still says P02 was paid → the auditor FAILs C5 (a reversed object is not a payment)
//   reconciler --once --watch records one PROVIDER_REVERSAL audit event; P02 stays CONFIRMED; nothing is re-sent
//   runner --report-only parks P02 as PROVIDER_REVERSAL → the auditor prints SAFETY PASS again (completion drops by one)
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NtDb } from "../../packages/db/src/index.ts";
import { auditRun } from "../helpers/evaluator.ts";
import { runNode, tail } from "../helpers/proc.ts";
import { PATHS, REPO, reconcilerEntry, startWorld, type World } from "../helpers/world.ts";

const notRunnable = !existsSync(PATHS.runner) || !reconcilerEntry() ? "not runnable yet: runner or reconciler missing" : null;
const P02 = "ZT4H9X.P02.NT101-20261110.APPR_DELAY";
const MIN = 60_000;

function defineRev01(): void {
  describe("REV-01 provider-side reversal on the simulator", () => {
    let world: World;
    let db: NtDb;
    let run = "";
    let account = "";

    const runner = async (extra: string[] = []) => {
      const r = await runNode([PATHS.runner, "--run", run, "--arm", "nt", ...extra], world.procEnv("runner", { NT_RUN_ID: run, NT_ARM: "nt" }), { cwd: REPO, timeoutMs: 2 * MIN, label: `runner ${extra.join(" ")}` });
      expect(r.code, `runner ${extra.join(" ")}\n${tail(r.stdout)}\n${tail(r.stderr)}`).toBe(0);
    };
    const reconcile = async (args: string[]) => {
      const r = await runNode([reconcilerEntry()!, "--run", run, ...args], world.procEnv("reconciler", { NT_RUN_ID: run, NT_ARM: "nt" }), { cwd: REPO, timeoutMs: 3 * MIN, label: `reconcile ${args.join(" ")}` });
      expect(r.code, `reconcile ${args.join(" ")}\n${tail(r.stdout)}\n${tail(r.stderr)}`).toBe(0);
      return r.stdout;
    };
    const admin = (path: string, body: object) =>
      fetch(`${world.simUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${world.procEnv("seed").NT_SIM_ADMIN_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const ledgerCount = async () => {
      const r = await fetch(`${world.simUrl}/v1/payouts?account=${account}&limit=100`, { headers: { Authorization: `Bearer ${world.procEnv("reconciler").NT_SIM_READ_KEY}` } });
      return ((await r.json()) as { data: unknown[] }).data.length;
    };

    beforeAll(async () => {
      world = await startWorld();
      const seeded = await world.seedS0(["nt"]);
      run = seeded.runs[0]!.run_id;
      account = seeded.runs[0]!.sim_account;
      db = await world.openDb();
    }, 5 * MIN);

    afterAll(async () => {
      await db?.close().catch(() => {});
      await world?.stop();
    });

    it(
      "a clean run audits SAFETY PASS; a later reversal at the provider is caught, parked for a person, never re-paid",
      async () => {
        await runner();
        await reconcile(["--until-drained"]);
        await runner(["--report-only"]);
        const first = await auditRun(run, world.evaluatorEnv());
        expect(first.certificate.safety, first.text).toBe("PASS");

        const p02 = await db.intents.findOne({ _id: `${run}:${P02}` });
        expect(p02?.state).toBe("CONFIRMED");
        const objectId = p02!.evidence!.provider_object_id;
        const objectsBefore = await ledgerCount();

        const rev = await admin("/admin/payouts/reverse", { account, id: objectId });
        expect(rev.status, await rev.clone().text()).toBe(200);

        // The stale report still claims P02 paid: the auditor reads the provider and fails C5.
        const stale = await auditRun(run, world.evaluatorEnv());
        expect(stale.exitCode, stale.text).toBe(1);
        expect(stale.certificate.checks.C5?.status, stale.text).toBe("FAIL");
        expect(stale.certificate.findings.filter((f) => f.check === "C5").map((f) => f.effect_key)).toEqual([P02]);

        const out = await reconcile(["--once", "--watch"]);
        expect(out).toContain("PROVIDER_REVERSAL");
        const evs = await db.audit.find({ run_id: run, type: "PROVIDER_REVERSAL" }).toArray();
        expect(evs.map((e) => e.intent_id)).toEqual([`${run}:${P02}`]);
        const after = await db.intents.findOne({ _id: `${run}:${P02}` });
        expect(after?.state).toBe("CONFIRMED"); // CONFIRMED is still terminal
        expect(after?.updated_at).toEqual(p02!.updated_at);
        expect(await ledgerCount()).toBe(objectsBefore); // never re-paid
        await reconcile(["--once", "--watch"]); // a second pass records nothing new
        expect(await db.audit.countDocuments({ run_id: run, type: "PROVIDER_REVERSAL" })).toBe(1);

        await runner(["--report-only"]);
        const report = (await db.runs.findOne({ _id: run }))?.final_report;
        expect(report?.paid.map((p) => p.effect_key)).not.toContain(P02);
        expect(report?.parked).toContainEqual({ effect_key: P02, claim_id: null, reason_code: "PROVIDER_REVERSAL", amount_minor: 70000 });

        const fixed = await auditRun(run, world.evaluatorEnv());
        expect(fixed.exitCode, fixed.text).toBe(0);
        expect(fixed.certificate.safety, fixed.text).toBe("PASS");
        expect(fixed.certificate.completion.owed_paid[0]).toBe(first.certificate.completion.owed_paid[0] - 1);
      },
      12 * MIN,
    );
  });
}

if (notRunnable) {
  describe("REV-01 provider-side reversal", () => {
    it.skip(notRunnable, () => {});
  });
} else {
  defineRev01();
}
