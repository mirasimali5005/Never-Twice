// H1-INT-01/03 and the S0 seed: in-memory replica set, simulator on an ephemeral port, manifest commitment in a temp directory.
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openNtDb, type NtDb } from "../../packages/db/src/index.ts";
import { startTestReplSet, type TestReplSet } from "../../packages/db/src/testing.ts";
import { startServer, type RunningSim } from "../../apps/provider-sim/src/server.ts";
import { SimAdmin } from "../lib/sim-admin.ts";
import { evaluatorManifest, parseArms, seedGroup, type SeedResult } from "../lib/seed-core.ts";
import { resetPrevious } from "../lib/reset-core.ts";
import { readCurrent, readHistory } from "../lib/state.ts";
import { GROUP_ID_RE, RUN_ID_RE } from "../lib/ids.ts";

const KEYS = { write: "w-test", read: "r-test", evalRead: "e-test", admin: "a-test" };
let repl: TestReplSet;
let db: NtDb;
let sim: RunningSim;
let admin: SimAdmin;
let tmp: string;
let ntDir: string;
let evalOut: string;

const COLLECTIONS_BY_RUN = ["bookings", "claims", "grants", "obligations", "intents", "audit", "investigations"] as const;

beforeAll(async () => {
  repl = await startTestReplSet();
  db = await openNtDb({ uri: repl.uri, dbName: repl.dbName });
  tmp = mkdtempSync(join(tmpdir(), "nt-h1-"));
  sim = await startServer({ port: 0, dataDir: join(tmp, "sim"), keys: KEYS });
  admin = new SimAdmin(`http://127.0.0.1:${sim.port}`, KEYS.admin);
  ntDir = join(tmp, ".nt");
  evalOut = join(tmp, "eval-out");
});
afterAll(async () => {
  await db?.close();
  await sim?.close();
  await repl?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const deps = () => ({ db, sim: admin, ntDir, commitManifest: evaluatorManifest(evalOut) });
const countFor = async (runIds: string[]) => {
  const n: Record<string, number> = {};
  for (const k of COLLECTIONS_BY_RUN) n[k] = await db[k].countDocuments({ run_id: { $in: runIds } });
  n.runs = await db.runs.countDocuments({ _id: { $in: runIds } });
  return n;
};

describe("seed S0", () => {
  let r: SeedResult;
  beforeAll(async () => {
    r = await seedGroup({ scenario: "S0", arms: parseArms("nt,control,nt_mutant"), faults: "F-DEMO" }, deps());
  });

  it("creates one group, three runs with valid ids, sharing the group", async () => {
    expect(r.group_id).toMatch(GROUP_ID_RE);
    expect(r.runs.map((x) => x.arm)).toEqual(["nt", "control", "nt_mutant"]);
    for (const x of r.runs) {
      expect(x.run_id).toMatch(RUN_ID_RE);
      expect(x.sim_account).toBe(`acct_${x.run_id}`);
    }
    const runs = await db.runs.find({ group_id: r.group_id }).toArray();
    expect(runs).toHaveLength(3);
    expect(runs.every((x) => x.status === "SEEDED" && x.fault_schedule === "F-DEMO" && x.final_report === null)).toBe(true);
  });

  it("seeds 5 claims (RECEIVED, raw text) and 5 booking passengers per run, grant 0", async () => {
    for (const x of r.runs) {
      const claims = await db.claims.find({ run_id: x.run_id }).toArray();
      expect(claims.map((c) => c.claim_id).sort()).toEqual(["C02", "C04", "C05", "C11", "C13"]);
      expect(claims.every((c) => c.status === "RECEIVED" && c.raw_text.length > 20 && c.extraction === null && c._id === `${x.run_id}:${c.claim_id}`)).toBe(true);
      const bookings = await db.bookings.find({ run_id: x.run_id }).toArray();
      expect(bookings.map((b) => b.passenger_id).sort()).toEqual(["P02", "P03", "P04", "P11", "P13"]);
      expect(bookings.every((b) => b._id === `${x.run_id}:${b.booking_ref}:${b.passenger_id}`)).toBe(true);
      const grant = await db.grants.findOne({ _id: `${x.run_id}:GOODWILL` });
      expect(grant).toMatchObject({ grant_minor: 0, held_minor: 0, settled_minor: 0, frozen: false });
    }
    expect(await db.policies.countDocuments({})).toBe(2);
  });

  it("never loads a claim-to-passenger mapping into a claim", async () => {
    const c = await db.claims.findOne({ run_id: r.runs[0]!.run_id, claim_id: "C02" });
    expect(c!.resolution).toBeNull();
    expect(c!.effect_keys).toEqual([]);
  });

  it("H1-INT-03: F-DEMO is installed on every simulator account of the group", () => {
    for (const x of r.runs) {
      const acct = sim.store.get(x.sim_account);
      expect(acct, x.sim_account).toBeDefined();
      expect(acct!.faults.map((f) => `${f.match.payee_ref}:${f.fault}`).sort()).toEqual(["payee_P11:LATE_COMMIT_ON_RELEASE", "payee_P13:DROP_REQUEST"]);
    }
  });

  it("commits the manifest before the run: hash printed, manifest and commitment files exist and agree", () => {
    expect(r.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    const commitment = JSON.parse(readFileSync(join(evalOut, `${r.group_id}.commitment.json`), "utf8"));
    expect(commitment).toMatchObject({ group_id: r.group_id, sha256: r.manifest_sha256 });
    expect(existsSync(join(evalOut, `${r.group_id}.manifest.json`))).toBe(true);
  });

  it("records the group in .nt/current.json and the history", () => {
    expect(readCurrent(ntDir)).toMatchObject({ group_id: r.group_id, scenario: "S0", manifest_sha256: r.manifest_sha256 });
    expect(readHistory(ntDir).map((h) => h.group_id)).toContain(r.group_id);
  });

  it("leaves ticket_payment_ref null without a Stripe seed", async () => {
    const p03 = await db.bookings.findOne({ run_id: r.runs[0]!.run_id, passenger_id: "P03" });
    expect(p03).toMatchObject({ ticket_price_minor: 41260, ticket_payment_ref: null });
  });

  it("H1-INT-01: reset leaves no document for the previous group's run ids", async () => {
    const before = await countFor(r.runs.map((x) => x.run_id));
    expect(before.bookings).toBe(15);
    expect(before.claims).toBe(15);
    mkdirSync(ntDir, { recursive: true });
    writeFileSync(join(ntDir, `go-${r.group_id}.json`), "{}");
    const res = await resetPrevious({ db, sim: admin, ntDir });
    expect(res.groups).toContain(r.group_id);
    expect(res.go_files_removed).toEqual([`go-${r.group_id}.json`]);
    expect(res.sim_errors).toEqual([]);
    const after = await countFor(r.runs.map((x) => x.run_id));
    expect(Object.values(after).every((n) => n === 0)).toBe(true);
    expect(await db.runs.countDocuments({ group_id: r.group_id })).toBe(0);
    expect(readCurrent(ntDir)).toBeNull();
    expect(await db.policies.countDocuments({})).toBe(2); // shared, immutable: kept
  });
});

describe("seed with a Stripe stub and F-NONE", () => {
  it("stores one ticket_payment_ref per run on P03's booking and installs no faults", async () => {
    const calls: string[] = [];
    const r = await seedGroup(
      { scenario: "S0", arms: ["nt", "control"], faults: "F-NONE" },
      { ...deps(), ticketPayment: async (req) => (calls.push(req.run_id), `pi_stub_${req.run_id}`) },
    );
    expect(calls.sort()).toEqual(r.runs.map((x) => x.run_id).sort());
    for (const x of r.runs) {
      const p03 = await db.bookings.findOne({ run_id: x.run_id, passenger_id: "P03" });
      expect(p03!.ticket_payment_ref).toBe(`pi_stub_${x.run_id}`);
      expect(sim.store.get(x.sim_account)!.faults).toHaveLength(0);
    }
    expect(await db.runs.countDocuments({ group_id: r.group_id })).toBe(2);
  });

  it("rejects an unknown arm and an unknown scenario without side effects", async () => {
    expect(() => parseArms("nt,bogus")).toThrow(/unknown arm/);
    const before = await db.runs.countDocuments({});
    await expect(seedGroup({ scenario: "S9", arms: ["nt"], faults: "F-NONE" }, deps())).rejects.toThrow(/scenario/);
    expect(await db.runs.countDocuments({})).toBe(before);
  });
});
