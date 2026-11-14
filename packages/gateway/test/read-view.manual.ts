// Manual check (not a vitest file) of readOnlyProviderView against the running simulator. Usage:
//   node --env-file=.env packages/gateway/test/read-view.manual.ts <run_id>
import { readOnlyProviderView } from "../src/index.ts";
const runId = process.argv[2]!;
const view = await readOnlyProviderView("sim_payout", { ...process.env, NT_RUN_ID: runId });
console.log("keys:", Object.keys(view).sort().join(", "));
console.log("has createPaymentOrRefund:", "createPaymentOrRefund" in view);
console.log("capabilities:", JSON.stringify(view.capabilities));
const account = `acct_${runId}`;
const ev = await view.findOperationEvidence({ account, payeeRef: "payee_P02", parentRef: null, since: new Date(Date.now() - 3600_000) });
console.log("findOperationEvidence:", ev.complete, ev.records.map((r) => `${r.id} ${r.metadata["nt_marker"]}`));
const s = await view.searchOperations!({ account, marker: `${runId}:ZT4H9X.P02.NT101-20261110.APPR_DELAY` });
console.log("searchOperations:", s.map((r) => r.id));
console.log("listEvents:", JSON.stringify(await view.listEvents!({ account })));
