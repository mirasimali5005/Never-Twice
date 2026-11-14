// Probe admission (HANDOVER.md §11.4; TEST_PLAN PRB-01..07). FIXED CODE: the model never decides whether its probe is admitted.
//   Static checks (before any request): the spec is for this tool and this schema hash; method GET; host and path on the allow-list
//   (the tool's own GET endpoints on the configured provider origin); only the read credential; no headers; every template draws on
//   an intent field; JSONPaths in the supported subset; 1 <= max_pages <= 10.
//   Canaries, in scratch simulator accounts with planted ground truth (admin key for setup only; the probe runs with the read key):
//     (1) found_immediately    a planted message is found right after it is written (the lagging search fails here)
//     (2) decoy_ignored        with only a decoy carrying a different marker, the probe returns nothing
//     (3) paginated            the target behind 30 decoys is found (the list endpoint caps a page at 20)
//     (4) state_hash_unchanged the simulator state hash is the same before and after every probe run
// Admission is a test, not a proof.
import { randomBytes } from "node:crypto";
import type { QuarantineReason } from "@nt/contracts";
import { executeProbe } from "./run.ts";
import type { ProbeConnection, ProbeRun } from "./run.ts";
import { isIntentField, parsePath, probeId, templateNames, toolSchemaHash } from "./spec.ts";
import type { ProbeContext, ProbeSpec, ToolDescription } from "./spec.ts";

// ------------------------------------------------------------------------------------------------------------- static checks

export type StaticCheck = "TOOL" | "SCHEMA_HASH" | "METHOD" | "HOST" | "PATH" | "CREDENTIAL" | "HEADERS" | "TEMPLATE" | "JSONPATH" | "PAGINATION";
export type StaticVerdict = { ok: true } | { ok: false; check: StaticCheck; reason: string };

export type AdmissionPolicy = {
  tool: ToolDescription;
  /** Allowed provider origins, e.g. ["http://127.0.0.1:4010"]. */
  allowedOrigins: string[];
};

/** The tool's documented GET endpoints, as path regexes ({id} matches one segment). */
function allowedPaths(tool: ToolDescription): RegExp[] {
  return tool.endpoints
    .filter((e) => e.method.toUpperCase() === "GET")
    .map((e) => new RegExp("^" + e.path.split(/\{[^}]+\}/).map((p) => p.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("[^/{}]+") + "$"));
}

export function staticCheck(spec: ProbeSpec, policy: AdmissionPolicy): StaticVerdict {
  const no = (check: StaticCheck, reason: string): StaticVerdict => ({ ok: false, check, reason });
  const { tool } = policy;
  if (spec.tool_id !== tool.tool_id) return no("TOOL", `spec is for ${spec.tool_id}, not ${tool.tool_id}`);
  if (spec.schema_hash !== toolSchemaHash(tool)) return no("SCHEMA_HASH", "spec was written against a different tool schema");
  if (spec.request.method !== "GET") return no("METHOD", `method ${spec.request.method} is not GET`);
  if (spec.request.credential !== "read") return no("CREDENTIAL", `credential "${spec.request.credential}" is not the read credential`);
  if (spec.request.headers && Object.keys(spec.request.headers).length > 0) {
    return no("HEADERS", `extra headers are not allowed (${Object.keys(spec.request.headers).join(", ")}); only the read credential is attached`);
  }
  const rawPath = spec.request.path;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) || rawPath.startsWith("//")) {
    let origin: string;
    try {
      origin = new URL(rawPath).origin;
    } catch {
      return no("HOST", "unparseable URL");
    }
    if (!policy.allowedOrigins.includes(origin)) return no("HOST", `host ${origin} is not on the allow-list`);
  }
  let pathname: string;
  try {
    const base = policy.allowedOrigins[0] ?? "http://127.0.0.1";
    const u = new URL(rawPath, base);
    if (!policy.allowedOrigins.includes(u.origin)) return no("HOST", `host ${u.origin} is not on the allow-list`);
    if (u.search !== "" || u.hash !== "") return no("PATH", "query parameters belong in request.query, not in the path");
    pathname = u.pathname;
  } catch {
    return no("PATH", "unparseable path");
  }
  if (rawPath.includes("{{") || rawPath.includes("..")) return no("PATH", "the path may not contain templates or ..");
  if (!allowedPaths(tool).some((re) => re.test(pathname))) return no("PATH", `path ${pathname} is not one of the tool's GET endpoints`);
  for (const [k, v] of Object.entries(spec.request.query)) {
    if (templateNames(k).length > 0) return no("TEMPLATE", `query key ${k} may not be a template`);
    for (const name of templateNames(v)) {
      if (!isIntentField(name)) return no("TEMPLATE", `template {{${name}}} in query ${k} does not draw on an intent field`);
    }
    if (/\{\{|\}\}/.test(v.replace(/\{\{\s*[^{}]*?\s*\}\}/g, ""))) return no("TEMPLATE", `malformed template in query ${k}`);
  }
  for (const [label, p] of [["items_path", spec.items_path], ["marker_path", spec.marker_path], ["pagination.next_path", spec.pagination?.next_path ?? null]] as const) {
    if (p !== null && parsePath(p) === null) return no("JSONPATH", `${label} ${p} is outside the supported JSONPath subset`);
  }
  if (spec.pagination) {
    const { max_pages, cursor_param } = spec.pagination;
    if (!Number.isInteger(max_pages) || max_pages < 1 || max_pages > 10) return no("PAGINATION", "max_pages must be 1 to 10");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cursor_param)) return no("PAGINATION", "cursor_param must be a plain parameter name");
  }
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------------------- canaries

export type CanaryName = "found_immediately" | "decoy_ignored" | "paginated" | "state_hash_unchanged";
export const CANARY_ORDER: CanaryName[] = ["found_immediately", "decoy_ignored", "paginated", "state_hash_unchanged"];
export const CANARY_NUMBER: Record<CanaryName, number> = { found_immediately: 1, decoy_ignored: 2, paginated: 3, state_hash_unchanged: 4 };

export type CanaryHarness = ProbeConnection & {
  /** NT_SIM_ADMIN_KEY: creates the scratch accounts, plants ground truth, reads the state hash. Never given to the probe. */
  adminKey: string;
  /** Search lag of the scratch accounts (default 5000 ms, the simulator's default). */
  searchLagMs?: number;
  /** Prefix of scratch account names (default "probe-canary"). */
  accountPrefix?: string;
};

export type CanaryReport = {
  canaries: Record<CanaryName, boolean>;
  failures: { canary: CanaryName; number: number; reason: string }[];
  probe_requests: number;
};

type Planted = { id: string };

async function adminCall(h: CanaryHarness, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const f = h.fetchImpl ?? fetch;
  const r = await f(new URL(path, h.baseUrl), {
    method,
    headers: { Authorization: `Bearer ${h.adminKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(h.timeoutMs ?? 5000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`canary setup ${method} ${path} failed: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function scratchAccount(h: CanaryHarness, tag: string, n: number): Promise<string> {
  const account = `${h.accountPrefix ?? "probe-canary"}-${tag}-c${n}`;
  await adminCall(h, "POST", "/admin/accounts", { account, search_lag_ms: h.searchLagMs ?? 5000 });
  return account;
}

async function plant(h: CanaryHarness, account: string, recipient: string, marker: string): Promise<Planted> {
  const m = await adminCall(h, "POST", "/admin/messages", {
    account,
    recipient,
    template: "decision_letter_canary",
    amount_minor: 70000,
    currency: "CAD",
    metadata: { nt_marker: marker, nt_run_id: "canary" },
  });
  return { id: String(m.id) };
}

async function stateHash(h: CanaryHarness, account: string): Promise<string> {
  return String((await adminCall(h, "GET", `/admin/state-hash?account=${encodeURIComponent(account)}`)).state_hash);
}

/** Runs the four canaries; each probe run is bracketed by state-hash reads (canary 4). Throws only if the canary SETUP fails. */
export async function runCanaries(spec: ProbeSpec, h: CanaryHarness, opts: { testOnlyAllowNonGet?: boolean } = {}): Promise<CanaryReport> {
  const tag = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const recipient = `payee_canary_${tag}`;
  const failures: CanaryReport["failures"] = [];
  const canaries: Record<CanaryName, boolean> = { found_immediately: false, decoy_ignored: false, paginated: false, state_hash_unchanged: true };
  let probeRequests = 0;
  const hashChanges: string[] = [];

  const ctxFor = (account: string, marker: string, since: string): ProbeContext => ({
    marker,
    payee_ref: recipient,
    account,
    first_dispatch_at: since,
    amount_minor: "70000",
    currency: "CAD",
  });
  const probe = async (account: string, marker: string, since: string, label: string): Promise<ProbeRun> => {
    const before = await stateHash(h, account);
    const run = await executeProbe(spec, ctxFor(account, marker, since), h, { testOnlyAllowNonGet: opts.testOnlyAllowNonGet });
    probeRequests += run.requests;
    const after = await stateHash(h, account);
    if (before !== after) hashChanges.push(label);
    return run;
  };
  const fail = (c: CanaryName, reason: string) => {
    canaries[c] = false;
    failures.push({ canary: c, number: CANARY_NUMBER[c], reason });
  };
  const describeRun = (r: ProbeRun) => (r.ok ? `${r.records.length} record(s) in ${r.pages} page(s)${r.complete ? "" : ", stopped at max_pages"}` : `probe error: ${r.error}`);

  // (1) planted effect found immediately after the write
  {
    const account = await scratchAccount(h, tag, 1);
    const since = new Date(Date.now() - 1000).toISOString();
    const marker = `canary:${tag}:target1`;
    const target = await plant(h, account, recipient, marker);
    const r = await probe(account, marker, since, "canary 1");
    const ok = r.ok && r.records.length === 1 && r.records[0]!.id === target.id;
    if (ok) canaries.found_immediately = true;
    else fail("found_immediately", `planted message not found immediately after the write (${describeRun(r)})`);
  }
  // (2) only a decoy with a different marker: the probe must return nothing
  {
    const account = await scratchAccount(h, tag, 2);
    const since = new Date(Date.now() - 1000).toISOString();
    await plant(h, account, recipient, `canary:${tag}:decoy`);
    const r = await probe(account, `canary:${tag}:target2`, since, "canary 2");
    if (r.ok && r.records.length === 0) canaries.decoy_ignored = true;
    else fail("decoy_ignored", `with only a decoy present the probe ${r.ok ? `returned ${r.records.length} record(s), ids ${r.records.map((x) => x.id).join(",")}` : `failed: ${r.error}`}`);
  }
  // (3) target behind 30 decoys (same recipient, same window): found by following the cursor
  {
    const account = await scratchAccount(h, tag, 3);
    const since = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 30; i++) await plant(h, account, recipient, `canary:${tag}:decoy${i}`);
    const marker = `canary:${tag}:target3`;
    const target = await plant(h, account, recipient, marker);
    const r = await probe(account, marker, since, "canary 3");
    if (r.ok && r.records.length === 1 && r.records[0]!.id === target.id) canaries.paginated = true;
    else fail("paginated", `target behind 30 decoys not found exactly once (${describeRun(r)})`);
  }
  // (4) no probe run changed the state hash
  if (hashChanges.length > 0) fail("state_hash_unchanged", `state hash changed during ${hashChanges.join(", ")}`);

  failures.sort((a, b) => a.number - b.number);
  return { canaries, failures, probe_requests: probeRequests };
}

// ------------------------------------------------------------------------------------------------------------- admission

export type AdmissionVerdict = {
  admitted: boolean;
  static: StaticVerdict;
  canaries: Record<CanaryName, boolean> | null;
  /** First failure in order: the static check, else the lowest-numbered failing canary. null when admitted. */
  reason: string | null;
  failures: CanaryReport["failures"];
  probe_requests: number;
  checked_at: string;
};

export type AdmitOptions = {
  /** TEST ONLY (PRB-06c): skip the static stage and let a non-GET method run, to show canary 4 catches a mutation. */
  testOnlyDisableStatic?: boolean;
};

export async function admitProbe(spec: ProbeSpec, policy: AdmissionPolicy, h: CanaryHarness, opts: AdmitOptions = {}): Promise<AdmissionVerdict> {
  const st: StaticVerdict = opts.testOnlyDisableStatic ? { ok: true } : staticCheck(spec, policy);
  const checked_at = new Date().toISOString();
  if (!st.ok) return { admitted: false, static: st, canaries: null, reason: `static ${st.check}: ${st.reason}`, failures: [], probe_requests: 0, checked_at };
  const rep = await runCanaries(spec, h, { testOnlyAllowNonGet: opts.testOnlyDisableStatic });
  const first = rep.failures[0];
  return {
    admitted: rep.failures.length === 0,
    static: st,
    canaries: rep.canaries,
    reason: first ? `canary ${first.number} (${first.canary}): ${first.reason}` : null,
    failures: rep.failures,
    probe_requests: rep.probe_requests,
    checked_at,
  };
}

// ------------------------------------------------------------------------------------------------------------- the probes collection

/** probes document (ARCHITECTURE.md §5.1 shape), written only for an admitted spec, keyed `{tool_id}:{schema_hash}`. */
export type ProbeDoc = {
  _id: string;
  tool_id: string;
  schema_hash: string;
  spec: Omit<ProbeSpec, "tool_id" | "schema_hash">;
  admission: { static_checks: "PASS"; canaries: Record<CanaryName, boolean>; admitted_at: Date };
};

/** The slice of a MongoDB collection the probe store needs (the @nt/db `probes` collection satisfies it). */
export type ProbeCollection = {
  findOne(filter: { _id: string }): Promise<ProbeDoc | null | Record<string, unknown>>;
  insertOne(doc: ProbeDoc): Promise<unknown>;
};

export function probeDoc(spec: ProbeSpec, v: AdmissionVerdict): ProbeDoc {
  if (!v.admitted || !v.canaries) throw new Error("only an admitted probe is stored");
  const { tool_id, schema_hash, ...rest } = spec;
  return { _id: probeId(tool_id, schema_hash), tool_id, schema_hash, spec: rest, admission: { static_checks: "PASS", canaries: v.canaries, admitted_at: new Date(v.checked_at) } };
}

/** Store an admitted probe. Never overwrites: a document for another schema hash is a different _id and is left untouched. */
export async function saveAdmittedProbe(coll: ProbeCollection, spec: ProbeSpec, v: AdmissionVerdict): Promise<ProbeDoc> {
  const doc = probeDoc(spec, v);
  const existing = await coll.findOne({ _id: doc._id });
  if (!existing) await coll.insertOne(doc);
  return doc;
}

export type ProbeEvidenceSource = { kind: "ADMITTED_PROBE"; spec: ProbeSpec } | { kind: "NONE"; quarantine: Extract<QuarantineReason, "PROBE_NOT_ADMITTED"> };

/** The evidence source for a tool AS IT IS NOW: only a probe admitted for the current schema hash counts (PRB-07). */
export async function evidenceSourceFor(coll: ProbeCollection, tool: ToolDescription): Promise<ProbeEvidenceSource> {
  const hash = toolSchemaHash(tool);
  const doc = (await coll.findOne({ _id: probeId(tool.tool_id, hash) })) as ProbeDoc | null;
  if (!doc || doc.schema_hash !== hash || doc.admission?.static_checks !== "PASS") return { kind: "NONE", quarantine: "PROBE_NOT_ADMITTED" };
  return { kind: "ADMITTED_PROBE", spec: { tool_id: doc.tool_id, schema_hash: doc.schema_hash, ...doc.spec } };
}
