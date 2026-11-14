// F1-UNIT-01: band boundaries in the auditor's own APPR table (EVL-14; same six inputs as CLM-13).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  delayCompensationMinor, deniedBoardingCompensationMinor, refundCompensationMinor, goodwillMinor, NOTICE_LIMIT_MINUTES,
} from "../src/appr-table.ts";

test("large carrier delay boundaries 179/180/359/360/539/540", () => {
  assert.equal(delayCompensationMinor("LARGE", 179), null);
  assert.equal(delayCompensationMinor("LARGE", 180), 40000);
  assert.equal(delayCompensationMinor("LARGE", 359), 40000);
  assert.equal(delayCompensationMinor("LARGE", 360), 70000);
  assert.equal(delayCompensationMinor("LARGE", 539), 70000);
  assert.equal(delayCompensationMinor("LARGE", 540), 100000);
  assert.equal(delayCompensationMinor("LARGE", 0), null);
});

test("small carrier delay bands 125/250/500", () => {
  assert.equal(delayCompensationMinor("SMALL", 179), null);
  assert.equal(delayCompensationMinor("SMALL", 180), 12500);
  assert.equal(delayCompensationMinor("SMALL", 360), 25000);
  assert.equal(delayCompensationMinor("SMALL", 540), 50000);
});

test("denied boarding bands 900/1800/2400 with thresholds 360 and 540", () => {
  assert.equal(deniedBoardingCompensationMinor(0), 90000);
  assert.equal(deniedBoardingCompensationMinor(359), 90000);
  assert.equal(deniedBoardingCompensationMinor(360), 180000);
  assert.equal(deniedBoardingCompensationMinor(539), 180000);
  assert.equal(deniedBoardingCompensationMinor(540), 240000);
});

test("refund compensation, goodwill tariff, notice limit", () => {
  assert.equal(refundCompensationMinor("LARGE"), 40000);
  assert.equal(refundCompensationMinor("SMALL"), 12500);
  assert.equal(goodwillMinor(["OVERNIGHT_STRANDED"]), 15000);
  assert.equal(goodwillMinor(["MOBILITY_ASSIST"]), 20000);
  assert.equal(goodwillMinor([]), null);
  assert.equal(NOTICE_LIMIT_MINUTES, 20160);
});

test("amounts are integers and bad minutes are rejected", () => {
  for (const m of [180, 360, 540, 1000]) assert.ok(Number.isInteger(delayCompensationMinor("LARGE", m)));
  assert.throws(() => delayCompensationMinor("LARGE", 1.5));
  assert.throws(() => delayCompensationMinor("LARGE", -1));
});
