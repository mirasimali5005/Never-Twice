// pnpm seed -- --scenario S0 --arms nt,control,nt_mutant [--faults F-DEMO|F-NONE|...] [--seed N]
// Creates a group: one run per arm, simulator accounts with the fault schedule, documents; commits the manifest first.
import { pathToFileURL } from "node:url";
import { parseArgs, runMain, UsageError } from "./lib/args.ts";
import { dbLabel, openOwnerDb, openSimAdmin } from "./lib/env.ts";
import { NT_DIR } from "./lib/paths.ts";
import { parseArms, seedGroup, stripeTicketPayment, evaluatorManifest, type SeedResult } from "./lib/seed-core.ts";

export function printSeed(r: SeedResult): void {
  console.log(`group_id  ${r.group_id}   scenario ${r.scenario}   faults ${r.faults}`);
  for (const x of r.runs) console.log(`run_id    ${x.run_id}   arm ${x.arm.padEnd(10)} account ${x.sim_account}`);
  console.log(`seeded    ${r.counts.claims} claims, ${r.counts.bookings} booking passengers per run, goodwill grant ${r.counts.grant_minor} minor, ${r.counts.ticket_payments} Stripe ticket payment(s)`);
  console.log(`manifest sha256 ${r.manifest_sha256} (committed before the run)`);
  console.log("READY");
}

export async function seedFromEnv(opts: { scenario: string; arms: string[]; faults: string; seed?: number }): Promise<SeedResult> {
  const stripeOn = (process.env.NT_STRIPE_ENABLED ?? "true") !== "false";
  const ticketPayment = stripeOn ? stripeTicketPayment() : null;
  if (stripeOn && !ticketPayment) console.error("warning: NT_STRIPE_ENABLED is true but scripts/stripe/seed-ticket-payment.ts is absent (task C3 not merged): ticket_payment_ref stays null");
  const db = await openOwnerDb();
  try {
    return await seedGroup(opts, { db, sim: openSimAdmin(), ntDir: NT_DIR, ticketPayment, commitManifest: evaluatorManifest(), log: (l) => console.error(l) });
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runMain(async () => {
    const a = parseArgs(process.argv.slice(2), ["scenario", "arms", "faults", "seed"]);
    const scenario = a.values.get("scenario");
    if (!scenario) throw new UsageError("usage: pnpm seed -- --scenario S0|S1 --arms nt,control,nt_mutant [--faults F-DEMO]");
    const arms = parseArms(a.values.get("arms") ?? "nt,control,nt_mutant");
    const seed = a.values.has("seed") ? Number(a.values.get("seed")) : undefined;
    console.error(`database: ${dbLabel()}`);
    printSeed(await seedFromEnv({ scenario, arms, faults: a.values.get("faults") ?? "F-DEMO", ...(seed === undefined ? {} : { seed }) }));
  });
}
