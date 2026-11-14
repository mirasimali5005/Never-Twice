// PRB-02..PRB-06: the four canaries against the REAL provider simulator (child process, scratch accounts, planted ground truth).
// A good spec is admitted; each known-bad spec is rejected at the canary the test plan names. Plus: an admitted probe's records feed
// the same fixed matcher (matchEvidence).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchEvidence } from "../src/pure/index.ts";
import { admitProbe, executeProbe, runCanaries, toProviderObjects } from "../src/probes/index.ts";
import { SIM_KEYS, SimProcess } from "./support/sim-process.ts";
import { countingFetch, goodSpec, harness, policy, variant } from "./support/probes.ts";

let sim: SimProcess;
beforeAll(async () => {
  sim = await SimProcess.start();
}, 30_000);
afterAll(async () => {
  await sim.stop();
});

describe("PRB-02..05 a good spec passes all four canaries and is admitted", () => {
  it("found immediately, decoy ignored, found behind 30 decoys (several pages), state hash unchanged", async () => {
    const c = countingFetch();
    const v = await admitProbe(goodSpec(), policy(sim.baseUrl), harness(sim.baseUrl, c.fetchImpl));
    expect(v.failures).toEqual([]);
    expect(v.canaries).toEqual({ found_immediately: true, decoy_ignored: true, paginated: true, state_hash_unchanged: true });
    expect(v.admitted).toBe(true);
    expect(v.reason).toBeNull();
    // canary 1 one page, canary 2 one page, canary 3 two pages (31 messages, page cap 20)
    expect(v.probe_requests).toBe(4);
  });

  it("canary 3 needs the cursor: at the default page size of 10 the target is on page 4", async () => {
    const spec = variant((s) => delete s.request.query.limit);
    const rep = await runCanaries(spec, harness(sim.baseUrl));
    expect(rep.canaries.paginated).toBe(true);
    expect(rep.probe_requests).toBe(1 + 1 + 4);
  });
});

describe("PRB-06 known-bad specs are rejected at the named canary", () => {
  it("PRB-06a matches any recent object (newest object, no marker check): rejected at canary 2", async () => {
    const spec = variant((s) => {
      s.request.query = { account: "{{account}}", limit: "1" };
      s.marker_path = null;
      s.pagination = null;
    });
    const v = await admitProbe(spec, policy(sim.baseUrl), harness(sim.baseUrl));
    expect(v.admitted).toBe(false);
    expect(v.canaries!.found_immediately).toBe(true); // it does "find" the newest object
    expect(v.canaries!.decoy_ignored).toBe(false);
    expect(v.failures[0]!.number).toBe(2);
    expect(v.reason).toMatch(/^canary 2 \(decoy_ignored\)/);
  });

  it("PRB-06b uses the lagging search path: rejected at canary 1 (the planted effect is not yet visible)", async () => {
    const spec = variant((s) => {
      s.request.path = "/v1/search/messages";
      s.request.query = { account: "{{account}}", marker: "{{marker}}" };
      s.pagination = null;
    });
    const v = await admitProbe(spec, policy(sim.baseUrl), harness(sim.baseUrl));
    expect(v.static).toEqual({ ok: true }); // a documented read endpoint: only the canary can catch it
    expect(v.admitted).toBe(false);
    expect(v.failures[0]!.number).toBe(1);
    expect(v.reason).toMatch(/^canary 1 \(found_immediately\): planted message not found immediately after the write \(0 record/);
  });

  it("PRB-06c calls a write endpoint: rejected by the static method check with zero requests; with that check disabled, canary 4 fails", async () => {
    const spec = variant((s) => {
      s.request.method = "POST";
      s.request.query = { account: "{{account}}", recipient: "{{payee_ref}}", template: "probe" };
    });
    const c = countingFetch();
    const v = await admitProbe(spec, policy(sim.baseUrl), harness(sim.baseUrl, c.fetchImpl));
    expect(v.admitted).toBe(false);
    expect(v.static).toMatchObject({ ok: false, check: "METHOD" });
    expect(c.count()).toBe(0);
    // Static check disabled, read key: the simulator refuses the POST (401, a read key never writes), nothing is mutated, and the
    // probe fails canary 1 because it reads nothing.
    const readOnly = await admitProbe(spec, policy(sim.baseUrl), harness(sim.baseUrl), { testOnlyDisableStatic: true });
    expect(readOnly.admitted).toBe(false);
    expect(readOnly.canaries!.state_hash_unchanged).toBe(true);
    expect(readOnly.reason).toMatch(/^canary 1 .*HTTP 401/);
    // Static checks disabled AND the write credential attached (both layers removed): the POST creates messages and canary 4 fails.
    const unsafe = await admitProbe(spec, policy(sim.baseUrl), { ...harness(sim.baseUrl), readKey: SIM_KEYS.write }, { testOnlyDisableStatic: true });
    expect(unsafe.admitted).toBe(false);
    expect(unsafe.canaries!.state_hash_unchanged).toBe(false);
    expect(unsafe.failures.map((f) => f.number)).toContain(4);
    // and run.ts refuses a non-GET on its own, whatever admission said
    const r = await executeProbe(spec, { marker: "m", payee_ref: "p", account: "a", first_dispatch_at: "2026-01-01T00:00:00Z", amount_minor: "1", currency: "CAD" }, { baseUrl: sim.baseUrl, readKey: SIM_KEYS.read });
    expect(r).toMatchObject({ ok: false, requests: 0 });
  });

  it("PRB-06d ignores the marker (marker_path points elsewhere): rejected at canary 1", async () => {
    const spec = variant((s) => (s.marker_path = "$.metadata.nt_run_id"));
    const v = await admitProbe(spec, policy(sim.baseUrl), harness(sim.baseUrl));
    expect(v.admitted).toBe(false);
    expect([1, 2]).toContain(v.failures[0]!.number);
  });

  it("no pagination: the target behind 30 decoys is missed, rejected at canary 3", async () => {
    const spec = variant((s) => (s.pagination = null));
    const v = await admitProbe(spec, policy(sim.baseUrl), harness(sim.baseUrl));
    expect(v.admitted).toBe(false);
    expect(v.canaries).toEqual({ found_immediately: true, decoy_ignored: true, paginated: false, state_hash_unchanged: true });
    expect(v.reason).toMatch(/^canary 3 \(paginated\)/);
  });

  it("too few pages (max_pages 1 at the default page size): rejected at canary 3", async () => {
    const spec = variant((s) => {
      delete s.request.query.limit;
      s.pagination!.max_pages = 1;
    });
    const v = await admitProbe(spec, policy(sim.baseUrl), harness(sim.baseUrl));
    expect(v.admitted).toBe(false);
    expect(v.failures.map((f) => f.number)).toEqual([3]);
    expect(v.reason).toMatch(/stopped at max_pages/);
  });
});

describe("an admitted probe feeds the same fixed matcher", () => {
  it("records carry the marker; matchEvidence finds the hit for the sent letter and NO_MATCH for a letter never sent", async () => {
    const account = await sim.account({ search_lag_ms: 5000 });
    const since = new Date(Date.now() - 1000).toISOString();
    const marker = "r7k2m9qa:ZT4H9X.P02.LETTER";
    const sent = await fetch(`${sim.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SIM_KEYS.write}`, "Content-Type": "application/json" },
      body: JSON.stringify({ account, recipient: "payee_P02", template: "decision_letter_v1", amount_minor: 70000, currency: "CAD", metadata: { nt_marker: marker } }),
    }).then((r) => r.json() as Promise<{ id: string }>);
    const conn = { baseUrl: sim.baseUrl, readKey: SIM_KEYS.read };
    const ctx = { marker, payee_ref: "payee_P02", account, first_dispatch_at: since, amount_minor: "70000", currency: "CAD" };
    const run = await executeProbe(goodSpec(), ctx, conn);
    expect(run).toMatchObject({ ok: true, complete: true });
    const records = toProviderObjects(run.ok ? run.records : []);
    expect(records.map((r) => r.id)).toEqual([sent.id]);
    const intent = { _id: marker, amount_minor: 70000, currency: "CAD" as const, payee_ref: "payee_P02", provider: "sim_keyless" as const, frozen_request: { parent_ref: null } };
    const m = matchEvidence(intent, records);
    // The hit is found by marker. ACCEPTED_STATUSES (frozen contracts) has no notify provider, so a message's status "sent" is not an
    // accepted payment status: the fixed matcher reports CONTRADICTION STATUS_sent, never MATCH, and never NO_MATCH.
    expect(m).toEqual({ kind: "CONTRADICTION", why: "STATUS_sent" });
    const none = await executeProbe(goodSpec(), { ...ctx, marker: "r7k2m9qa:NEVER.SENT" }, conn);
    expect(matchEvidence({ ...intent, _id: "r7k2m9qa:NEVER.SENT" }, toProviderObjects(none.ok ? none.records : []))).toEqual({ kind: "NO_MATCH" });
  });
});
