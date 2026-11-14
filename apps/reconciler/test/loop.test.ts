// D2 unit tests: the reconciler loop, investigate() and apply() against a fake gateway, a fake store and a fake investigator.
// The fake gateway implements only the compare-and-set semantics the reconciler relies on (state + lease_epoch), on a fake clock.
import { describe, expect, it as test } from "vitest";
import type { DispatchResult, Intent, ModelClient, ProviderObject, QuarantineReason, RecoveryGuards } from "@nt/contracts";
import type { ReadOnlyProviderView, WitnessEvidence } from "@nt/recovery/investigator";
import { ObjectId } from "mongodb";
import { CAPS, RUN, T0, intent, obj } from "./support/fixtures.ts";
import { makeCollect } from "../src/collect.ts";
import { runLoop, tick, type LoopDeps } from "../src/loop.ts";
import { watchOne } from "../src/watcher.ts";
import type { ClosedRecord, Collect, ReconcilerGateway, ReconcilerStore } from "../src/ports.ts";

type Call = { m: string; id: string; detail?: unknown };

/** An in-memory world: intents, the fake clock, a recording fake gateway and a fake store. */
function world() {
  let now = new Date(T0);
  const intents = new Map<string, Intent>();
  const calls: Call[] = [];
  const records: { id: ObjectId; intent_id: string; epoch: number; closed: ClosedRecord | null }[] = [];
  const evidence = new Map<string, ProviderObject[]>(); // what the fake investigator "finds" per intent
  const resendResults = new Map<string, DispatchResult>();
  let licenceRefused = false;
  const guards = new Map<string, RecoveryGuards>();

  const put = (it: Intent) => intents.set(it._id, structuredClone(it));
  const get = (id: string) => structuredClone(intents.get(id)!);
  const cas = (id: string, state: Intent["state"], epoch: number, f: (x: Intent) => void): Intent | null => {
    const cur = intents.get(id);
    if (!cur || cur.state !== state || cur.lease_epoch !== epoch) return null;
    f(cur);
    cur.updated_at = now;
    return structuredClone(cur);
  };
  const liveLease = (x: Intent) => x.lease !== null && x.lease.expires_at > now;

  const gateway: ReconcilerGateway = {
    async dispatch(id, worker) {
      calls.push({ m: "dispatch", id, detail: worker });
      return cas(id, "RESERVED", get(id).lease_epoch, (x) => {
        x.state = "CONFIRMED";
        x.lease_epoch++;
      });
    },
    async takeOverExpired(id, seenEpoch) {
      calls.push({ m: "takeOverExpired", id });
      const cur = intents.get(id);
      if (!cur?.lease || cur.lease.expires_at > now) return null;
      return cas(id, "DISPATCHING", seenEpoch, (x) => {
        x.state = "OUTCOME_UNKNOWN";
        x.lease_epoch++;
        x.lease = null;
        x.next_attempt_at = now;
      });
    },
    async acquireLease(id, seenEpoch, worker) {
      calls.push({ m: "acquireLease", id });
      const cur = intents.get(id);
      if (!cur || liveLease(cur) || cur.next_attempt_at === null || cur.next_attempt_at > now) return null;
      return cas(id, "OUTCOME_UNKNOWN", seenEpoch, (x) => {
        x.lease = { owner: worker, expires_at: new Date(now.getTime() + 56_000) };
        x.lease_epoch++;
      });
    },
    async settle(it, ev) {
      calls.push({ m: "settle", id: it._id, detail: ev.source });
      return cas(it._id, "OUTCOME_UNKNOWN", it.lease_epoch, (x) => {
        x.state = "CONFIRMED";
        x.lease = null;
      });
    },
    async quarantine(it, reason: QuarantineReason, detail) {
      calls.push({ m: "quarantine", id: it._id, detail: reason });
      return cas(it._id, "OUTCOME_UNKNOWN", it.lease_epoch, (x) => {
        x.state = "QUARANTINED";
        x.lease = null;
        x.quarantine = { reason, detail, at: now };
      });
    },
    async recordLicence(it, licence) {
      calls.push({ m: "recordLicence", id: it._id, detail: licence });
      if (licenceRefused) return null;
      return cas(it._id, "OUTCOME_UNKNOWN", it.lease_epoch, (x) => {
        x.attempts.push({ n: x.attempts.length + 1, at: now, licence, request_sha256: x.frozen_request_sha256, epoch: x.lease_epoch, result: null });
      });
    },
    async resend(it2) {
      calls.push({ m: "resend", id: it2._id });
      return resendResults.get(it2._id) ?? { kind: "ACCEPTED", object: obj(it2), replayed: false };
    },
    async applyResendResult(it2, res) {
      calls.push({ m: "applyResendResult", id: it2._id, detail: res.kind });
      return cas(it2._id, "OUTCOME_UNKNOWN", it2.lease_epoch, (x) => {
        x.state = res.kind === "ACCEPTED" ? "CONFIRMED" : res.kind === "REJECTED_DEFINITIVE" ? "FAILED_NO_EFFECT" : "OUTCOME_UNKNOWN";
        x.lease = null;
      });
    },
    readOnlyProviderView() {
      throw new Error("fake gateway: no provider view (fake investigator in use)");
    },
    capabilitiesOf: (p) => CAPS[p],
  };

  const byState = (s: Intent["state"]) => [...intents.values()].filter((x) => x.state === s).map((x) => structuredClone(x));
  const store: ReconcilerStore = {
    now: async () => now,
    orphans: async (_r, leaseMs) => byState("RESERVED").filter((x) => !liveLease(x) && x.created_at.getTime() <= now.getTime() - leaseMs),
    expiredDispatching: async () => byState("DISPATCHING").filter((x) => x.lease !== null && x.lease.expires_at <= now),
    dueUnknown: async () => byState("OUTCOME_UNKNOWN").filter((x) => !liveLease(x) && x.next_attempt_at !== null && x.next_attempt_at <= now),
    watchable: async () => [],
    unresolvedCount: async () => [...intents.values()].filter((x) => ["RESERVED", "DISPATCHING", "OUTCOME_UNKNOWN"].includes(x.state)).length,
    guards: async (it) => guards.get(it._id) ?? { obligationStatus: "OWED", obligationReason: null, grantFrozen: false },
    async openInvestigation(it) {
      const id = new ObjectId();
      records.push({ id, intent_id: it._id, epoch: it.lease_epoch, closed: null });
      calls.push({ m: "openInvestigation", id: it._id });
      return { id };
    },
    async closeInvestigation(rec, _it, closed) {
      records.find((r) => r.id.equals(rec.id))!.closed = closed;
      calls.push({ m: "closeInvestigation", id: _it._id });
    },
  };

  const fakeCollect: Collect = async (it) => {
    calls.push({ m: "collect", id: it._id });
    const rs = evidence.get(it._id) ?? [];
    return { investigator: "llm", hypothesis: "response lost after apply", steps: [{ tool: "list_provider_payments_by_payee", input: {}, summary: "", record_count: rs.length }], records: rs, complete: true, fallback_reason: null } satisfies WitnessEvidence;
  };

  const barrier = (name: string, key?: string) => calls.push({ m: name, id: key ?? "" });
  const deps = (over: Partial<LoopDeps> = {}): LoopDeps => ({ runId: RUN, workerId: "reconciler-test", leaseMs: 8000, watch: false, gateway, store, collect: fakeCollect, barrier, ...over });

  return {
    intents, calls, records, evidence, resendResults, guards, gateway, store, deps, put, get,
    refuseLicence: () => { licenceRefused = true; },
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
    names: (id?: string) => calls.filter((c) => id === undefined || c.id === id || c.id === "" || c.id.startsWith("ZT4H9X")).map((c) => c.m),
  };
}

describe("reconciler loop (fake gateway)", () => {
  test("takeover of an expired DISPATCHING: T5 then the same tick acquires the lease and investigates", async () => {
    const w = world();
    const it = intent("P02", "sim_payout", { state: "DISPATCHING", lease: { owner: "runner-1", expires_at: new Date(T0.getTime() - 1) }, next_attempt_at: null });
    w.put(it);
    w.evidence.set(it._id, [obj(it)]);
    const r = await tick(w.deps());
    expect(r).toMatchObject({ takeovers: 1, investigated: 1, errors: 0 });
    expect(w.calls.map((c) => c.m)).toEqual([
      "takeOverExpired", "acquireLease", "openInvestigation", "collect", "closeInvestigation", "BR_RECON_AFTER_EVIDENCE", "settle",
    ]);
    expect(w.get(it._id).state).toBe("CONFIRMED");
    expect(w.get(it._id).lease_epoch).toBe(3); // +1 takeover, +1 lease
  });

  test("a DISPATCHING whose lease is still live is not taken over", async () => {
    const w = world();
    const it = intent("P03", "sim_payout", { state: "DISPATCHING", lease: { owner: "runner-1", expires_at: new Date(T0.getTime() + 5000) } });
    w.put(it);
    const r = await tick(w.deps());
    expect(r.takeovers).toBe(0);
    expect(w.get(it._id).state).toBe("DISPATCHING");
  });

  test("investigate MATCH → settle with source PROBE; no licence, no re-send; record closed", async () => {
    const w = world();
    const it = intent("P02", "sim_payout");
    w.put(it);
    // the same object twice (e.g. list + search): de-duplicated by id, so MATCH, not CONTRADICTION MULTIPLE_OBJECTS
    w.evidence.set(it._id, [obj(it), obj(it)]);
    await tick(w.deps());
    expect(w.calls.find((c) => c.m === "settle")?.detail).toBe("PROBE");
    expect(w.calls.some((c) => c.m === "resend" || c.m === "recordLicence")).toBe(false);
    expect(w.get(it._id).state).toBe("CONFIRMED");
    const rec = w.records[0]!;
    expect(rec.closed).toMatchObject({ match: "MATCH", decision: { kind: "SETTLE", row: 2 }, licence: null, investigator: "llm" });
    expect(rec.closed!.records).toHaveLength(1);
    expect(rec.epoch).toBe(2); // the epoch the lease was acquired at
  });

  test("NO_MATCH on a deduplicating rail within the key window → recordLicence, then resend, then applyResendResult, barriers between", async () => {
    const w = world();
    const it = intent("P13", "sim_payout");
    w.put(it);
    await tick(w.deps());
    expect(w.calls.map((c) => c.m)).toEqual([
      "acquireLease", "openInvestigation", "collect", "closeInvestigation", "BR_RECON_AFTER_EVIDENCE",
      "recordLicence", "BR_RECON_AFTER_LICENCE", "resend", "BR_RECON_AFTER_RESEND", "applyResendResult",
    ]);
    expect(w.calls.find((c) => c.m === "recordLicence")?.detail).toBe("L1_SAME_KEY");
    expect(w.records[0]!.closed).toMatchObject({ match: "NO_MATCH", decision: { kind: "REDISPATCH_SAME_KEY", row: 6 }, licence: "L1_SAME_KEY" });
    expect(w.get(it._id).state).toBe("CONFIRMED");
    expect(w.get(it._id).attempts.map((a) => a.licence)).toEqual(["FIRST_SEND", "L1_SAME_KEY"]);
    // barriers carry the effect key
    expect(w.calls.filter((c) => c.m.startsWith("BR_")).every((c) => c.id === it.effect_key)).toBe(true);
  });

  test("recordLicence returning null sends nothing", async () => {
    const w = world();
    const it = intent("P14", "sim_payout");
    w.put(it);
    w.refuseLicence();
    await tick(w.deps());
    expect(w.calls.some((c) => c.m === "resend" || c.m === "applyResendResult" || c.m === "BR_RECON_AFTER_LICENCE")).toBe(false);
    expect(w.get(it._id).state).toBe("OUTCOME_UNKNOWN");
  });

  test("NO_MATCH after the key window closed → QUARANTINE KEY_WINDOW_EXPIRED, nothing sent", async () => {
    const w = world();
    const it = intent("P15", "sim_payout", { key_expires_at: new Date(T0.getTime() - 1) });
    w.put(it);
    await tick(w.deps());
    expect(w.calls.find((c) => c.m === "quarantine")?.detail).toBe("KEY_WINDOW_EXPIRED");
    expect(w.calls.some((c) => c.m === "resend")).toBe(false);
  });

  test("keyless NO_MATCH → quarantine NO_DEDUPE_NO_EVIDENCE; nothing sent; reservation untouched by the reconciler", async () => {
    const w = world();
    const it = intent("P11", "sim_keyless");
    w.put(it);
    await tick(w.deps());
    expect(w.calls.find((c) => c.m === "quarantine")?.detail).toBe("NO_DEDUPE_NO_EVIDENCE");
    expect(w.calls.some((c) => c.m === "resend" || c.m === "recordLicence" || c.m === "settle")).toBe(false);
    expect(w.get(it._id)).toMatchObject({ state: "QUARANTINED", quarantine: { reason: "NO_DEDUPE_NO_EVIDENCE" } });
    expect(w.records[0]!.closed).toMatchObject({ match: "NO_MATCH", decision: { kind: "QUARANTINE", row: 9 } });
  });

  test("CONTRADICTION (amount differs) → quarantine CONTRADICTORY_EVIDENCE", async () => {
    const w = world();
    const it = intent("P05", "sim_payout");
    w.put(it);
    w.evidence.set(it._id, [obj(it, { amount_minor: 1 })]);
    await tick(w.deps());
    expect(w.calls.find((c) => c.m === "quarantine")?.detail).toBe("CONTRADICTORY_EVIDENCE");
    expect(w.records[0]!.closed).toMatchObject({ match: "CONTRADICTION", match_detail: "FIELD_MISMATCH", decision: { row: 1 } });
  });

  test("CONTRADICTION (two distinct objects carry the marker) → quarantine CONTRADICTORY_EVIDENCE", async () => {
    const w = world();
    const it = intent("P06", "sim_payout");
    w.put(it);
    w.evidence.set(it._id, [obj(it), obj(it, { id: "po_other" })]);
    await tick(w.deps());
    expect(w.calls.find((c) => c.m === "quarantine")?.detail).toBe("CONTRADICTORY_EVIDENCE");
  });

  test("guards: payee change on NO_MATCH → PAYEE_CHANGED, not a re-send", async () => {
    const w = world();
    const it = intent("P07", "sim_payout");
    w.put(it);
    w.guards.set(it._id, { obligationStatus: "HELD", obligationReason: "PAYEE_CHANGE_REQUESTED", grantFrozen: false });
    await tick(w.deps());
    expect(w.calls.find((c) => c.m === "quarantine")?.detail).toBe("PAYEE_CHANGED");
    expect(w.calls.some((c) => c.m === "resend")).toBe(false);
  });

  test("orphaned RESERVED is dispatched only after one lease period", async () => {
    const w = world();
    const it = intent("P08", "sim_payout", { state: "RESERVED", lease_epoch: 0, created_at: new Date(T0.getTime() - 1000), attempts: [] });
    w.put(it);
    expect((await tick(w.deps())).orphans).toBe(0);
    w.advance(8000);
    expect((await tick(w.deps())).orphans).toBe(1);
    expect(w.calls.find((c) => c.m === "dispatch")?.detail).toBe("reconciler-test");
  });

  test("an intent whose lease another worker holds is skipped (acquireLease null → no investigation)", async () => {
    const w = world();
    const it = intent("P09", "sim_payout", { lease: { owner: "reconciler-other", expires_at: new Date(T0.getTime() + 30_000) } });
    w.put(it);
    const r = await tick(w.deps());
    expect(r.investigated).toBe(0);
    expect(w.calls.some((c) => c.m === "collect")).toBe(false);
  });
});

describe("--until-drained", () => {
  test("exits 0 at once when nothing is RESERVED, DISPATCHING or OUTCOME_UNKNOWN; QUARANTINED does not keep it alive", async () => {
    const w = world();
    w.put(intent("P11", "sim_keyless", { state: "QUARANTINED", quarantine: { reason: "NO_DEDUPE_NO_EVIDENCE", detail: "", at: T0 } }));
    w.put(intent("P02", "sim_payout", { state: "CONFIRMED" }));
    let slept = 0;
    const code = await runLoop(w.deps(), { untilDrained: true, once: false, intervalMs: 1000, sleep: async () => { slept++; } });
    expect(code).toBe(0);
    expect(slept).toBe(0);
    expect(w.calls).toEqual([]);
  });

  test("keeps polling while an intent is unresolved, then exits 0 once it resolves", async () => {
    const w = world();
    const it = intent("P13", "sim_payout");
    w.put(it);
    w.resendResults.set(it._id, { kind: "INDETERMINATE", cause: "TIMEOUT", detail: "held" });
    let slept = 0;
    const code = await runLoop(w.deps(), {
      untilDrained: true,
      once: false,
      intervalMs: 1000,
      sleep: async (ms) => {
        slept++;
        w.advance(ms);
        if (slept === 1) w.resendResults.set(it._id, { kind: "ACCEPTED", object: obj(it), replayed: true });
      },
    });
    expect(code).toBe(0);
    expect(slept).toBeGreaterThanOrEqual(1);
    expect(w.get(it._id).state).toBe("CONFIRMED");
    expect(w.calls.filter((c) => c.m === "resend")).toHaveLength(2);
  });

  test("--once runs exactly one pass", async () => {
    const w = world();
    w.put(intent("P13", "sim_payout"));
    w.resendResults.set(`${RUN}:ZT4H9X.P13.NT101-20261110.APPR_DELAY`, { kind: "INDETERMINATE", cause: "TIMEOUT", detail: "" });
    let slept = 0;
    expect(await runLoop(w.deps(), { untilDrained: false, once: true, intervalMs: 1000, sleep: async () => { slept++; } })).toBe(0);
    expect(slept).toBe(0);
  });
});

describe("investigator timeout → deterministic fallback recorded", () => {
  test("a model that never answers is abandoned at the timeout; the deterministic investigator finds the evidence; record says so", async () => {
    const w = world();
    const it = intent("P02", "sim_payout");
    w.put(it);
    const found = obj(it);
    const view: ReadOnlyProviderView = {
      async getOperation() { return null; },
      async findOperationEvidence() { return { records: [found], complete: true }; },
      async *listOperations() { yield found; },
    };
    const hangingModel: ModelClient = {
      mode: "live",
      model: "fake",
      backend: "cli",
      parse: () => new Promise(() => {}),
      runTools: () => new Promise(() => {}),
    };
    const collect = makeCollect({ gateway: { readOnlyProviderView: () => view }, mode: "llm", model: hangingModel, timeoutMs: 50, graceMs: 50 });
    await tick(w.deps({ collect }));
    const closed = w.records[0]!.closed!;
    expect(closed.investigator).toBe("deterministic");
    expect(closed.fallback_reason).toMatch(/TIMEOUT/);
    expect(closed.match).toBe("MATCH");
    expect(w.get(it._id).state).toBe("CONFIRMED");
  });

  test("NT_RECONCILER_INVESTIGATOR=deterministic (mode deterministic) never calls the model", async () => {
    const w = world();
    const it = intent("P02", "sim_payout");
    w.put(it);
    const found = obj(it);
    let modelCalls = 0;
    const model: ModelClient = { mode: "live", model: "fake", backend: "cli", parse: async () => { modelCalls++; throw new Error("no"); }, runTools: async () => { modelCalls++; throw new Error("no"); } };
    const view: ReadOnlyProviderView = {
      async getOperation() { return null; },
      async findOperationEvidence() { return { records: [found], complete: true }; },
      async *listOperations() { yield found; },
    };
    const collect = makeCollect({ gateway: { readOnlyProviderView: () => view }, mode: "deterministic", model, timeoutMs: 50 });
    await tick(w.deps({ collect }));
    expect(modelCalls).toBe(0);
    expect(w.records[0]!.closed).toMatchObject({ investigator: "deterministic", fallback_reason: null, match: "MATCH" });
  });
});

describe("Tier 2 watcher (T12)", () => {
  const quarantined = (reason: "NO_DEDUPE_NO_EVIDENCE" | "CONTRADICTORY_EVIDENCE") =>
    intent("P11", "sim_keyless", { state: "QUARANTINED", quarantine: { reason, detail: "", at: T0 } });
  const collectWith = (rs: ProviderObject[]): Collect => async () => ({ investigator: "deterministic", hypothesis: null, steps: [], records: rs, complete: true, fallback_reason: null });

  test("absence-class quarantine + MATCH → confirmQuarantined", async () => {
    const w = world();
    const it = quarantined("NO_DEDUPE_NO_EVIDENCE");
    const confirmed: string[] = [];
    const gateway = { ...w.gateway, confirmQuarantined: async (x: Intent) => { confirmed.push(x._id); return { ...x, state: "CONFIRMED" as const }; } };
    expect(await watchOne({ ...w.deps({ gateway }), watchCollect: collectWith([obj(it)]) }, it)).toBe(true);
    expect(confirmed).toEqual([it._id]);
  });

  test("NO_MATCH, or a non-absence reason, changes nothing", async () => {
    const w = world();
    let n = 0;
    const gateway = { ...w.gateway, confirmQuarantined: async (x: Intent) => { n++; return x; } };
    const a = quarantined("NO_DEDUPE_NO_EVIDENCE");
    expect(await watchOne({ ...w.deps({ gateway }), watchCollect: collectWith([]) }, a)).toBe(false);
    const b = quarantined("CONTRADICTORY_EVIDENCE");
    expect(await watchOne({ ...w.deps({ gateway }), watchCollect: collectWith([obj(b)]) }, b)).toBe(false);
    expect(n).toBe(0);
  });
});
