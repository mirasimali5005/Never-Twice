// G1 static boundary checks on the desk API's own source: no write credential, no write operation, no forbidden path.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadDeskEnv } from "../src/env.ts";
import { parseEnv } from "@nt/contracts";

const SRC = path.resolve(import.meta.dirname, "../src");
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const code = (f: string) =>
  readFileSync(path.join(SRC, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("desk-api source", () => {
  it("has the files the packet names", () => {
    for (const f of ["server.ts", "routes.ts", "sse.ts", "read-model.ts", "provider-statement.ts", "certificate-file.ts", "env.ts"]) expect(files).toContain(f);
  });

  it("references no write credential, no model key and no EVAL_ name", () => {
    for (const f of files) {
      const c = code(f);
      for (const name of ["NT_SIM_WRITE_KEY", "NT_SIM_ADMIN_KEY", "NT_SIM_EVAL_READ_KEY", "STRIPE_SECRET_KEY", "ANTHROPIC_API_KEY", "VOYAGE_API_KEY", "NT_MONGODB_URI_GATEWAY", "NT_MONGODB_URI_AGENT"]) {
        expect(c, `${f} mentions ${name}`).not.toContain(name);
      }
      expect(c, `${f} mentions an EVAL_ variable`).not.toMatch(/\bEVAL_/);
    }
  });

  it("calls no database write method and no file write", () => {
    const writes = /\.(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|findOneAndReplace|findOneAndDelete|bulkWrite|drop|dropIndex|createIndex|createCollection|renameCollection)\s*\(/;
    const fsWrites = /\b(writeFile|appendFile|unlink|rename|rmdir|mkdir|createWriteStream|copyFile)\b|\brm\s*\(/;
    for (const f of files) {
      expect(code(f), `${f} calls a database write`).not.toMatch(writes);
      expect(code(f), `${f} writes a file`).not.toMatch(fsWrites);
    }
  });

  it("registers no route but GET (and the catch-all that answers 405)", () => {
    const c = code("routes.ts");
    expect(c).not.toMatch(/app\.(post|put|patch|delete)\s*\(/);
    expect(c).toContain("METHOD_NOT_ALLOWED");
  });

  it("reads evaluator/out only for the certificate and the commitment; never hidden truth or the manifest", () => {
    for (const f of files) {
      expect(code(f), f).not.toMatch(/hidden/);
      expect(code(f), f).not.toMatch(/\.manifest\.json/);
    }
    const c = code("certificate-file.ts");
    expect([...c.matchAll(/\.(certificate|commitment)\.json/g)].map((m) => m[1]).sort()).toEqual(["certificate", "commitment"]);
  });

  it("imports no provider package, no gateway and no agents package", () => {
    for (const f of files) expect(code(f), f).not.toMatch(/from\s+"@nt\/(providers|gateway|agents|recovery|baselines|rules)/);
  });

  it("the process environment is validated through the desk-api role, which drops every write key", () => {
    const r = parseEnv("desk-api", {
      NT_ENV: "local",
      NT_MONGODB_URI: "mongodb://localhost:27017",
      NT_MONGODB_URI_DESK: "mongodb://desk@localhost:27017",
      NT_SIM_READ_KEY: "read",
      NT_SIM_WRITE_KEY: "write",
      NT_SIM_ADMIN_KEY: "admin",
      ANTHROPIC_API_KEY: "model",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.env).sort()).toEqual(["NT_DB_NAME", "NT_ENV", "NT_MONGODB_URI_DESK", "NT_SIM_READ_KEY", "NT_SIM_URL"]);
      expect(JSON.stringify(r.env)).not.toMatch(/write|admin|model/);
    }
    expect(typeof loadDeskEnv).toBe("function");
  });
});
