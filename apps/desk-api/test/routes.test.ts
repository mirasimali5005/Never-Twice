// G1 routes that never need a database: malformed ids are unknown ids, other methods are 405, nothing is touched first.
import { describe, expect, it } from "vitest";
import { createApp } from "../src/routes.ts";

const boom = async () => {
  throw new Error("the database must not be opened for a malformed id");
};
const app = createApp(boom);

describe("routes without a database", () => {
  it("a malformed run id is UNKNOWN_RUN before any database access", async () => {
    for (const p of ["summary", "claims", "claims/C02", "payments", "payments/X.Y.Z.W", "provider-statement", "pool", "certificate", "events"]) {
      const res = await app.request(`/api/runs/..%2F..%2Fsecret/${p}`);
      expect(res.status, p).toBe(404);
      expect(await res.json()).toEqual({ error: "UNKNOWN_RUN" });
    }
  });
  it("a malformed group id is UNKNOWN_GROUP", async () => {
    const res = await app.request("/api/groups/x");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "UNKNOWN_GROUP" });
  });
  it("every method but GET is 405", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const p of ["/api/groups/g4x8p2nd", "/api/runs/r7k2m9qa/summary", "/api/runs/r7k2m9qa/events", "/nowhere"]) {
        const res = await app.request(p, { method });
        expect(res.status, `${method} ${p}`).toBe(405);
        expect(await res.json()).toEqual({ error: "METHOD_NOT_ALLOWED" });
      }
    }
  });
  it("a database that cannot be opened is 503 DATABASE_UNAVAILABLE, and a non-driver bug is a bare 500", async () => {
    const down = createApp(async () => {
      const e = new Error("x");
      e.name = "MongoNetworkError";
      throw e;
    });
    const r = await down.request("/api/runs/r7k2m9qa/summary");
    expect([r.status, await r.json()]).toEqual([503, { error: "DATABASE_UNAVAILABLE" }]);
    const bug = createApp(async () => {
      throw new Error("secret detail");
    });
    const b = await bug.request("/api/runs/r7k2m9qa/summary");
    expect([b.status, await b.json()]).toEqual([500, { error: "INTERNAL_ERROR" }]);
  });
});
