// pnpm db:down [--rm]  Stops the local MongoDB container nt-mongo (removes it with --rm).
import { spawnSync } from "node:child_process";
import { parseArgs, runMain } from "./lib/args.ts";

await runMain(async () => {
  const a = parseArgs(process.argv.slice(2), []);
  const stop = spawnSync("docker", ["stop", "nt-mongo"], { encoding: "utf8" });
  if (stop.status !== 0) throw new Error(`docker stop nt-mongo failed (not running, or Docker is paused): ${(stop.stderr || stop.stdout).trim().slice(0, 200)}`);
  console.log("stopped nt-mongo");
  if (a.flags.has("rm")) {
    const rm = spawnSync("docker", ["rm", "nt-mongo"], { encoding: "utf8" });
    console.log(rm.status === 0 ? "removed nt-mongo" : `docker rm failed: ${rm.stderr.trim()}`);
  }
});
