// `pnpm db:init [-- --vector [--dims=N]]`. Uses the owner connection NT_MONGODB_URI and NT_DB_NAME (default
// never_twice), HANDOVER.md §5.2. Prints what was created and then lists the collections and indexes that exist.
// The connection string is never printed.
import { closeAll, connect, dbNameFrom } from "./client.ts";
import { initDatabase, initVectorIndexes } from "./init.ts";

// db:init reads only NT_MONGODB_URI and NT_DB_NAME. It does not call loadEnv("script") from @nt/contracts because that
// schema also requires simulator and timing variables db:init has no use for; the URI is validated by the driver.
const env = process.env;
const args = process.argv.slice(2).filter((a) => a !== "--");
const vector = args.includes("--vector");
const dimsArg = args.find((a) => a.startsWith("--dims="));
const numDimensions = dimsArg ? Number(dimsArg.slice("--dims=".length)) : Number(env.NT_EMBED_DIMS ?? 1024);

async function main(): Promise<void> {
  const t0 = Date.now();
  const ntdb = await connect("default", env);
  console.log(`db:init: connected (role default) in ${Date.now() - t0} ms; database ${dbNameFrom(env)}`);
  const report = await initDatabase(ntdb.db);
  for (const c of report.collections) console.log(`collection  ${c.action.padEnd(8)} ${c.name}`);
  for (const v of report.validators) console.log(`validator   ${v.action.padEnd(9)} ${v.name}`);
  const stale = report.validators.filter((v) => v.action === "unauthorized").map((v) => v.name);
  if (stale.length > 0) {
    process.exitCode = 1;
    console.error(
      `db:init: the validator of ${stale.join(", ")} differs from the specification and this user may not run collMod. ` +
        "If the collection is empty, drop that collection (never the database) and run db:init again.",
    );
  }
  for (const i of report.indexes) console.log(`index       ${i.action.padEnd(8)} ${i.collection}.${i.name}`);

  if (vector) {
    if (!Number.isInteger(numDimensions) || numDimensions <= 0) throw new Error(`--dims must be a positive integer, got ${dimsArg}`);
    for (const v of await initVectorIndexes(ntdb.db, { numDimensions })) {
      console.log(`vector      ${v.action.padEnd(8)} ${v.collection}.${v.name}${v.error ? ` (${v.error})` : ""}`);
    }
  } else {
    console.log("vector      skipped (Tier 2; pass --vector)");
  }

  console.log("\nnow present:");
  const names = (await ntdb.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  for (const name of names) {
    const ix = await ntdb.db.collection(name).listIndexes().toArray();
    console.log(`  ${name}: ${ix.map((i) => i.name).join(", ")}`);
  }
}

main()
  .then(() => closeAll())
  .catch(async (e) => {
    console.error(`db:init failed: ${(e as Error).message}`);
    await closeAll();
    process.exitCode = 1;
  });
