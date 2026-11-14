// The task A3 fixture files parse against these schemas. Skipped when fixtures/ is absent (e.g. before A3 is merged).
// NT_FIXTURES_DIR overrides the location (used to run this from a worktree that does not hold the files).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprPolicy, ClaimIndex, FaultSchedule, GoodwillPolicy, OpsRecord, disruptionId, effectKey } from "../src/index.ts";

const root = process.env["NT_FIXTURES_DIR"] ?? resolve(import.meta.dirname, "../../../fixtures");
const read = (p: string): unknown => JSON.parse(readFileSync(join(root, p), "utf8"));

describe.skipIf(!existsSync(join(root, "scenarios")))("fixture files", () => {
  for (const s of ["S0", "S1"]) {
    it(`${s} ops record and claims index parse`, () => {
      const ops = OpsRecord.parse(read(`scenarios/${s}/ops-record.json`));
      expect(ops.scenario).toBe(s);
      ClaimIndex.parse(read(`scenarios/${s}/claims/index.json`));
      // Every booking yields a valid effect key from its own record, and its disruption id agrees with the derived one.
      for (const b of ops.bookings) {
        const d = disruptionId(b.flight_no, new Date(b.disruption.scheduled_departure));
        expect(b.disruption.disruption_id).toBe(d);
        expect(() => effectKey({ booking_ref: b.booking_ref, passenger_id: b.passenger_id, disruption_id: d }, "APPR_DELAY")).not.toThrow();
        expect(b.passenger.passenger_id).toBe(b.passenger_id);
      }
    });
  }

  it("S0 holds P02, P03, P04, P11, P13", () => {
    const ops = OpsRecord.parse(read("scenarios/S0/ops-record.json"));
    expect(ops.bookings.map((b) => b.passenger_id).sort()).toEqual(["P02", "P03", "P04", "P11", "P13"]);
  });

  it("every fault file parses", () => {
    const files = readdirSync(join(root, "faults")).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) FaultSchedule.parse(read(`faults/${f}`));
  });

  it("both policy files parse", () => {
    ApprPolicy.parse(read("policies/APPR-SOR-2019-150@2022-09-08.json"));
    GoodwillPolicy.parse(read("policies/NT-GOODWILL@1.json"));
  });
});
