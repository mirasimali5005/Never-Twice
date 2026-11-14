// F2-INT-01: ledger-sim.ts follows pagination and sends Authorization: Bearer, against a stub node:http server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simLedgerSource } from "../src/ledger-sim.ts";
import { LedgerError } from "../src/ledger.ts";
import { stubSim, simObj } from "./fixtures/stub-sim.ts";


test("reads every page of acct_<run_id> with the Bearer read key, GET only", async () => {
  const objs = [1, 2, 3, 4, 5].map((i) => simObj("acct_r7k2m9qa", `po_${i}`, `K${i}.P0${i}.NT101-20261110.APPR_DELAY`, 100 * i, `payee_P0${i}`));
  objs.push(simObj("acct_rother01", "po_x", null, 1, "payee_X"));
  const sim = await stubSim(objs, "readkey", 2);
  try {
    const got = await simLedgerSource({ baseUrl: sim.url, readKey: "readkey" }).readAll("r7k2m9qa");
    assert.deepEqual(got.map((o) => o.id), ["po_1", "po_2", "po_3", "po_4", "po_5"]);
    assert.equal(sim.seen.length, 3);
    assert.ok(sim.seen.every((s) => s.auth === "Bearer readkey" && s.method === "GET" && s.url.includes("account=acct_r7k2m9qa")));
    assert.ok(sim.seen[1].url.includes("starting_after=po_2"));
    assert.equal(got[0].metadata.nt_effect_key, "K1.P01.NT101-20261110.APPR_DELAY");
    assert.equal(got[0].source, "sim");
  } finally { await sim.close(); }
});

test("wrong key, unreachable endpoint and missing configuration are LedgerErrors", async () => {
  const sim = await stubSim([], "readkey");
  try {
    await assert.rejects(simLedgerSource({ baseUrl: sim.url, readKey: "wrong" }).readAll("r7k2m9qa"), LedgerError);
  } finally { await sim.close(); }
  await assert.rejects(simLedgerSource({ baseUrl: "http://127.0.0.1:9", readKey: "k", timeoutMs: 2000 }).readAll("r7k2m9qa"), LedgerError);
  assert.throws(() => simLedgerSource({ baseUrl: "", readKey: "k" }), LedgerError);
  assert.throws(() => simLedgerSource({ baseUrl: "http://x", readKey: "" }), LedgerError);
});
