// E4 integration: the orchestrator over real fixtures, replay cassettes (no model call), an in-memory replica set, the real B2 propose and a
// fake dispatch. HANDOVER.md §7.4 (S0, S1 truth), §13 (ingest barrier), §14 (final report), §16 (go file).
import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FinalReport } from "@nt/contracts";
import { adjudicate, ingest } from "../src/ingest.ts";
import { runArm, runReportOnly } from "../src/orchestrator.ts";
import { depsFor, fakeGateway, policyBundle, replayModel, seedRun, startWorld, type World } from "./support/world.ts";

let world: World;
beforeAll(async () => {
  world = await startWorld();
});
afterAll(async () => {
  await world?.stop();
});

const tmpRoot = () => mkdtempSync(join(tmpdir(), "nt-runner-"));
const P = (ref: string, pax: string, type: string) => `${ref}.${pax}.${type.startsWith("APPR_DENIED") || ref === "PC1D6V" || ref === "GT8K4S" ? "NT212-20261110" : ref === "KS2R9B" ? "NT880-20261110" : "NT101-20261110"}.${type}`;

describe("S0 from raw claim text to a final report", () => {
  it("ingests 5 claims, decides 6 obligations, proposes P11, P13, P02, P03 in order, writes a schema-valid report", async () => {
    const { runId } = await seedRun(world.db, "S0");
    const root = tmpRoot();
    const gw = fakeGateway(world.db, runId);
    // E4-INT-02: the barrier holds: at the time of every proposal no claim is RECEIVED or EXTRACTED
    let openAtPropose = -1;
    gw.onPropose = async () => {
      openAtPropose = Math.max(openAtPropose, await world.db.claims.countDocuments({ run_id: runId, status: { $in: ["RECEIVED", "EXTRACTED"] } }));
    };
    const code = await runArm({ runId, pauseBeforePayout: false }, depsFor(world, runId, root, gw));
    expect(code).toBe(0);
    expect(openAtPropose).toBe(0);

    const claims = await world.db.claims.find({ run_id: runId }).toArray();
    expect(claims.map((c) => c.status)).toEqual(Array(5).fill("RESOLVED"));
    expect(claims.every((c) => c.extraction_meta?.mode === "replay" && c.extraction_meta.attempts === 1)).toBe(true);

    const obs = (await world.db.obligations.find({ run_id: runId }).toArray()).map((o) => ({ p: o.passenger_id, t: o.entitlement_type, s: o.status, a: o.amount_minor, r: o.reason_code })).sort((a, b) => (a.p + a.t < b.p + b.t ? -1 : 1));
    expect(obs).toEqual([
      { p: "P02", t: "APPR_DELAY", s: "OWED", a: 70000, r: null },
      { p: "P03", t: "APPR_REFUND_COMP", s: "OWED", a: 40000, r: null },
      { p: "P03", t: "TICKET_REFUND", s: "OWED", a: 41260, r: null },
      { p: "P04", t: "APPR_DELAY", s: "NOT_OWED", a: 0, r: "DELAY_UNDER_3H" },
      { p: "P11", t: "APPR_DENIED_BOARDING", s: "OWED", a: 90000, r: null },
      { p: "P13", t: "APPR_DELAY", s: "OWED", a: 70000, r: null },
    ]);
    const decided = await world.db.audit.countDocuments({ run_id: runId, type: "OBLIGATION_DECIDED" });
    expect(decided).toBe(6);

    expect(gw.proposed).toEqual([
      P("PC1D6V", "P11", "APPR_DENIED_BOARDING"),
      P("KS2R9B", "P13", "APPR_DELAY"),
      P("ZT4H9X", "P02", "APPR_DELAY"),
      P("LM2P8D", "P03", "APPR_REFUND_COMP"),
      P("LM2P8D", "P03", "TICKET_REFUND"),
    ]);
    expect(gw.dispatched).toEqual(gw.proposed);

    const file = join(root, "out", "reports", `${runId}.final-report.json`);
    const report = FinalReport.parse(JSON.parse(readFileSync(file, "utf8")));
    const run = await world.db.runs.findOne({ _id: runId });
    expect(run?.status).toBe("ENDED");
    expect(run?.ended_at).toBeInstanceOf(Date);
    expect(report.group_id).toBe(run?.group_id);
    expect(report.paid.map((p) => p.amount_minor).sort((a, b) => a - b)).toEqual([40000, 41260, 70000, 70000, 90000]);
    expect(report.refused).toEqual([expect.objectContaining({ reason_code: "DELAY_UNDER_3H" })]);
    expect(report.complete).toBe(true);
    expect(run?.final_report).toEqual(JSON.parse(JSON.stringify(report)));
  });

  it("records OUTCOME_UNKNOWN and moves on: never resolves it inline, reports complete: false", async () => {
    const { runId } = await seedRun(world.db, "S0");
    const gw = fakeGateway(world.db, runId, (k) => (k.includes(".P11.") ? "OUTCOME_UNKNOWN" : "CONFIRMED"));
    const code = await runArm({ runId, pauseBeforePayout: false }, depsFor(world, runId, tmpRoot(), gw));
    expect(code).toBe(0);
    expect(gw.dispatched).toHaveLength(5); // the later payments were still sent
    const run = await world.db.runs.findOne({ _id: runId });
    expect(run?.status).toBe("ENDED");
    expect(run?.final_report?.complete).toBe(false);
    expect(run?.final_report?.unresolved).toEqual([{ effect_key: P("PC1D6V", "P11", "APPR_DENIED_BOARDING"), state: "OUTCOME_UNKNOWN" }]);
    expect(run?.final_report?.paid).toHaveLength(4);
  });

  it("a restarted runner dispatches nothing that is not RESERVED (E4-INT-03)", async () => {
    const { runId } = await seedRun(world.db, "S0");
    const root = tmpRoot();
    const first = fakeGateway(world.db, runId);
    await runArm({ runId, pauseBeforePayout: false }, depsFor(world, runId, root, first));
    const second = fakeGateway(world.db, runId);
    expect(await runArm({ runId, pauseBeforePayout: false }, depsFor(world, runId, root, second))).toBe(0);
    expect(second.proposed).toHaveLength(5); // adopted
    expect(second.dispatched).toEqual([]);
    expect(await world.db.intents.countDocuments({ run_id: runId })).toBe(5);
    expect(await world.db.obligations.countDocuments({ run_id: runId })).toBe(6);
  });

  it("refuses to start when --arm differs from execution_runs.arm", async () => {
    const { runId } = await seedRun(world.db, "S0");
    expect(await runArm({ runId, arm: "control", pauseBeforePayout: false }, depsFor(world, runId, tmpRoot()))).toBe(1);
    expect((await world.db.runs.findOne({ _id: runId }))?.status).toBe("SEEDED");
  });
});

describe("S1 adjudication", () => {
  it("collapses C02 and C03, holds P08 on C08's payee change, holds C17, and fills the goodwill pool P10, P01, P05", async () => {
    const { runId } = await seedRun(world.db, "S1");
    const root = tmpRoot();
    const gw = fakeGateway(world.db, runId);
    expect(await runArm({ runId, pauseBeforePayout: false }, depsFor(world, runId, root, gw))).toBe(0);

    const dup = await world.db.obligations.findOne({ _id: `${runId}:ZT4H9X.P02.NT101-20261110.APPR_DELAY` });
    expect(dup?.claim_ids.sort()).toEqual(["C02", "C03"]);
    expect(await world.db.obligations.countDocuments({ run_id: runId, passenger_id: "P02" })).toBe(1);

    const p08 = await world.db.obligations.findOne({ run_id: runId, passenger_id: "P08" });
    expect(p08).toMatchObject({ status: "HELD", reason_code: "PAYEE_CHANGE_REQUESTED" });
    expect(p08?.claim_ids.sort()).toEqual(["C07", "C08"]);
    expect(gw.proposed.some((k) => k.includes(".P08."))).toBe(false);

    const c17 = await world.db.claims.findOne({ _id: `${runId}:C17` });
    expect(c17).toMatchObject({ status: "HELD", hold_reason: "BOOKING_UNRESOLVED" });
    expect(await world.db.audit.countDocuments({ run_id: runId, type: "CLAIM_HELD", claim_id: "C17" })).toBe(1);
    expect(await world.db.obligations.countDocuments({ run_id: runId, passenger_id: "P17" })).toBe(0);

    // goodwill: the pool (500.00) is filled by P10 150, P01 200, P05 150; P06 and P07 are awaiting budget
    const gwReserved = gw.proposed.filter((k) => k.endsWith(".GOODWILL")).map((k) => k.split(".")[1]);
    expect(gwReserved).toEqual(["P10", "P01", "P05", "P06", "P07"]);
    const goodwillIntents = (await world.db.intents.find({ run_id: runId, entitlement_type: "GOODWILL" }).toArray()).map((i) => i.effect_key.split(".")[1]).sort();
    expect(goodwillIntents).toEqual(["P01", "P05", "P10"]);
    // goodwill is proposed right after the same passenger's statutory payment
    const idx = (pax: string, type: string) => gw.proposed.findIndex((k) => k.includes(`.${pax}.`) && k.endsWith(type));
    for (const pax of ["P10", "P01", "P05"]) expect(idx(pax, ".GOODWILL")).toBe(gw.proposed.findIndex((k) => k.includes(`.${pax}.`) && !k.endsWith(".GOODWILL")) + 1);
    // order of the first statutory payments: P10 and P11 (denied boarding, 48 h) before everything else, then P13
    const stat = gw.proposed.filter((k) => !k.endsWith(".GOODWILL") && !k.endsWith("TICKET_REFUND")).map((k) => k.split(".")[1]);
    expect(stat.slice(0, 3)).toEqual(["P10", "P11", "P13"]);

    const report = (await world.db.runs.findOne({ _id: runId }))?.final_report;
    expect(report?.awaiting_budget.map((a) => a.effect_key.split(".")[1]).sort()).toEqual(["P06", "P07"]);
    expect(report?.paid).toHaveLength(9 + 1 + 3); // 9 statutory + ticket refund + 3 goodwill
    expect(report?.refused.map((r) => r.reason_code).sort()).toEqual(["ALREADY_COMPENSATED_OTHER_REGIME", "ALTERNATIVE_ACCEPTED_IN_WRITING", "DELAY_UNDER_3H", "NOTICE_OVER_14_DAYS"]);
    expect(report?.parked.map((p) => p.reason_code).sort()).toEqual(["BOOKING_UNRESOLVED", "CAUSE_UNDETERMINED", "CAUSE_UNDETERMINED", "PAYEE_CHANGE_REQUESTED"]);
    expect(report?.complete).toBe(true);
  });

  it("a payee-change claim grouped after its obligation already exists moves OWED to HELD and changes nothing else (E4-UNIT-02)", async () => {
    const { runId } = await seedRun(world.db, "S1", { claimIds: ["C07"] });
    await ingest({ db: world.db, runId, model: replayModel() });
    await adjudicate({ db: world.db, runId, policy: policyBundle() });
    const key = `${runId}:DX3F7Q.P08.NT101-20261110.APPR_DELAY`;
    const before = await world.db.obligations.findOne({ _id: key });
    expect(before).toMatchObject({ status: "OWED", amount_minor: 40000, reason_code: null });

    // C08 arrives later (copy it into this run)
    const src = await seedRun(world.db, "S1", { claimIds: ["C08"] });
    const c08 = await world.db.claims.findOne({ _id: `${src.runId}:C08` });
    await world.db.claims.insertOne({ ...c08!, _id: `${runId}:C08`, run_id: runId });
    await ingest({ db: world.db, runId, model: replayModel() });
    await adjudicate({ db: world.db, runId, policy: policyBundle() });

    const after = await world.db.obligations.findOne({ _id: key });
    expect(after).toMatchObject({ status: "HELD", reason_code: "PAYEE_CHANGE_REQUESTED", amount_minor: before!.amount_minor, payee_ref: before!.payee_ref, rule_citation: before!.rule_citation, policy_version: before!.policy_version });
    expect(after?.claim_ids.sort()).toEqual(["C07", "C08"]);
    expect(await world.db.audit.countDocuments({ run_id: runId, type: "OBLIGATION_HELD", effect_key: before!.effect_key })).toBe(1);
    // idempotent on a second pass
    await adjudicate({ db: world.db, runId, policy: policyBundle() });
    expect(await world.db.audit.countDocuments({ run_id: runId, type: "OBLIGATION_HELD" })).toBe(1);
    expect(await world.db.audit.countDocuments({ run_id: runId, type: "OBLIGATION_DECIDED", effect_key: before!.effect_key })).toBe(1);
  });
});

describe("--pause-before-payout and the go file", () => {
  it("goes RUNNING, PAUSED, RUNNING, ENDED and translates kill_at_passenger into NT_CRASH_AT before the first proposal (E4-UNIT-04, E4-UNIT-07)", async () => {
    const { runId, groupId } = await seedRun(world.db, "S0");
    const root = tmpRoot();
    mkdirSync(join(root, ".nt"));
    const gw = fakeGateway(world.db, runId);
    const seen: { status?: string; crash?: string | undefined } = {};
    gw.onPropose = async () => {
      if (seen.status === undefined) {
        seen.status = (await world.db.runs.findOne({ _id: runId }))?.status;
        seen.crash = process.env["NT_CRASH_AT"];
      }
    };
    const saved = process.env["NT_CRASH_AT"];
    try {
      const done = runArm({ runId, pauseBeforePayout: true }, depsFor(world, runId, root, gw, { goPollMs: 20 }));
      for (let i = 0; i < 200; i++) {
        if ((await world.db.runs.findOne({ _id: runId }))?.status === "PAUSED") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect((await world.db.runs.findOne({ _id: runId }))?.status).toBe("PAUSED");
      expect(gw.proposed).toEqual([]); // nothing is proposed while paused
      writeFileSync(join(root, ".nt", `go-${groupId}.json`), JSON.stringify({ kill_at_passenger: "P02" }));
      expect(await done).toBe(0);
      expect(seen.status).toBe("RUNNING");
      expect(seen.crash).toBe("BR_DISPATCH_RESPONSE_RECEIVED@ZT4H9X.P02.NT101-20261110.APPR_DELAY");
      expect((await world.db.runs.findOne({ _id: runId }))?.status).toBe("ENDED");
    } finally {
      if (saved === undefined) delete process.env["NT_CRASH_AT"];
      else process.env["NT_CRASH_AT"] = saved;
    }
  });

  it("a go file naming a passenger with no owed statutory obligation continues without a kill", async () => {
    const { runId, groupId } = await seedRun(world.db, "S0");
    const root = tmpRoot();
    mkdirSync(join(root, ".nt"));
    writeFileSync(join(root, ".nt", `go-${groupId}.json`), JSON.stringify({ kill_at_passenger: "P04" })); // P04 is a refusal; go file present before the pause
    const saved = process.env["NT_CRASH_AT"];
    delete process.env["NT_CRASH_AT"];
    try {
      expect(await runArm({ runId, pauseBeforePayout: true }, depsFor(world, runId, root, undefined, { goPollMs: 10 }))).toBe(0);
      expect(process.env["NT_CRASH_AT"]).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env["NT_CRASH_AT"] = saved;
    }
  });
});

describe("--report-only", () => {
  it("proposes and sends nothing and changes no document except execution_runs.final_report (E4-INT-04)", async () => {
    const { runId } = await seedRun(world.db, "S0");
    const root = tmpRoot();
    await runArm({ runId, pauseBeforePayout: false }, depsFor(world, runId, root));
    const snap = async () => ({
      claims: await world.db.claims.find({ run_id: runId }).sort({ _id: 1 }).toArray(),
      obligations: await world.db.obligations.find({ run_id: runId }).sort({ _id: 1 }).toArray(),
      intents: await world.db.intents.find({ run_id: runId }).sort({ _id: 1 }).toArray(),
      audit: await world.db.audit.find({ run_id: runId }).sort({ _id: 1 }).toArray(),
      grants: await world.db.grants.find({ run_id: runId }).toArray(),
      run: { ...(await world.db.runs.findOne({ _id: runId }))!, final_report: null },
    });
    const before = await snap();
    // the reconciler later settles an unknown outcome elsewhere; the report is regenerated from state
    const reportFile = join(root, "out", "reports", `${runId}.final-report.json`);
    const old = readFileSync(reportFile, "utf8");
    expect(await runReportOnly(world.db, runId, root)).toBe(0);
    expect(await snap()).toEqual(before);
    expect(existsSync(reportFile)).toBe(true);
    expect(JSON.parse(readFileSync(reportFile, "utf8")).paid).toEqual(JSON.parse(old).paid);
  });
});

describe("cli", () => {
  it("--report-only needs only the MongoDB variables; --arm must equal execution_runs.arm; a missing run is an error", async () => {
    const { main } = await import("../src/cli.ts");
    const { closeAll } = await import("@nt/db");
    const { runId } = await seedRun(world.db, "S0");
    const env = { NT_MONGODB_URI: world.rs.uri, NT_DB_NAME: world.rs.dbName };
    const outFile = join(process.cwd(), "out", "reports", `${runId}.final-report.json`);
    try {
      expect(await main(["--", "--run", runId, "--arm", "control", "--report-only"], env)).toBe(1);
      expect(existsSync(outFile)).toBe(false);
      expect(await main(["--run", "r0000000", "--report-only"], env)).toBe(1);
      expect(await main(["--run", runId, "--arm", "nt", "--report-only"], env)).toBe(0);
      const report = FinalReport.parse(JSON.parse(readFileSync(outFile, "utf8")));
      expect(report).toMatchObject({ run_id: runId, complete: false, scenario: "S0" }); // nothing was ingested: the claims are still RECEIVED
      expect((await world.db.runs.findOne({ _id: runId }))?.status).toBe("SEEDED");
    } finally {
      await closeAll();
      rmSync(outFile, { force: true });
    }
  });
});

describe("decision letters (CP-LETTER-1, NT_LETTERS_ENABLED)", () => {
  it("after the payouts, one DECISION_LETTER per decided claim is proposed (amount 0, notify_letter, keyless) and reported under letters only", async () => {
    const { runId } = await seedRun(world.db, "S0");
    const root = tmpRoot();
    const gw = fakeGateway(world.db, runId);
    expect(await runArm({ runId, pauseBeforePayout: false }, depsFor(world, runId, root, gw, { lettersEnabled: true }))).toBe(0);
    const payments = gw.proposed.filter((k) => !k.startsWith("LETTER."));
    const letters = gw.proposed.filter((k) => k.startsWith("LETTER."));
    expect(payments).toHaveLength(5);
    expect(gw.proposed.slice(0, 5)).toEqual(payments); // letters come after every payment
    const claims = await world.db.claims.find({ run_id: runId, status: "RESOLVED" }).toArray();
    expect(letters.sort()).toEqual(claims.map((c) => `LETTER.${c.claim_id}`).sort()); // S0: every claim has a statutory decision
    const its = await world.db.intents.find({ run_id: runId, entitlement_type: "DECISION_LETTER" }).toArray();
    expect(its).toHaveLength(letters.length);
    for (const it of its) {
      expect(it).toMatchObject({ amount_minor: 0, provider: "notify_letter", idempotency_key: null, draws_on: null });
      expect(it.frozen_request).toMatchObject({ operation: "NOTIFY", rail: null, amount_minor: 0, provider: "notify_letter" });
    }
    const report = FinalReport.parse(JSON.parse(readFileSync(join(root, "out", "reports", `${runId}.final-report.json`), "utf8")));
    expect(report.paid.map((p) => p.effect_key).some((k) => k.startsWith("LETTER."))).toBe(false);
    expect(report.paid).toHaveLength(5);
    expect(report.letters?.map((l) => l.effect_key).sort()).toEqual(letters.sort());
    expect(report.letters?.every((l) => l.state === "CONFIRMED")).toBe(true);
    // a restart sends no second letter: the obligation and intent _ids are the markers
    gw.proposed.length = 0;
    await world.db.runs.updateOne({ _id: runId }, { $set: { status: "RUNNING" } });
    expect(await runArm({ runId, pauseBeforePayout: false }, depsFor(world, runId, root, gw, { lettersEnabled: true }))).toBe(0);
    expect(gw.dispatched.filter((k) => k.startsWith("LETTER.")).length).toBe(letters.length);
  });
});
