// pnpm db:up [--dry-run]  Local replica set from the Docker image mongodb/mongodb-atlas-local (container nt-mongo).
// The fallback database for tests, sweeps and a stated stage fallback; the product runs on the Atlas sandbox.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs, runMain } from "./lib/args.ts";
import { openNtDb } from "../packages/db/src/index.ts";

export const CONTAINER = "nt-mongo";
export const IMAGE = "mongodb/mongodb-atlas-local";
export const LOCAL_URI = "mongodb://127.0.0.1:27017/?directConnection=true";

function docker(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain(async () => {
    const a = parseArgs(process.argv.slice(2), []);
    if (a.flags.has("dry-run")) {
      console.log(`docker run -d --name ${CONTAINER} -p 27017:27017 ${IMAGE}   (or: docker start ${CONTAINER} when it exists)`);
      return;
    }
    if (!docker(["info"]).ok) throw new Error("Docker is not running or is paused: start Docker Desktop, then run `pnpm db:up` again");
    const exists = docker(["ps", "-a", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Status}}"]).out;
    if (exists === "") {
      const r = docker(["run", "-d", "--name", CONTAINER, "-p", "27017:27017", IMAGE]);
      if (!r.ok) throw new Error(`docker run failed: ${r.out.slice(0, 300)}`);
      console.error(`started container ${CONTAINER} (${IMAGE})`);
    } else if (!/^Up/.test(exists)) {
      const r = docker(["start", CONTAINER]);
      if (!r.ok) throw new Error(`docker start failed: ${r.out.slice(0, 300)}`);
      console.error(`restarted container ${CONTAINER}`);
    } else console.error(`container ${CONTAINER} already running`);
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        const db = await openNtDb({ uri: LOCAL_URI, dbName: "never_twice" });
        await db.client.db("admin").command({ ping: 1 });
        await db.close();
        break;
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`MongoDB did not accept connections within 120 s (${e instanceof Error ? e.message : e}); see \`docker logs ${CONTAINER}\``);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    console.log(`NT_MONGODB_URI=${LOCAL_URI}`);
    console.log("then: NT_ENV=local, `pnpm db:init`");
  });
}
