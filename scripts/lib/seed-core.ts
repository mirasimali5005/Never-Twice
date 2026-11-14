// The seed: one group, one run per arm, simulator accounts with the fault schedule, and the seeded documents.
// Reads fixtures/ only (never evaluator/hidden/); the manifest is committed by the evaluator as a child process BEFORE anything else.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ARMS,
  Booking,
  Claim,
  ClaimIndex,
  FaultSchedule,
  GROUP_ID_RE,
  OpsRecord,
  SCENARIOS,
  type FaultSchedule as FaultScheduleT,
} from "../../packages/contracts/src/index.ts";
import type { NtDb } from "../../packages/db/src/index.ts";
import { EVALUATOR_CLI, FIXTURES_DIR, ROOT, STRIPE_SEED_SCRIPT } from "./paths.ts";
import { newGroupId, newRunId, simAccountOf } from "./ids.ts";
import type { SimAdmin } from "./sim-admin.ts";
import { recordSeeded, type CurrentGroup } from "./state.ts";

const execFileP = promisify(execFile);

export type ManifestCommit = { sha256: string; manifestPath: string | null; commitmentPath: string | null };
export type TicketPaymentRequest = { run_id: string; booking_ref: string; passenger_id: string; amount_minor: number };

export type SeedDeps = {
  db: NtDb;
  sim: SimAdmin;
  ntDir: string;
  log?: (line: string) => void;
  /** Commits the manifest; default runs `node evaluator/src/cli.ts manifest` (optionally into `evaluatorOutDir`). */
  commitManifest?: (scenario: string, group: string) => Promise<ManifestCommit>;
  evaluatorOutDir?: string;
  /** Creates P03's Stripe test ticket purchase and returns its pi_ id; null = Stripe disabled or unavailable. */
  ticketPayment?: ((req: TicketPaymentRequest) => Promise<string>) | null;
  fixturesDir?: string;
  now?: () => Date;
};

export type SeedOptions = { scenario: string; arms: string[]; faults: string; seed?: number; groupId?: string };

export type SeedResult = {
  group_id: string;
  scenario: string;
  faults: string;
  runs: { arm: string; run_id: string; sim_account: string }[];
  manifest_sha256: string;
  counts: { claims: number; bookings: number; grant_minor: number; ticket_payments: number };
};

export function parseArms(spec: string): string[] {
  const arms = spec.split(",").map((s) => s.trim()).filter(Boolean);
  if (arms.length === 0) throw new Error("--arms is empty");
  for (const a of arms) if (!(ARMS as readonly string[]).includes(a)) throw new Error(`unknown arm ${JSON.stringify(a)} (known: ${ARMS.join(", ")})`);
  if (new Set(arms).size !== arms.length) throw new Error("--arms lists an arm twice");
  return arms;
}

/** Default manifest commitment: the evaluator CLI as a child process. Prints nothing itself; returns the hash it printed. */
export function evaluatorManifest(outDir?: string): (scenario: string, group: string) => Promise<ManifestCommit> {
  return async (scenario, group) => {
    const args = [EVALUATOR_CLI, "manifest", "--scenario", scenario, "--group", group];
    if (outDir) args.push("--out-dir", outDir);
    let stdout: string;
    try {
      ({ stdout } = await execFileP(process.execPath, args, { cwd: ROOT }));
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new Error(`evaluator manifest failed: ${(err.stderr || err.message).trim().slice(0, 400)}`);
    }
    const m = /^manifest sha256 ([0-9a-f]{64})/m.exec(stdout);
    if (!m) throw new Error(`evaluator manifest printed no hash: ${stdout.slice(0, 200)}`);
    const wrote = [...stdout.matchAll(/^wrote (.+)$/gm)].map((x) => x[1]!);
    return { sha256: m[1]!, manifestPath: wrote[0] ?? null, commitmentPath: wrote[1] ?? null };
  };
}

/** Ticket purchase via task C3's script (`scripts/stripe/seed-ticket-payment.ts`); null when the script is absent. */
export function stripeTicketPayment(): ((req: TicketPaymentRequest) => Promise<string>) | null {
  if (!existsSync(STRIPE_SEED_SCRIPT)) return null;
  return async (req) => {
    try {
      const { stdout } = await execFileP(
        process.execPath,
        [STRIPE_SEED_SCRIPT, "--run-id", req.run_id, "--booking-ref", req.booking_ref, "--passenger-id", req.passenger_id, "--amount-minor", String(req.amount_minor)],
        { cwd: ROOT, env: process.env },
      );
      const id = stdout.trim().split(/\s+/).pop() ?? "";
      if (!/^pi_[A-Za-z0-9]+$/.test(id)) throw new Error(`unexpected output ${JSON.stringify(id.slice(0, 40))}`);
      return id;
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new Error(`Stripe ticket seed failed for run ${req.run_id}: ${(err.stderr || err.message).trim().slice(0, 300)}`);
    }
  };
}

function readJson(path: string): unknown {
  if (!existsSync(path)) throw new Error(`fixture not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function seedGroup(opts: SeedOptions, deps: SeedDeps): Promise<SeedResult> {
  const log = deps.log ?? (() => {});
  const fx = deps.fixturesDir ?? FIXTURES_DIR;
  const now = deps.now ?? (() => new Date());
  if (!(SCENARIOS as readonly string[]).includes(opts.scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(", ")}`);
  const arms = opts.arms;

  // Fixtures first: a bad fixture fails before any side effect.
  const ops = OpsRecord.parse(readJson(join(fx, "scenarios", opts.scenario, "ops-record.json")));
  const claimDir = join(fx, "scenarios", opts.scenario, "claims");
  const claimIndex = ClaimIndex.parse(readJson(join(claimDir, "index.json")));
  const schedule: FaultScheduleT = FaultSchedule.parse(readJson(join(fx, "faults", `${opts.faults}.json`)));
  const policies = ops.policy_ids.map((id) => readJson(join(fx, "policies", `${id}.json`)) as { _id: string });
  const claimTexts = claimIndex.map((c) => ({ c, text: readFileSync(join(claimDir, c.file), "utf8") }));

  if (!(await deps.sim.healthy())) throw new Error(`provider simulator not reachable at ${deps.sim.baseUrl}; start it with \`pnpm sim\``);

  const groupId = opts.groupId ?? newGroupId();
  if (!GROUP_ID_RE.test(groupId)) throw new Error(`bad group id ${groupId}`);
  const runs = arms.map((arm) => {
    const run_id = newRunId();
    return { arm, run_id, sim_account: simAccountOf(run_id) };
  });
  const runIds = runs.map((r) => r.run_id);

  // 1. Manifest commitment, before anything else (HANDOVER §14).
  const commit = await (deps.commitManifest ?? evaluatorManifest(deps.evaluatorOutDir))(opts.scenario, groupId);
  log(`manifest sha256 ${commit.sha256} (committed before the run)`);

  // 2. Simulator accounts and the fault schedule on EVERY account of the group.
  for (const r of runs) {
    await deps.sim.createAccount(r.sim_account);
    await deps.sim.installFaults(r.sim_account, schedule.faults);
  }
  log(`simulator: ${runs.length} accounts, fault schedule ${schedule.id} (${schedule.faults.length} faults) on each`);

  // 3. Stripe ticket purchase: one PaymentIntent per run, for bookings whose passenger elected a refund.
  const ticketBookings = ops.bookings.filter((b) => b.ticket_price_minor !== null && b.passenger.refund_elected);
  const ticketRefs = new Map<string, string>(); // `${run_id}:${booking_ref}:${passenger_id}` -> pi_
  if (ticketBookings.length > 0 && deps.ticketPayment) {
    for (const r of runs) {
      for (const b of ticketBookings) {
        const pi = await deps.ticketPayment({ run_id: r.run_id, booking_ref: b.booking_ref, passenger_id: b.passenger_id, amount_minor: b.ticket_price_minor! });
        ticketRefs.set(`${r.run_id}:${b.booking_ref}:${b.passenger_id}`, pi);
      }
    }
    log(`stripe (test mode): ${ticketRefs.size} ticket purchase(s) created`);
  } else if (ticketBookings.length > 0) {
    log("stripe: ticket purchase skipped (NT_STRIPE_ENABLED=false or scripts/stripe/seed-ticket-payment.ts absent): ticket_payment_ref stays null");
  }

  // 4. Documents. Validated against the contract schemas before writing.
  const at = now();
  const bookingDocs = runs.flatMap((r) =>
    ops.bookings.map((b) =>
      Booking.parse({
        ...b,
        _id: `${r.run_id}:${b.booking_ref}:${b.passenger_id}`,
        run_id: r.run_id,
        ticket_payment_ref: ticketRefs.get(`${r.run_id}:${b.booking_ref}:${b.passenger_id}`) ?? b.ticket_payment_ref,
        disruption: { ...b.disruption, scheduled_departure: new Date(b.disruption.scheduled_departure) },
      }),
    ),
  );
  const claimDocs = runs.flatMap((r) =>
    claimTexts.map(({ c, text }) =>
      Claim.parse({
        _id: `${r.run_id}:${c.claim_id}`,
        run_id: r.run_id,
        claim_id: c.claim_id,
        channel: c.channel,
        received_at: new Date(c.received_at),
        raw_text: text,
        status: "RECEIVED",
        hold_reason: null,
        extraction: null,
        extraction_meta: null,
        resolution: null,
        flags: { payeeChangeRequested: false, goodwillProposed: null },
        effect_keys: [],
        embedding: null,
        created_at: at,
        updated_at: at,
      }),
    ),
  );
  const grantDocs = runs.map((r) => ({
    _id: `${r.run_id}:GOODWILL`,
    run_id: r.run_id,
    kind: "GOODWILL_POOL" as const,
    grant_minor: ops.goodwill_pool.grant_minor,
    held_minor: 0,
    settled_minor: 0,
    frozen: false,
    currency: "CAD" as const,
    policy_version: ops.goodwill_pool.policy_version,
  }));
  const runDocs = runs.map((r) => ({
    _id: r.run_id,
    group_id: groupId,
    arm: r.arm as (typeof ARMS)[number],
    scenario: opts.scenario as (typeof SCENARIOS)[number],
    seed: opts.seed ?? 1,
    fault_schedule: schedule.id,
    sim_account: r.sim_account,
    status: "SEEDED" as const,
    started_at: null,
    ended_at: null,
    final_report: null,
  }));

  try {
    for (const p of policies) await deps.db.policies.updateOne({ _id: p._id }, { $setOnInsert: p }, { upsert: true }); // immutable once present
    await deps.db.bookings.insertMany(bookingDocs);
    await deps.db.claims.insertMany(claimDocs);
    await deps.db.grants.insertMany(grantDocs);
    await deps.db.runs.insertMany(runDocs); // last: a SEEDED run implies a complete seed
  } catch (e) {
    await Promise.allSettled([
      deps.db.bookings.deleteMany({ run_id: { $in: runIds } }),
      deps.db.claims.deleteMany({ run_id: { $in: runIds } }),
      deps.db.grants.deleteMany({ run_id: { $in: runIds } }),
      deps.db.runs.deleteMany({ _id: { $in: runIds } }),
    ]);
    throw e;
  }

  const cur: CurrentGroup = {
    group_id: groupId,
    scenario: opts.scenario,
    faults: schedule.id,
    runs: Object.fromEntries(runs.map((r) => [r.arm, r.run_id])),
    manifest_sha256: commit.sha256,
    seeded_at: at.toISOString(),
  };
  recordSeeded(deps.ntDir, cur);

  return {
    group_id: groupId,
    scenario: opts.scenario,
    faults: schedule.id,
    runs,
    manifest_sha256: commit.sha256,
    counts: { claims: claimIndex.length, bookings: ops.bookings.length, grant_minor: ops.goodwill_pool.grant_minor, ticket_payments: ticketRefs.size },
  };
}
