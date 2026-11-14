// REV-INT (Tier 3, CP-REV-1): provider-side reversal of a CONFIRMED payment. The intent stays CONFIRMED (CONFIRMED → anything is
// still forbidden), one PROVIDER_REVERSAL audit event is recorded exactly once, nothing is re-sent, the goodwill counters do not
// move, P9 still replays, and only positive evidence of a reversal records anything.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProgrammerError, dispatch, recordProviderReversal, reversedIntentIds, scanInvariants } from "../src/index.ts";
import { reservedFlow, unknownFlow } from "./support/flow.ts";
import { startWorld, type World } from "./support/world.ts";

let w: World;
beforeAll(async () => { w = await startWorld(); }, 180_000);
afterAll(async () => { await w?.stop(); });

describe("recordProviderReversal", () => {
  it("records one audit event for a reversed confirmed goodwill payout; intent, counters and P9 unchanged; idempotent; no re-send", async () => {
    const f = await reservedFlow(w, ["ACCEPT"], { entitlement_type: "GOODWILL" });
    const confirmed = await dispatch(f.deps, f.id);
    expect(confirmed.state).toBe("CONFIRMED");
    const grantBefore = await w.db.grants.findOne({ _id: `${f.run}:GOODWILL` });
    const obj = f.provider.ledger[0]!;

    // still paid: nothing recorded
    expect(await recordProviderReversal(f.deps, confirmed, obj)).toEqual({ kind: "NOT_REVERSED", why: "STILL_PAID" });
    expect(await w.db.audit.countDocuments({ run_id: f.run, type: "PROVIDER_REVERSAL" })).toBe(0);

    obj.status = "reversed";
    const r1 = await recordProviderReversal(f.deps, confirmed, obj);
    expect(r1.kind).toBe("RECORDED");
    // a second reconciler seeing the same reversal: the deterministic _id makes it a no-op
    const r2 = await recordProviderReversal(f.deps, confirmed, obj);
    expect(r2.kind).toBe("ALREADY_RECORDED");
    const evs = await w.db.audit.find({ run_id: f.run, type: "PROVIDER_REVERSAL" }).toArray();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ intent_id: f.id, from_state: null, to_state: null, detail: { reason: "PROVIDER_REVERSAL", status_now: "reversed", provider_object_id: obj.id, action: "PARKED_FOR_PERSON" } });

    const after = await w.db.intents.findOne({ _id: f.id });
    expect(after?.state).toBe("CONFIRMED");
    expect(after?.updated_at).toEqual(confirmed.updated_at); // the intent document was not written
    expect(await w.db.grants.findOne({ _id: `${f.run}:GOODWILL` })).toEqual(grantBefore); // settled stays counted (conservative)
    expect(f.provider.calls).toHaveLength(1); // never re-paid
    expect([...(await reversedIntentIds(f.deps, f.run))]).toEqual([f.id]);
    const scan = await scanInvariants(f.deps, f.run);
    expect(scan.violations).toEqual([]);
  });

  it("only positive evidence: a missing object, another marker or an unknown status records nothing; non-CONFIRMED is a programmer error", async () => {
    const f = await reservedFlow(w, ["ACCEPT"]);
    const confirmed = await dispatch(f.deps, f.id);
    const obj = f.provider.ledger[0]!;
    expect((await recordProviderReversal(f.deps, confirmed, { ...obj, status: "weird" })).kind).toBe("NOT_REVERSED");
    expect((await recordProviderReversal(f.deps, confirmed, { ...obj, status: "reversed", metadata: { ...obj.metadata, nt_marker: "other" } })).kind).toBe("NOT_REVERSED");
    expect((await recordProviderReversal(f.deps, confirmed, { ...obj, status: "reversed", id: "po_other" })).kind).toBe("NOT_REVERSED");
    expect((await recordProviderReversal(f.deps, confirmed, { ...obj, status: "reversed", amount_minor: 1 })).kind).toBe("NOT_REVERSED");
    expect(await w.db.audit.countDocuments({ run_id: f.run, type: "PROVIDER_REVERSAL" })).toBe(0);

    const u = await unknownFlow(w);
    await expect(recordProviderReversal(u.deps, u.it, { ...obj, status: "reversed" })).rejects.toBeInstanceOf(ProgrammerError);
  });
});
