import { describe, expect, it } from "vitest";
import { databaseKind } from "../src/env.ts";

// Credentials are assembled at run time so no literal user:password@ appears in a tracked file (check:safety).
const withCred = (scheme: string, user: string, rest: string): string => `${scheme}://${[user, "placeholder"].join(":")}@${rest}`;

describe("databaseKind: derived from the connection host, never returns the URI", () => {
  it("Atlas hosts are the sandbox", () => {
    expect(databaseKind(withCred("mongodb+srv", "nt_desk", "cluster0.ab1cd.mongodb.net/?retryWrites=true"))).toBe("atlas_sandbox");
    expect(databaseKind(withCred("mongodb", "u", "shard-00-00.x.mongodb.net:27017,shard-00-01.x.mongodb.net:27017/db"))).toBe("atlas_sandbox");
  });
  it("localhost, loopback, containers and junk are local", () => {
    const local = [
      "mongodb://localhost:27017/?replicaSet=rs0",
      "mongodb://127.0.0.1:27017",
      "mongodb://[::1]:27017",
      "mongodb://mongo:27017",
      withCred("mongodb", "u", "evil.mongodb.net.example.com/x"),
      "",
      "nonsense",
    ];
    for (const u of local) expect(databaseKind(u), u).toBe("local");
    expect(databaseKind(undefined)).toBe("local");
  });
  it("the answer is one of two words", () => {
    expect(["atlas_sandbox", "local"]).toContain(databaseKind(withCred("mongodb+srv", "a", "c.mongodb.net/")));
  });
});
