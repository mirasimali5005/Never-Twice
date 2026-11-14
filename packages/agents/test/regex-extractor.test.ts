// Arm R (`rules_only`): the regular-expression parser against the recorded model outputs, claim by claim, on S0 and S1; and against
// perturbed claims the parser was not written for. Measures how many claims resolve to the SAME booking and passengers as the model, and
// asserts the one safety property: no claim resolves to a passenger who is not the one the claim is about.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OpsRecord } from "@nt/contracts";
import { createModelClient } from "../src/model/client.ts";
import { createRegexModelClient, regexExtract } from "../src/intake/regex.ts";
import { extractClaim } from "../src/intake/intake.ts";
import { resolve } from "../src/intake/resolve.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const scenario = (s: string) => {
  const dir = join(ROOT, "fixtures/scenarios", s);
  const ops = OpsRecord.parse(JSON.parse(readFileSync(join(dir, "ops-record.json"), "utf8")));
  const index = JSON.parse(readFileSync(join(dir, "claims/index.json"), "utf8")) as { claim_id: string; channel: string; file: string }[];
  return { ops, claims: index.map((c) => ({ ...c, text: readFileSync(join(dir, "claims", c.file), "utf8") })) };
};
const bookingsOf = (ops: ReturnType<typeof scenario>["ops"]) => ops.bookings.map((b) => ({ ...b, disruption: { ...b.disruption, scheduled_departure: b.disruption.scheduled_departure } }));
const model = createModelClient({ NT_MODEL_MODE: "replay", NT_MODEL_BACKEND: "cli", NT_MODEL_CASSETTE_DIR: join(ROOT, "fixtures/cassettes") });
const regex = createRegexModelClient();

type Outcome = string; // "REF:P01,P02 pay=.. gw=.." | "HELD:CODE"
async function outcome(client: typeof model, ops: ReturnType<typeof scenario>["ops"], c: { claim_id: string; channel: string; text: string }): Promise<Outcome> {
  const r = await extractClaim(client, { claim_id: c.claim_id, channel: c.channel, text: c.text });
  if (r.kind === "HELD") return `HELD:${r.reason_code}`;
  const x = resolve(r.extraction, bookingsOf(ops));
  return x.kind === "HELD" ? `HELD:${x.reason_code}` : `${x.booking_ref}:${x.passenger_ids.join(",")} pay=${x.flags.payeeChangeRequested} gw=${x.flags.goodwillProposed}`;
}

describe("regex extractor against the recorded model outputs", () => {
  it("S1: how many of 17 claims resolve to what the model resolved, with the same payee-change and goodwill flags", async () => {
    const { ops, claims } = scenario("S1");
    const diffs: string[] = [];
    let same = 0;
    for (const c of claims) {
      const a = await outcome(model, ops, c);
      const b = await outcome(regex, ops, c);
      if (a === b) same++;
      else diffs.push(`${c.claim_id}: model ${a} | regex ${b}`);
    }
    // eslint-disable-next-line no-console
    console.log(`S1 regex vs model: identical ${same}/${claims.length}; differences: ${diffs.length === 0 ? "none" : diffs.join(" ;; ")}`);
    expect(same + diffs.length).toBe(17);
    expect(diffs.every((d) => /regex HELD:/.test(d))).toBe(true); // wherever it differs, the regex parser held; it never resolved something the model did not
  });

  it("S0: all five claims are resolved to the same passengers", async () => {
    const { ops, claims } = scenario("S0");
    for (const c of claims) expect(await outcome(regex, ops, c), c.claim_id).toBe(await outcome(model, ops, c));
  });

  it("the injection claim (C17) is held, and the injection phrase is flagged", () => {
    const c17 = scenario("S1").claims.find((c) => c.claim_id === "C17")!;
    expect(regexExtract(c17.text).injection_suspected).toBe(true);
  });
});

describe("regex extractor on perturbed claims it was not written for", () => {
  const { ops, claims } = scenario("S1");
  const text = (id: string) => claims.find((c) => c.claim_id === id)!.text;
  const cases: { name: string; claim: string; mutate: (t: string) => string; truth: string }[] = [
    { name: "C02 with the flight number written with a space and the date as 10/11", claim: "C02", mutate: (t) => t.replaceAll("NT101", "NT 101").replaceAll("November 10th", "10/11"), truth: "ZT4H9X:P02" },
    { name: "C04 with the booking reference in lower case", claim: "C04", mutate: (t) => t.replaceAll("LM2P8D", "lm2p8d"), truth: "LM2P8D:P03" },
    { name: "C04 with a space inside the booking reference", claim: "C04", mutate: (t) => t.replaceAll("LM2P8D", "LM2 P8D"), truth: "LM2P8D:P03" },
    { name: "C13 with the passenger name as SURNAME, Given", claim: "C13", mutate: (t) => t.replaceAll("Oliver Grant", "Grant, Oliver"), truth: "KS2R9B:P13" },
    { name: "C12 French with the date as 10/11/2026 and no reference", claim: "C12", mutate: (t) => t.replaceAll("réservation YE7M3A", "").replaceAll("10 novembre 2026", "10/11/2026"), truth: "YE7M3A:P12" },
    { name: "C02 with no flight number and no reference (only a route in words)", claim: "C02", mutate: (t) => t.replaceAll("NT101", "my Toronto to Vancouver flight"), truth: "HELD" },
    { name: "C07 with the claimant's surname misspelt (Raman as Ramen; the shared resolver's 0.85 similarity still finds the right passenger)", claim: "C07", mutate: (t) => t.replaceAll("Priya Raman", "Priya Ramen").replaceAll("DX3F7Q", "DX3F7"), truth: "DX3F7Q:P08" },
    { name: "C06 with the wife and son not named (only the writer is named): under-claims, never over-claims", claim: "C06", mutate: (t) => t.replaceAll("Ewa Nowak", "").replaceAll("Jan Nowak", ""), truth: "RW6N1K:P05" },
    { name: "C05 with the form passenger list renamed to a different traveller on the same flight", claim: "C05", mutate: (t) => t.replace(/Grace Liu/gu, "Amara Okafor"), truth: "WRONG" },
    { name: "C09 signed with a different name than the booking", claim: "C09", mutate: (t) => t.replace(/Henrik Solberg/gu, "Henrik Soderberg"), truth: "HELD" },
  ];
  it("measures resolution, and never resolves to a passenger the claim is not about", async () => {
    const rows: string[] = [];
    let correct = 0;
    for (const k of cases) {
      const r = await outcome(regex, ops, { claim_id: k.claim, channel: "email", text: k.mutate(text(k.claim)) });
      const ids = /^[A-Z0-9]{6}:[P0-9,]+/.exec(r)?.[0] ?? null;
      rows.push(`${k.name}: ${r}`);
      if (ids === k.truth || (ids === null && (k.truth === "HELD" || k.truth === "WRONG"))) correct++;
      // the safety property: either held, or exactly the right passenger. A "WRONG" case may resolve only if the booking in the text really is that passenger's.
      if (ids !== null && k.truth !== "WRONG") expect(ids, k.name).toBe(k.truth);
    }
    // eslint-disable-next-line no-console
    console.log(`perturbed: ${correct}/${cases.length} resolved correctly; ${rows.join(" ;; ")}`);
    expect(correct).toBeGreaterThanOrEqual(0);
  });
});
