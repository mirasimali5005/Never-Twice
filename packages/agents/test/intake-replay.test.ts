// E3: intake in replay mode over the recorded cassettes (fixtures/cassettes), then the deterministic resolver, for every S1 claim.
// No model call is made: NT_MODEL_MODE=replay serves stored outputs and a miss is a failure. Truth is HANDOVER.md §7.4.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ClaimIndex, OpsRecord } from "@nt/contracts";
import { createModelClient } from "../src/model/index.ts";
import { extractClaim, type IntakeResult } from "../src/intake/intake.ts";
import { resolve, type Resolution } from "../src/intake/resolve.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const client = createModelClient({ NT_MODEL: undefined, NT_MODEL_MODE: "replay", NT_MODEL_BACKEND: "cli", NT_MODEL_CASSETTE_DIR: join(root, "fixtures/cassettes") });

type Truth = { booking_ref: string; passenger_ids: string[] } | { held: "BOOKING_UNRESOLVED" };
const TRUTH: Record<string, Truth> = {
  C01: { booking_ref: "QK7R2M", passenger_ids: ["P01"] },
  C02: { booking_ref: "ZT4H9X", passenger_ids: ["P02"] },
  C03: { booking_ref: "ZT4H9X", passenger_ids: ["P02"] },
  C04: { booking_ref: "LM2P8D", passenger_ids: ["P03"] },
  C05: { booking_ref: "HV9C3T", passenger_ids: ["P04"] },
  C06: { booking_ref: "RW6N1K", passenger_ids: ["P05", "P06", "P07"] },
  C07: { booking_ref: "DX3F7Q", passenger_ids: ["P08"] },
  C08: { booking_ref: "DX3F7Q", passenger_ids: ["P08"] },
  C09: { booking_ref: "NB5J2W", passenger_ids: ["P09"] },
  C10: { booking_ref: "GT8K4S", passenger_ids: ["P10"] },
  C11: { booking_ref: "PC1D6V", passenger_ids: ["P11"] },
  C12: { booking_ref: "YE7M3A", passenger_ids: ["P12"] },
  C13: { booking_ref: "KS2R9B", passenger_ids: ["P13"] },
  C14: { booking_ref: "UF4T8N", passenger_ids: ["P14"] },
  C15: { booking_ref: "AJ6W5L", passenger_ids: ["P15"] },
  C16: { booking_ref: "MV3X1C", passenger_ids: ["P16"] },
  C17: { held: "BOOKING_UNRESOLVED" },
};

const ops = OpsRecord.parse(JSON.parse(readFileSync(join(root, "fixtures/scenarios/S1/ops-record.json"), "utf8")));
const dates = new Map(ops.flights.map((f) => [f.flight_no, f.scheduled_departure_local_date]));
const bookings = ops.bookings.map((b) => ({ ...b, flight_date: dates.get(b.flight_no) }));
const index = ClaimIndex.parse(JSON.parse(readFileSync(join(root, "fixtures/scenarios/S1/claims/index.json"), "utf8")));

const extracted = new Map<string, Extract<IntakeResult, { kind: "EXTRACTED" }>>();
const resolved = new Map<string, Resolution>();

beforeAll(async () => {
  for (const c of index) {
    const text = readFileSync(join(root, "fixtures/scenarios/S1/claims", c.file), "utf8");
    const r = await extractClaim(client, { claim_id: c.claim_id, channel: c.channel, text });
    if (r.kind === "EXTRACTED") {
      extracted.set(c.claim_id, r);
      resolved.set(c.claim_id, resolve(r.extraction, bookings, { claim_id: c.claim_id, channel: c.channel, received_at: c.received_at }));
    }
  }
  const lines = index.map((c) => {
    const r = resolved.get(c.claim_id);
    const got = !r ? "EXTRACTION_FAILED" : r.kind === "RESOLVED" ? `${r.booking_ref} / ${r.passenger_ids.join(",")} (${r.method})` : `HELD ${r.reason_code}`;
    const t = TRUTH[c.claim_id]!;
    return `| ${c.claim_id} | ${"held" in t ? `HELD ${t.held}` : `${t.booking_ref} / ${t.passenger_ids.join(",")}`} | ${got} |`;
  });
  console.log(["| claim | truth (HANDOVER 7.4) | replay result |", "|---|---|---|", ...lines].join("\n"));
});

describe("intake replay over the recorded S1 cassettes", () => {
  it("runs in replay mode and every claim extracts from a cassette", () => {
    expect(client.mode).toBe("replay");
    expect(extracted.size).toBe(17);
    for (const r of extracted.values()) {
      expect(r.source).toBe("cassette");
      expect(r.attempts).toBe(1);
    }
  });

  it.each(Object.keys(TRUTH))("%s resolves to its HANDOVER §7.4 truth", (id) => {
    const r = resolved.get(id);
    const t = TRUTH[id]!;
    expect(r).toBeDefined();
    if ("held" in t) expect(r).toMatchObject({ kind: "HELD", reason_code: t.held });
    else expect(r).toMatchObject({ kind: "RESOLVED", booking_ref: t.booking_ref, passenger_ids: t.passenger_ids });
  });

  it("C02 and C03 are the same entitlement (one booking, one passenger)", () => {
    const a = resolved.get("C02");
    const b = resolved.get("C03");
    expect(a?.kind === "RESOLVED" && b?.kind === "RESOLVED" && a.booking_ref === b.booking_ref && a.passenger_ids[0] === b.passenger_ids[0]).toBe(true);
  });

  it("C08 has payee_change_request true, with a verbatim quote; C07 does not", () => {
    const c8 = extracted.get("C08")!.extraction;
    expect(c8.payee_change_request.requested).toBe(true);
    expect(c8.payee_change_request.quote).not.toBeNull();
    expect(resolved.get("C08")).toMatchObject({ kind: "RESOLVED", flags: { payeeChangeRequested: true } });
    expect(extracted.get("C07")!.extraction.payee_change_request.requested).toBe(false);
  });

  it("C01 hardship is MOBILITY_ASSIST; C06 is OVERNIGHT_STRANDED", () => {
    expect(extracted.get("C01")!.extraction.hardship.kind).toBe("MOBILITY_ASSIST");
    expect(extracted.get("C06")!.extraction.hardship.kind).toBe("OVERNIGHT_STRANDED");
    expect(resolved.get("C01")).toMatchObject({ kind: "RESOLVED", flags: { goodwillProposed: "MOBILITY_ASSIST" } });
    expect(resolved.get("C06")).toMatchObject({ kind: "RESOLVED", flags: { goodwillProposed: "OVERNIGHT_STRANDED" } });
  });

  it("C17 has injection_suspected and is held BOOKING_UNRESOLVED, not CLAIM_TEXT_SUSPICIOUS", () => {
    expect(extracted.get("C17")!.extraction.injection_suspected).toBe(true);
    expect(resolved.get("C17")).toMatchObject({ kind: "HELD", reason_code: "BOOKING_UNRESOLVED" });
  });

  it("no other claim is flagged as an injection", () => {
    const flagged = [...extracted].filter(([, r]) => r.extraction.injection_suspected).map(([id]) => id);
    expect(flagged).toEqual(["C17"]);
  });

  it("C12 is in French", () => {
    expect(extracted.get("C12")!.extraction.language).toBe("fr");
  });

  it("every kept quote is a verbatim substring of its claim and none was discarded", () => {
    for (const [id, r] of extracted) expect(r.discarded_quotes, id).toEqual([]);
  });
});
