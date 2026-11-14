// Records real model outputs for claim intake: runs extractClaim in NT_MODEL_MODE=record for every claim of scenario S1 (which
// includes all S0 claims) with the cli backend, writing cassettes under fixtures/cassettes/. Run it by hand, at most twice:
//   node --env-file-if-exists=.env scripts/record-intake.ts
// It prints one line per claim with its latency and never prints environment values.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaimIndex } from "../packages/contracts/src/index.ts";
import { createModelClient, extractClaim } from "../packages/agents/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scenario = process.env.NT_RECORD_SCENARIO ?? "S1";
const concurrency = Number(process.env.NT_RECORD_CONCURRENCY ?? "3");

const client = createModelClient(
  { NT_MODEL: process.env.NT_MODEL, NT_MODEL_MODE: "record", NT_MODEL_BACKEND: process.env.NT_MODEL_BACKEND ?? "cli", NT_MODEL_CASSETTE_DIR: join(root, "fixtures/cassettes") },
  { timeoutMs: 60_000 },
);
if (client.mode !== "record") throw new Error("record script must run in record mode");

const dir = join(root, "fixtures/scenarios", scenario, "claims");
const index = ClaimIndex.parse(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
console.log(`recording ${index.length} claims of ${scenario}: model=${client.model} backend=${client.backend} concurrency=${concurrency}`);

type Row = { claim_id: string; ms: number; outcome: string };
const rows: Row[] = [];
let next = 0;
async function worker(): Promise<void> {
  for (;;) {
    const c = index[next++];
    if (!c) return;
    const text = readFileSync(join(dir, c.file), "utf8");
    const t0 = Date.now();
    const r = await extractClaim(client, { claim_id: c.claim_id, channel: c.channel, text });
    const ms = Date.now() - t0;
    const outcome = r.kind === "EXTRACTED" ? `ok attempts=${r.attempts} discarded_quotes=${r.discarded_quotes.length}` : `HELD ${r.reason_code}: ${r.cause}`;
    rows.push({ claim_id: c.claim_id, ms, outcome });
    console.log(`${c.claim_id} ${(ms / 1000).toFixed(1)}s ${outcome}`);
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const total = Date.now() - t0;
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`done: ${rows.length} claims in ${(total / 1000).toFixed(1)}s wall; per-call min ${(ms[0]! / 1000).toFixed(1)}s median ${(ms[Math.floor(ms.length / 2)]! / 1000).toFixed(1)}s max ${(ms[ms.length - 1]! / 1000).toFixed(1)}s`);
if (rows.some((r) => r.outcome.startsWith("HELD"))) process.exitCode = 1;
