// Test-only fakes for the investigator: a read-only provider view with a lagging search, and a scripted ModelClient. Synthetic data only.
import type { ModelClient, ModelParseRequest, ModelParseResult, ProviderObject } from "@nt/contracts";
import type { ProviderEvent, ReadOnlyProviderView } from "../src/investigator/tools.ts";
import { T0 } from "./support/fixtures.ts";

export function payout(i: number, over: Partial<ProviderObject> = {}): ProviderObject {
  return {
    id: `po_${String(i).padStart(4, "0")}`,
    kind: "payout",
    status: "paid",
    amount_minor: 40000,
    currency: "CAD",
    payee_ref: "payee_P13",
    parent_ref: null,
    metadata: { nt_marker: `r7k2m9qa:OTHER.${i}`, nt_run_id: "r7k2m9qa" },
    created_at: new Date(T0.getTime() + i * 100).toISOString(),
    ...over,
  };
}

/**
 * A fake provider. listOperations yields in pages of `pageSize` (counted in `pageFetches`), in creation order, from `since`.
 * searchOperations returns only objects created at least `searchLagMs` before `now` (the simulator's lag). It also carries a
 * write method that must never be reached; `writes` counts any call.
 */
export class FakeProvider implements ReadOnlyProviderView {
  objects: ProviderObject[] = [];
  events: ProviderEvent[] = [];
  pageSize = 10;
  pageFetches = 0;
  failOnPage: number | null = null;
  searchLagMs = 5000;
  now: Date = new Date(T0.getTime() + 10_000);
  writes = 0;
  readonly calls: string[] = [];

  readonly account: string;
  constructor(account = "acct_test") {
    this.account = account;
  }

  async getOperation(id: string): Promise<ProviderObject | null> {
    this.calls.push("getOperation");
    return this.objects.find((o) => o.id === id) ?? null;
  }

  async findOperationEvidence(q: { account: string; payeeRef: string; parentRef: string | null; since: Date }) {
    this.calls.push("findOperationEvidence");
    return { records: this.objects.filter((o) => o.payee_ref === q.payeeRef && Date.parse(o.created_at) >= q.since.getTime()), complete: true };
  }

  async *listOperations(scope: { account: string; since?: Date }): AsyncIterable<ProviderObject> {
    this.calls.push("listOperations");
    if (scope.account !== this.account) return;
    const rows = [...this.objects]
      .filter((o) => scope.since === undefined || Date.parse(o.created_at) >= scope.since.getTime())
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (let p = 0; p * this.pageSize < rows.length; p++) {
      this.pageFetches += 1;
      if (this.failOnPage === p + 1) throw new Error(`simulated failure on page ${p + 1}`);
      for (const o of rows.slice(p * this.pageSize, (p + 1) * this.pageSize)) yield o;
    }
  }

  async searchOperations(q: { account: string; marker: string }): Promise<ProviderObject[]> {
    this.calls.push("searchOperations");
    if (q.account !== this.account) return [];
    return this.objects.filter((o) => o.metadata.nt_marker === q.marker && Date.parse(o.created_at) <= this.now.getTime() - this.searchLagMs);
  }

  async listEvents(q: { account: string; since?: Date }): Promise<ProviderEvent[]> {
    this.calls.push("listEvents");
    return q.account === this.account ? this.events : [];
  }

  /** Must never be called by anything under test. */
  async createPaymentOrRefund(): Promise<never> {
    this.writes += 1;
    throw new Error("write path reached from the investigator");
  }
}

export type ScriptedReply = ModelParseResult<unknown> | { delayMs: number; reply: ModelParseResult<unknown> } | "hang";

/** A ModelClient whose parse replies are scripted in order. It validates `ok` outputs with the request's schema, like the real client. */
export class FakeModel implements ModelClient {
  readonly mode = "replay" as const;
  readonly model = "fake-model";
  readonly backend = "cli" as const;
  readonly requests: ModelParseRequest<unknown>[] = [];
  readonly #script: ScriptedReply[];
  constructor(script: ScriptedReply[]) {
    this.#script = script;
  }

  async parse<T>(req: ModelParseRequest<T>): Promise<ModelParseResult<T>> {
    this.requests.push(req as ModelParseRequest<unknown>);
    const next = this.#script.shift();
    if (next === undefined) return { ok: false, failure: "CASSETTE_MISS", detail: "script exhausted", requestSha256: "x" };
    if (next === "hang") return new Promise(() => {});
    const reply = "delayMs" in next ? await new Promise<ModelParseResult<unknown>>((r) => setTimeout(() => r(next.reply), next.delayMs)) : next;
    if (!reply.ok) return reply as ModelParseResult<T>;
    const v = req.schema.safeParse(reply.output);
    if (!v.success) return { ok: false, failure: "SCHEMA_INVALID", detail: v.error.message.slice(0, 200), requestSha256: "x" };
    return { ...reply, output: v.data };
  }

  async runTools(): Promise<never> {
    throw new Error("runTools is not used by the cli plan-then-execute investigator");
  }
}

export function ok(output: unknown): ModelParseResult<unknown> {
  return { ok: true, output, requestSha256: "x", source: "cassette" };
}
