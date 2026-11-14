// dispatch (HANDOVER.md §10.4): mark (T2), barrier, hash check, provider call, barrier, then T3, T13, T4 or T5.
// Anything thrown by the provider after the mark is treated as INDETERMINATE (T5): the request may have left. The intent is
// never left DISPATCHING by a throw of ours and never released. The runner does not resolve an unknown outcome inline.
import { hashFrozenRequest, type DispatchResult, type Intent } from "@nt/contracts";
import { majorityReader } from "@nt/db";
import { matchEvidence } from "@nt/recovery/pure";
import { quarantineReserved } from "./adopt.ts";
import { barrierAfterMs } from "./barrier.ts";
import { ProgrammerError } from "./errors.ts";
import { markDispatching } from "./lease.ts";
import { failNoEffect, markUnknown, quarantine } from "./outcomes.ts";
import { settle } from "./settle.ts";
import { hooksOf, type GatewayDeps } from "./types.ts";

/** True when frozen_request_sha256 equals the hash of the stored frozen request (and the request is valid). */
export function hashMatches(it: Intent): boolean {
  try {
    return hashFrozenRequest(it.frozen_request) === it.frozen_request_sha256;
  } catch {
    return false;
  }
}

const reread = async (deps: GatewayDeps, id: string) => {
  const cur = await majorityReader(deps.db.db, "intents").findOne({ _id: id });
  if (!cur) throw new ProgrammerError(`intent ${id} vanished`);
  return cur;
};

/** Calls the provider with the frozen bytes under the intent's key; a throw becomes INDETERMINATE. Writes nothing. */
export async function send(deps: GatewayDeps, it: Intent, armRequestSentBarrier: boolean): Promise<DispatchResult> {
  const provider = deps.providers[it.provider];
  if (!provider) return { kind: "INDETERMINATE", cause: "CONNECTION", detail: `no provider configured for ${it.provider}` };
  const hooks = hooksOf(deps);
  const cancel = armRequestSentBarrier ? barrierAfterMs("BR_DISPATCH_REQUEST_SENT", 100, it.effect_key, hooks.barrier) : () => {};
  try {
    return await provider.createPaymentOrRefund(it.frozen_request, { idempotencyKey: it.idempotency_key, timeoutMs: deps.config.dispatchTimeoutMs });
  } catch (e) {
    return { kind: "INDETERMINATE", cause: "CONNECTION", detail: `provider threw after the mark: ${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? String(e)}` };
  } finally {
    cancel();
  }
}

/** Applies a first-send result to a DISPATCHING intent at the epoch it holds. null from a transition → re-read (fenced). */
async function applyFirstSendResult(deps: GatewayDeps, it: Intent, res: DispatchResult): Promise<Intent | null> {
  switch (res.kind) {
    case "ACCEPTED": {
      const m = matchEvidence(it, [res.object]);
      if (m.kind === "MATCH") return settle(deps, it, { source: "RESPONSE", object: res.object, replayed: res.replayed }); // T3
      return quarantine(deps, it, "CONTRADICTORY_EVIDENCE", `accepted object rejected by the matcher: ${m.kind}${"why" in m ? ` ${m.why}` : ""}`, {
        kind: "ACCEPTED", cause: null, code: null, replayed: res.replayed, provider_object_id: res.object.id,
      }); // T13
    }
    case "REJECTED_DEFINITIVE":
      return failNoEffect(deps, it, { code: res.code, message: res.message, replayed: res.replayed }); // T4
    case "INDETERMINATE":
      return markUnknown(deps, it, { cause: res.cause, detail: res.detail }); // T5
    case "CONTRADICTION":
      return quarantine(deps, it, "CONTRADICTORY_EVIDENCE", `${res.code}: ${res.detail}`, {
        kind: "CONTRADICTION", cause: null, code: res.code, replayed: null, provider_object_id: null,
      }); // T13
  }
}

/** HANDOVER.md §10.4. Returns the intent as it stands afterwards. Sends nothing unless T2 committed for this call. */
export async function dispatch(deps: GatewayDeps, intentId: string, worker = deps.workerId): Promise<Intent> {
  const hooks = hooksOf(deps);
  const before = await reread(deps, intentId);
  if (before.state !== "RESERVED") return before;
  const mark = await markDispatching(deps, before, worker);
  if (mark.kind === "GUARD_FAILED") {
    await quarantineReserved(deps, intentId, mark.reason, mark.detail); // T11; nothing sent
    return reread(deps, intentId);
  }
  if (mark.kind === "CAS_MISS") return mark.current ?? reread(deps, intentId);
  const it = mark.intent;
  hooks.barrier("BR_DISPATCH_AFTER_MARK", it.effect_key);
  if (!hashMatches(it)) {
    await quarantine(deps, it, "CONTRADICTORY_EVIDENCE", "FROZEN_REQUEST_HASH_MISMATCH"); // nothing transmitted
    return reread(deps, intentId);
  }
  const res = await send(deps, it, true);
  hooks.barrier("BR_DISPATCH_RESPONSE_RECEIVED", it.effect_key);
  const after = await applyFirstSendResult(deps, it, res);
  return after ?? reread(deps, intentId);
}
