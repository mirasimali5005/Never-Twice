import { describe, expect, it } from "vitest";
import { databaseKind } from "../src/env.ts";

describe("databaseKind: derived from the connection host, never returns the URI", () => {
  it("Atlas hosts are the sandbox", () => {
    expect(databaseKind("mongodb+srv://nt_desk:s3cret@cluster0.ab1cd.mongodb.net/?retryWrites=true")).toBe("atlas_sandbox");
    expect(databaseKind("mongodb://u:p@shard-00-00.x.mongodb.net:27017,shard-00-01.x.mongodb.net:27017/db")).toBe("atlas_sandbox");
  });
  it("localhost, loopback, containers and junk are local", () => {
    for (const u of ["mongodb://localhost:27017/?replicaSet=rs0", "mongodb://127.0.0.1:27017", "mongodb://[::1]:27017", "mongodb://mongo:27017", "mongodb://u:p@evil.mongodb.net.example.com/x", "", "nonsense"]) {
      expect(databaseKind(u), u).toBe("local");
    }
    expect(databaseKind(undefined)).toBe("local");
  });
  it("the answer is one of two words", () => {
    expect(["atlas_sandbox", "local"]).toContain(databaseKind("mongodb+srv://a:b@c.mongodb.net/"));
  });
});
