// Tier 3 (CP-REV-1): POST /admin/payouts/reverse — a paid object is later undone at the provider (paid → reversed | failed).
// One-way, admin key only, appended to the ledger and rebuilt on restart; a replay under the same key returns the current status.
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KEYS, TestSim, frozen, ok } from "./support.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nt-sim-reverse-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("admin reverse", () => {
  it("reverses a paid object once, persists it across a restart, and refuses bad input", async () => {
    let sim = await TestSim.start(dir);
    const account = await sim.account();
    const body = frozen({ account, marker: "run1:REV1", payee_ref: "payee_P02" });
    const a = ok(await sim.pay(body, { idem: "run1:REV1" })).json;
    expect(a.status).toBe("paid");
    const h0 = ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json;

    expect(ok(await sim.call("POST", "/admin/payouts/reverse", { key: KEYS.write, body: { account, id: a.id } })).status).toBe(401);
    expect(ok(await sim.admin("POST", "/admin/payouts/reverse", { account, id: "po_nope" })).status).toBe(404);
    expect(ok(await sim.admin("POST", "/admin/payouts/reverse", { account, id: a.id, status: "paid" })).status).toBe(400);

    const r = ok(await sim.admin("POST", "/admin/payouts/reverse", { account, id: a.id }));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: a.id, status: "reversed", amount_minor: a.amount_minor, metadata: a.metadata });
    expect(ok(await sim.admin("POST", "/admin/payouts/reverse", { account, id: a.id, status: "failed" })).status).toBe(409); // one-way

    expect(ok(await sim.get(`/v1/payouts/${a.id}`)).json.status).toBe("reversed");
    expect(ok(await sim.get(`/v1/payouts?account=${account}`)).json.data[0].status).toBe("reversed");
    const h1 = ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json;
    expect(h1.objects).toBe(1); // no new object
    expect(h1.state_hash).not.toBe(h0.state_hash);
    // a same-key replay serves the stored object as it is now
    const replay = ok(await sim.pay(body, { idem: "run1:REV1" }));
    expect(replay.json).toMatchObject({ id: a.id, status: "reversed" });

    await sim.stop(false);
    sim = await TestSim.start(dir);
    expect(ok(await sim.get(`/v1/payouts/${a.id}`)).json.status).toBe("reversed");
    expect(ok(await sim.admin("GET", `/admin/state-hash?account=${account}`)).json).toEqual(h1);
    await sim.stop(false);
  });
});
