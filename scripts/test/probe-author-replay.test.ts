// PRB (replay): the probe author's REAL recorded model output (cassette recorded by `pnpm probe:admit -- --record-first`, cli backend,
// claude-opus-5-5) replays through createModelClient in replay mode, and the replayed spec is admitted by the fixed admission code
// against a real simulator. No live model call: a cassette miss fails the test.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelClient } from "../../packages/agents/src/index.ts";
import { authorAndAdmit, authorProbe } from "../../packages/recovery/src/probes/index.ts";
import { SimProcess } from "../../packages/recovery/test/support/sim-process.ts";
import { NOTIFY_TOOL, harness, policy } from "../../packages/recovery/test/support/probes.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const replay = () => createModelClient({ NT_MODEL: "claude-opus-5-5", NT_MODEL_MODE: "replay", NT_MODEL_BACKEND: "cli", NT_MODEL_CASSETTE_DIR: path.join(ROOT, "fixtures/cassettes") });

let sim: SimProcess;
beforeAll(async () => {
  sim = await SimProcess.start();
}, 30_000);
afterAll(async () => {
  await sim.stop();
});

describe("probe author, replayed from the recorded cassette", () => {
  it("serves the recorded ProbeSpec for notify.send from the cassette (no live call)", async () => {
    const r = await authorProbe(replay(), NOTIFY_TOOL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("cassette");
    expect(r.spec.tool_id).toBe("notify.send");
    expect(r.spec.request.method).toBe("GET");
    expect(r.spec.request.path).toBe("/v1/messages");
  });

  it("the recorded spec is admitted on the first attempt by the fixed admission code", async () => {
    const r = await authorAndAdmit(replay(), policy(sim.baseUrl), harness(sim.baseUrl));
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]!.source).toBe("cassette");
    expect(r.admitted).toBe(true);
    expect(r.verdict!.canaries).toEqual({ found_immediately: true, decoy_ignored: true, paginated: true, state_hash_unchanged: true });
  });
});
