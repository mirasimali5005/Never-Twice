// Demo controls: request validation, the one-action-at-a-time rule, tail scrubbing, CORS. The pnpm spawner is mocked.
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { cleanLine, createControl, makeServer, plan, type Spawner } from "../demo/control-server.ts";

describe("control-server plan", () => {
  it("validates the passenger and maps actions to the existing scripts", () => {
    expect(plan("go", { passenger: "P02" })).toEqual({ steps: [["demo:go", "--", "--kill-at", "P02"]] });
    for (const bad of [{}, { passenger: "p02" }, { passenger: "P2" }, { passenger: "P02; rm -rf /" }, { passenger: 2 }, null]) {
      expect("error" in plan("go", bad)).toBe(true);
    }
    expect(plan("resume", {})).toEqual({ steps: [["demo:resume"]] });
    expect(plan("audit", {})).toEqual({ steps: [["demo:audit"]] });
    expect(plan("late-commit", {})).toEqual({ steps: [["demo:late-commit"]] });
    expect(plan("reset", {})).toEqual({ steps: [["demo:reset", "--", "--scenario", "S0"], ["demo:start"]] });
    expect("error" in plan("seed", {})).toBe(true);
  });

  it("drops lines that look like a connection string or a Stripe key", () => {
    expect(cleanLine("uri mongodb+srv://u:p@x")).toBeNull();
    expect(cleanLine("key sk_test_abc")).toBeNull();
    expect(cleanLine("key rk_test_abc")).toBeNull();
    expect(cleanLine("\u001b[32mSAFETY: PASS\u001b[0m")).toBe("SAFETY: PASS");
  });
});

describe("control-server one at a time", () => {
  it("rejects a second action with 409 while one runs, then records the result", async () => {
    let release: (code: number) => void = () => {};
    const calls: string[][] = [];
    const spawner: Spawner = (args, onLine) => {
      calls.push(args);
      onLine("hello");
      onLine("NT_MONGODB_URI=mongodb+srv://secret");
      return new Promise((r) => (release = r));
    };
    const c = createControl({ spawner, groupId: () => "gnew0001" });
    const first = c.run("resume", {});
    expect(c.status().running).toBe("resume");
    const second = await c.run("audit", {});
    expect(second.status).toBe(409);
    release(0);
    const done = await first;
    expect(done.status).toBe(200);
    const last = c.status().last!;
    expect(last.ok).toBe(true);
    expect(last.tail).toEqual(["$ pnpm demo:resume", "hello"]);
    expect(c.status().running).toBeNull();
    expect(calls).toEqual([["demo:resume"]]);
  });

  it("reset runs reset then start and returns the new group; stops at the first failure", async () => {
    const calls: string[][] = [];
    const ok = createControl({ spawner: async (a) => (calls.push(a), 0), groupId: () => "gnew0001" });
    const r = await ok.run("reset", {});
    expect((r.body as { group_id: string }).group_id).toBe("gnew0001");
    expect(calls.map((a) => a[0])).toEqual(["demo:reset", "demo:start"]);
    const failing = createControl({ spawner: async () => 3, groupId: () => "x" });
    const f = (await failing.run("reset", {})).body as { ok: boolean; exit_code: number; group_id: string | null };
    expect(f).toMatchObject({ ok: false, exit_code: 3, group_id: null });
  });

  it("serves status with CORS only for the desk origin and refuses other origins", async () => {
    const server = makeServer(createControl({ spawner: async () => 0, groupId: () => null }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const a = await fetch(`${base}/control/status`, { headers: { Origin: "http://localhost:5173" } });
      expect(a.status).toBe(200);
      expect(a.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      const b = await fetch(`${base}/control/resume`, { method: "POST", headers: { Origin: "http://evil.example" } });
      expect(b.status).toBe(403);
      const c = await fetch(`${base}/control/go`, { method: "POST", body: JSON.stringify({ passenger: "X" }) });
      expect(c.status).toBe(400);
      const d = await fetch(`${base}/control/go`, { method: "POST", body: JSON.stringify({ passenger: "P02" }) });
      expect(d.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
