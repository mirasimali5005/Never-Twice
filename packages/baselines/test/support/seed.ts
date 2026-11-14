// Test seeding: what `pnpm seed` (task H1) will do for a control run, reduced to the S0 fixtures. Reads fixtures/ only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaimIndex, OpsRecord, newGroupId, newRunId, type Booking, type Claim, type ExecutionRun } from "@nt/contracts";
import type { NtDb } from "@nt/db";
import { loadPolicyBundle } from "@nt/rules";
import { createModelClient } from "@nt/agents";
import { createProvider } from "@nt/providers";
import type { BaselineDeps } from "../../src/index.ts";
import { SIM_KEYS, type SimProcess } from "./sim-process.ts";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

export type Seeded = { runId: string; groupId: string; account: string };

export async function seedControlRun(db: NtDb, sim: SimProcess, o: { scenario?: "S0" | "S1"; faults?: object[]; poolMinor?: number; arm?: "control" | "documented" } = {}): Promise<Seeded> {
  const scenario = o.scenario ?? "S0";
  const runId = newRunId();
  const groupId = newGroupId();
  const account = `acct_${runId}`;
  const r = await sim.admin("POST", "/admin/accounts", { account });
  if (r.status !== 201) throw new Error(`account creation failed: ${r.status}`);
  if (o.faults && o.faults.length > 0) await sim.faults(account, o.faults);

  const dir = join(REPO_ROOT, "fixtures/scenarios", scenario);
  const ops = OpsRecord.parse(JSON.parse(readFileSync(join(dir, "ops-record.json"), "utf8")));
  const now = new Date();
  const run: ExecutionRun = {
    _id: runId,
    group_id: groupId,
    arm: o.arm ?? "control",
    scenario,
    seed: 1,
    fault_schedule: "test",
    sim_account: account,
    status: "SEEDED",
    started_at: null,
    ended_at: null,
    final_report: null,
  };
  await db.runs.insertOne(run);
  await db.bookings.insertMany(
    ops.bookings.map(
      (b): Booking => ({ ...b, _id: `${runId}:${b.booking_ref}:${b.passenger_id}`, run_id: runId, disruption: { ...b.disruption, scheduled_departure: new Date(b.disruption.scheduled_departure) } }) as Booking,
    ),
  );
  const index = ClaimIndex.parse(JSON.parse(readFileSync(join(dir, "claims/index.json"), "utf8")));
  await db.claims.insertMany(
    index.map(
      (c): Claim => ({
        _id: `${runId}:${c.claim_id}`,
        run_id: runId,
        claim_id: c.claim_id,
        channel: c.channel,
        received_at: new Date(c.received_at),
        raw_text: readFileSync(join(dir, "claims", c.file), "utf8"),
        status: "RECEIVED",
        hold_reason: null,
        extraction: null,
        extraction_meta: null,
        resolution: null,
        flags: { payeeChangeRequested: false, goodwillProposed: null },
        effect_keys: [],
        embedding: null,
        created_at: now,
        updated_at: now,
      }),
    ),
  );
  await db.grants.insertOne({ _id: `${runId}:GOODWILL`, run_id: runId, kind: "GOODWILL_POOL", grant_minor: o.poolMinor ?? ops.goodwill_pool.grant_minor, held_minor: 0, settled_minor: 0, frozen: false, currency: "CAD", policy_version: "NT-GOODWILL@1" });
  return { runId, groupId, account };
}

export function depsFor(db: NtDb, sim: SimProcess, runId: string, reportDir: string, extra: Partial<BaselineDeps> = {}): BaselineDeps {
  const cache = new Map<string, ReturnType<typeof createProvider>>();
  return {
    runId,
    db,
    model: createModelClient({ NT_MODEL_MODE: "replay", NT_MODEL_BACKEND: "cli", NT_MODEL_CASSETTE_DIR: join(REPO_ROOT, "fixtures/cassettes") }),
    policy: loadPolicyBundle(join(REPO_ROOT, "fixtures/policies")),
    providerFor: (id) => {
      let p = cache.get(id);
      if (!p) {
        p = createProvider(id, { NT_SIM_URL: sim.baseUrl, NT_SIM_WRITE_KEY: SIM_KEYS.write, NT_SIM_READ_KEY: SIM_KEYS.read, NT_RUN_ID: runId });
        cache.set(id, p);
      }
      return p;
    },
    stripeEnabled: false,
    dispatchTimeoutMs: 400,
    reportDir,
    barrier: () => {}, // the real barrier reads NT_CRASH_AT; in-process tests never set it
    ...extra,
  };
}

export type SimObject = { id: string; kind: string; status: string; amount_minor: number; payee_ref: string; metadata: Record<string, string> };

/** Every object in the account's ledger, through the simulator's list endpoint with the read key. */
export async function listPayments(sim: SimProcess, account: string): Promise<SimObject[]> {
  const out: SimObject[] = [];
  let after: string | null = null;
  for (;;) {
    const url = `${sim.baseUrl}/v1/payouts?account=${account}&limit=100${after ? `&starting_after=${after}` : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${SIM_KEYS.read}` } });
    const j = (await r.json()) as { data: SimObject[]; has_more: boolean };
    out.push(...j.data);
    if (!j.has_more || j.data.length === 0) return out;
    after = j.data[j.data.length - 1]!.id;
  }
}

export const byKey = (objs: SimObject[], effectKey: string): SimObject[] => objs.filter((o) => o.metadata["nt_effect_key"] === effectKey);
export const K = {
  P02: "ZT4H9X.P02.NT101-20261110.APPR_DELAY",
  P13: "KS2R9B.P13.NT880-20261110.APPR_DELAY",
  P11: "PC1D6V.P11.NT212-20261110.APPR_DENIED_BOARDING",
  P03: "LM2P8D.P03.NT101-20261110.APPR_REFUND_COMP",
  P03R: "LM2P8D.P03.NT101-20261110.TICKET_REFUND",
} as const;
