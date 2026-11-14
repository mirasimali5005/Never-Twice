// Policy loader (the ONLY file in this package allowed to read files) and the pure bundle check.
// HANDOVER.md §7.1, §7.3; AGENT_TASKS.md E2. Policy documents are data: amounts and citation strings live in them, not in code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApprPolicy, GoodwillPolicy, PolicyBundle, RegimePolicy } from "@nt/contracts";

export const STATUTORY_POLICY_ID = "APPR-SOR-2019-150@2022-09-08";
export const GOODWILL_POLICY_ID = "NT-GOODWILL@1";

/** Further rule tables (jurisdiction packs). Optional; the default bundle never includes them. */
export const EU261_POLICY_ID = "EU261-2004@2004-02-11";
export const REGIME_POLICY_IDS: readonly string[] = [EU261_POLICY_ID];

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export type PolicyIds = { statutory: string; goodwill: string };
export const DEFAULT_POLICY_IDS: PolicyIds = { statutory: STATUTORY_POLICY_ID, goodwill: GOODWILL_POLICY_ID };

/** Pure. Validates two policy documents (file contents or `policies` rows) against the contracts schemas and checks the ids.
 *  Rejects any id other than the two known policy versions (CLM-07a). */
export function parsePolicyBundle(statutoryDoc: unknown, goodwillDoc: unknown, ids: PolicyIds = DEFAULT_POLICY_IDS, regimeDocs: readonly unknown[] = []): PolicyBundle {
  if (ids.statutory !== STATUTORY_POLICY_ID) throw new PolicyError(`unknown statutory policy version ${JSON.stringify(ids.statutory)}`);
  if (ids.goodwill !== GOODWILL_POLICY_ID) throw new PolicyError(`unknown goodwill policy version ${JSON.stringify(ids.goodwill)}`);
  const statutory = ApprPolicy.safeParse(statutoryDoc);
  if (!statutory.success) throw new PolicyError(`statutory policy document invalid: ${statutory.error.message}`);
  const goodwill = GoodwillPolicy.safeParse(goodwillDoc);
  if (!goodwill.success) throw new PolicyError(`goodwill policy document invalid: ${goodwill.error.message}`);
  if (statutory.data._id !== ids.statutory) throw new PolicyError(`statutory policy _id ${statutory.data._id} is not ${ids.statutory}`);
  if (goodwill.data._id !== ids.goodwill) throw new PolicyError(`goodwill policy _id ${goodwill.data._id} is not ${ids.goodwill}`);
  if (`${statutory.data.policy_id}@${statutory.data.version}` !== statutory.data._id) throw new PolicyError("statutory policy _id differs from policy_id@version");
  if (`${goodwill.data.policy_id}@${goodwill.data.version}` !== goodwill.data._id) throw new PolicyError("goodwill policy _id differs from policy_id@version");
  const regimes: Record<string, RegimePolicy> = {};
  for (const doc of regimeDocs) {
    const r = RegimePolicy.safeParse(doc);
    if (!r.success) throw new PolicyError(`regime policy document invalid: ${r.error.message}`);
    if (!REGIME_POLICY_IDS.includes(r.data._id)) throw new PolicyError(`unknown regime policy version ${JSON.stringify(r.data._id)}`);
    if (`${r.data.policy_id}@${r.data.version}` !== r.data._id) throw new PolicyError("regime policy _id differs from policy_id@version");
    if (regimes[r.data.jurisdiction]) throw new PolicyError(`two regime policies for jurisdiction ${r.data.jurisdiction}`);
    regimes[r.data.jurisdiction] = r.data;
  }
  return PolicyBundle.parse({ statutory: statutory.data, goodwill: goodwill.data, ...(regimeDocs.length > 0 ? { regimes } : {}) });
}

/** Reads `<dir>/<id>.json` for both policies and validates them. The only function in this package that touches the file system.
 *  Throws PolicyError on an unknown version, a missing or unparseable file, or a schema failure. */
export function loadPolicyBundle(dir: string, ids: PolicyIds = DEFAULT_POLICY_IDS, regimeIds: readonly string[] = []): PolicyBundle {
  // Reject unknown versions before touching the disk.
  if (ids.statutory !== STATUTORY_POLICY_ID) throw new PolicyError(`unknown statutory policy version ${JSON.stringify(ids.statutory)}`);
  if (ids.goodwill !== GOODWILL_POLICY_ID) throw new PolicyError(`unknown goodwill policy version ${JSON.stringify(ids.goodwill)}`);
  const read = (id: string): unknown => {
    const path = join(dir, `${id}.json`);
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (e) {
      throw new PolicyError(`cannot read policy file ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  for (const id of regimeIds) if (!REGIME_POLICY_IDS.includes(id)) throw new PolicyError(`unknown regime policy version ${JSON.stringify(id)}`);
  return parsePolicyBundle(read(ids.statutory), read(ids.goodwill), ids, regimeIds.map(read));
}
