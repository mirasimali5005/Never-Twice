// pnpm probe:admit -- --tool notify.send [--tool-file fixtures/tool-descriptions/<file>.json] [--runs 10] [--concurrency 3] [--scratch-sim] [--record-first] [--out out/sweeps/probes.md] [--save]
//
// Tier 3 generated probes (HANDOVER.md §11.4, §13). For each run: the probe author (one ModelClient.parse, backend and mode from
// NT_MODEL_BACKEND / NT_MODEL_MODE) writes a ProbeSpec from fixtures/tool-descriptions/<tool>.json; fixed code admits or rejects it
// (static checks, then four canaries in scratch simulator accounts); a rejected spec is retried once with the failure as feedback.
// Prints, and with --out writes, the admission rate: runs admitted over runs, and attempts admitted over attempts, with every
// rejection's reason. Nothing here can send a payment or a message: the probe runs with the READ key only.
//
// Keys: the ADMIN key is held for canary setup only (scratch accounts, planted ground truth, state hash); it is never given to the
// probe. By default the simulator at NT_SIM_URL is used with NT_SIM_READ_KEY / NT_SIM_ADMIN_KEY. --scratch-sim instead starts a private
// simulator from this checkout on an ephemeral port with throwaway keys and a temporary data directory (nothing shared is touched).
// --record-first runs the first run in NT_MODEL_MODE=record so its model outputs are stored as cassettes under fixtures/cassettes/.
// --save writes an admitted probe to the MongoDB `probes` collection as {tool_id}:{schema_hash} (NT_MONGODB_URI).
// Environment values are never printed.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createModelClient } from "../../packages/agents/src/index.ts";
import { ToolDescription, authorAndAdmit, saveAdmittedProbe, toolSchemaHash } from "../../packages/recovery/src/probes/index.ts";
import type { AuthorAndAdmitResult, CanaryHarness, ProbeCollection } from "../../packages/recovery/src/probes/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Args = { tool: string; toolFile: string | null; runs: number; concurrency: number; scratchSim: boolean; recordFirst: boolean; out: string | null; save: boolean };

function parseArgs(argv: string[]): Args {
  const a: Args = { tool: "", toolFile: null, runs: 1, concurrency: 1, scratchSim: false, recordFirst: false, out: null, save: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === "--") continue;
    else if (k === "--tool") a.tool = val();
    else if (k === "--tool-file") a.toolFile = val();
    else if (k === "--runs") a.runs = Number(val());
    else if (k === "--concurrency") a.concurrency = Number(val());
    else if (k === "--scratch-sim") a.scratchSim = true;
    else if (k === "--record-first") a.recordFirst = true;
    else if (k === "--out") a.out = val();
    else if (k === "--save") a.save = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!/^[a-z0-9_.-]+$/i.test(a.tool)) throw new Error("--tool <tool_id> is required (e.g. notify.send)");
  if (!Number.isInteger(a.runs) || a.runs < 1 || a.runs > 50) throw new Error("--runs must be 1 to 50");
  if (!Number.isInteger(a.concurrency) || a.concurrency < 1 || a.concurrency > 5) throw new Error("--concurrency must be 1 to 5");
  return a;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

type Sim = { baseUrl: string; readKey: string; adminKey: string; stop(): Promise<void> };

async function scratchSim(): Promise<Sim> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nt-probe-admit-"));
  const k = () => randomBytes(16).toString("hex");
  const keys = { write: k(), read: k(), evalRead: k(), admin: k() };
  const child: ChildProcess = spawn(process.execPath, [path.join(ROOT, "apps/provider-sim/src/server.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      NT_SIM_PORT: String(port),
      NT_SIM_DATA_DIR: dir,
      NT_SIM_WRITE_KEY: keys.write, // the scratch simulator needs all four to start; this script never uses the write key
      NT_SIM_READ_KEY: keys.read,
      NT_SIM_EVAL_READ_KEY: keys.evalRead,
      NT_SIM_ADMIN_KEY: keys.admin,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) })).ok) break;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error("scratch simulator did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    baseUrl,
    readKey: keys.read,
    adminKey: keys.admin,
    stop: () =>
      new Promise<void>((res) => {
        child.once("exit", () => {
          fs.rmSync(dir, { recursive: true, force: true });
          res();
        });
        child.kill("SIGTERM");
      }),
  };
}

function configuredSim(): Sim {
  const baseUrl = process.env.NT_SIM_URL || "http://127.0.0.1:4010";
  const readKey = process.env.NT_SIM_READ_KEY;
  const adminKey = process.env.NT_SIM_ADMIN_KEY;
  if (!readKey || !adminKey) throw new Error("NT_SIM_READ_KEY and NT_SIM_ADMIN_KEY must be set (or pass --scratch-sim)");
  return { baseUrl, readKey, adminKey, stop: async () => {} };
}

function oneLine(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 400);
}

function specSummary(r: AuthorAndAdmitResult["attempts"][number]): string {
  if (!r.spec) return "(no spec)";
  const s = r.spec;
  const q = Object.entries(s.request.query).map(([k, v]) => `${k}=${v}`).join("&");
  return oneLine(`${s.request.method} ${s.request.path}?${q}; items ${s.items_path}; marker ${s.marker_path}; pages ${s.pagination ? `${s.pagination.cursor_param}<-${s.pagination.next_path} x${s.pagination.max_pages}` : "none"}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const toolFile = args.toolFile ? path.resolve(ROOT, args.toolFile) : path.join(ROOT, "fixtures/tool-descriptions", `${args.tool}.json`);
  const tool = ToolDescription.parse(JSON.parse(fs.readFileSync(toolFile, "utf8")));
  if (tool.tool_id !== args.tool) throw new Error(`${path.relative(ROOT, toolFile)} describes ${tool.tool_id}, not ${args.tool}`);
  const sim = args.scratchSim ? await scratchSim() : configuredSim();
  const harness: CanaryHarness = { baseUrl: sim.baseUrl, readKey: sim.readKey, adminKey: sim.adminKey, timeoutMs: 10_000 };
  const policy = { tool, allowedOrigins: [new URL(sim.baseUrl).origin] };
  const modelEnv = {
    NT_MODEL: process.env.NT_MODEL,
    NT_MODEL_BACKEND: process.env.NT_MODEL_BACKEND ?? "cli",
    NT_MODEL_CASSETTE_DIR: process.env.NT_MODEL_CASSETTE_DIR || path.join(ROOT, "fixtures/cassettes"),
  };
  const baseMode = process.env.NT_MODEL_MODE || "live";
  const clientFor = (i: number) => createModelClient({ ...modelEnv, NT_MODEL_MODE: args.recordFirst && i === 0 ? "record" : baseMode }, { timeoutMs: 120_000 });
  const c0 = clientFor(0);
  console.log(
    `probe:admit tool=${tool.tool_id} schema_hash=${toolSchemaHash(tool).slice(0, 12)} runs=${args.runs} model=${c0.model} backend=${c0.backend} mode=${baseMode}${args.recordFirst ? " (run 1: record)" : ""} sim=${args.scratchSim ? "scratch" : "configured"}`,
  );

  const results: { i: number; ms: number; mode: string; r: AuthorAndAdmitResult | null; error: string | null }[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= args.runs) return;
      const client = clientFor(i);
      const t0 = Date.now();
      try {
        const r = await authorAndAdmit(client, policy, { ...harness, accountPrefix: `probe-admit-r${i + 1}` });
        results.push({ i, ms: Date.now() - t0, mode: client.mode, r, error: null });
        const line = r.attempts.map((a) => `attempt ${a.n}: ${a.verdict?.admitted ? "ADMITTED" : `rejected: ${oneLine(a.reason).slice(0, 160)}`}`).join(" | ");
        console.log(`run ${i + 1}: ${r.admitted ? "ADMITTED" : "NOT ADMITTED"} in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${line}`);
      } catch (e) {
        results.push({ i, ms: Date.now() - t0, mode: client.mode, r: null, error: (e as Error).message });
        console.log(`run ${i + 1}: ERROR ${oneLine((e as Error).message)}`);
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  } finally {
    await sim.stop();
  }
  results.sort((a, b) => a.i - b.i);

  const done = results.filter((x) => x.r !== null);
  const runsAdmitted = done.filter((x) => x.r!.admitted).length;
  const attempts = done.flatMap((x) => x.r!.attempts);
  const attemptsAdmitted = attempts.filter((a) => a.verdict?.admitted).length;
  const firstTry = done.filter((x) => x.r!.attempts[0]?.verdict?.admitted).length;
  const summary = `runs admitted ${runsAdmitted}/${results.length} (first attempt ${firstTry}/${results.length}); attempts admitted ${attemptsAdmitted}/${attempts.length}; errors ${results.length - done.length}`;
  console.log(summary);

  if (args.save) {
    const admitted = done.find((x) => x.r!.admitted);
    if (admitted) {
      const { connect, closeAll } = await import("../../packages/db/src/index.ts");
      const db = await connect("default");
      try {
        const doc = await saveAdmittedProbe(db.probes as unknown as ProbeCollection, admitted.r!.spec!, admitted.r!.verdict!);
        console.log(`saved probes/${doc._id}`);
      } finally {
        await closeAll();
      }
    } else console.log("--save: nothing admitted, nothing saved");
  }

  if (args.out) {
    const out = path.resolve(ROOT, args.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const lines: string[] = [];
    lines.push(`# Generated probe admission rate: ${tool.tool_id} (Tier 3)`, "");
    lines.push(`Tool description: \`${path.relative(ROOT, toolFile)}\` (${oneLine(tool.name)}).`);
    lines.push(`Measured ${new Date().toISOString()} with \`pnpm probe:admit -- --tool ${tool.tool_id}${args.toolFile ? ` --tool-file ${args.toolFile}` : ""} --runs ${args.runs}${args.scratchSim ? " --scratch-sim" : ""}${args.recordFirst ? " --record-first" : ""} --out ${args.out}\`.`);
    lines.push(`Model ${c0.model}, backend ${c0.backend}, mode ${baseMode}${args.recordFirst ? " (run 1 in record mode: genuine model output, stored as cassettes)" : ""}; prompt version probe-author@1; tool schema hash \`${toolSchemaHash(tool)}\`.`);
    lines.push("Each run: one model call writes a ProbeSpec; fixed code admits or rejects it (static checks, then four canaries in scratch simulator accounts with planted ground truth); a rejected spec is retried once with the failure as feedback. Admission is a test, not a proof.", "");
    lines.push(`**${summary}.**`, "");
    lines.push("| Run | Mode | Time | Attempt | Admitted | Canaries (1 found now, 2 decoy ignored, 3 paginated, 4 state unchanged) | Reason when rejected | Spec |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const x of results) {
      if (!x.r) {
        lines.push(`| ${x.i + 1} | ${x.mode} | ${(x.ms / 1000).toFixed(1)} s | - | ERROR | - | ${oneLine(x.error)} | - |`);
        continue;
      }
      for (const a of x.r.attempts) {
        const c = a.verdict?.canaries;
        const cs = c ? [c.found_immediately, c.decoy_ignored, c.paginated, c.state_hash_unchanged].map((b, j) => `${j + 1}:${b ? "pass" : "FAIL"}`).join(" ") : a.verdict ? "not run (static reject)" : "not run (model failure)";
        lines.push(`| ${x.i + 1} | ${x.mode}${a.source ? `/${a.source}` : ""} | ${(x.ms / 1000).toFixed(1)} s | ${a.n} | ${a.verdict?.admitted ? "yes" : "no"} | ${cs} | ${a.verdict?.admitted ? "" : oneLine(a.reason)} | ${specSummary(a)} |`);
      }
    }
    lines.push("");
    fs.writeFileSync(out, lines.join("\n"));
    fs.writeFileSync(out.replace(/\.md$/, "") + ".json", JSON.stringify(results, null, 2));
    console.log(`wrote ${path.relative(ROOT, out)}`);
  }
}

main().catch((e) => {
  console.error(`probe:admit failed: ${(e as Error).message}`);
  process.exit(1);
});
