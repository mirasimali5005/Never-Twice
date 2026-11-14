// Unit tests for the error classifiers and the role URI fallback (no database).
import { describe, expect, it } from "vitest";
import { MongoServerError } from "mongodb";
import { isDuplicateKey, isUnknownCommitResult, UNKNOWN_COMMIT_LABEL } from "../src/txn.ts";
import { dbNameFrom, uriFor } from "../src/client.ts";

describe("isDuplicateKey", () => {
  it("recognises 11000 directly, in writeErrors and as a cause", () => {
    expect(isDuplicateKey(new MongoServerError({ message: "E11000", code: 11000 }))).toBe(true);
    expect(isDuplicateKey({ writeErrors: [{ code: 11000 }] })).toBe(true);
    expect(isDuplicateKey(new Error("wrapped", { cause: new MongoServerError({ message: "E11000", code: 11000 }) }))).toBe(true);
    expect(isDuplicateKey(new MongoServerError({ message: "WriteConflict", code: 112 }))).toBe(false);
    expect(isDuplicateKey(null)).toBe(false);
  });
});

describe("isUnknownCommitResult", () => {
  it("is true only for the driver label", () => {
    expect(UNKNOWN_COMMIT_LABEL).toBe("UnknownTransactionCommitResult");
    const e = new MongoServerError({ message: "x", code: 50, errorLabels: ["UnknownTransactionCommitResult"] });
    expect(isUnknownCommitResult(e)).toBe(true);
    const t = new MongoServerError({ message: "x", code: 112, errorLabels: ["TransientTransactionError"] });
    expect(isUnknownCommitResult(t)).toBe(false);
    expect(isUnknownCommitResult(new Error("x"))).toBe(false);
  });
});

describe("role URIs", () => {
  it("fall back to NT_MONGODB_URI when a role variable is unset or empty", () => {
    const env = { NT_MONGODB_URI: "mongodb://owner", NT_MONGODB_URI_GATEWAY: "mongodb://gw", NT_MONGODB_URI_DESK: "" };
    expect(uriFor("gateway", env)).toBe("mongodb://gw");
    expect(uriFor("desk", env)).toBe("mongodb://owner");
    expect(uriFor("agent", env)).toBe("mongodb://owner");
    expect(uriFor("default", env)).toBe("mongodb://owner");
    expect(() => uriFor("default", {})).toThrow(/NT_MONGODB_URI is not set/);
    expect(dbNameFrom({})).toBe("never_twice");
    expect(dbNameFrom({ NT_DB_NAME: "x" })).toBe("x");
  });
});
