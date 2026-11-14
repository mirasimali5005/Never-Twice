// A stub HTTP server for unit tests: scripted responses, every request recorded with its raw body.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FrozenRequest } from "@nt/contracts";

export type Recorded = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
export type Reply =
  | { status: number; body?: unknown; rawBody?: string; headers?: Record<string, string> }
  | { hang: true }
  | { destroy: true };
export type Handler = (req: Recorded, n: number) => Reply;

export class StubServer {
  readonly requests: Recorded[] = [];
  handler: Handler = () => ({ status: 500 });
  #server!: http.Server;
  #sockets = new Set<import("node:net").Socket>();
  baseUrl = "";

  static async start(handler?: Handler): Promise<StubServer> {
    const s = new StubServer();
    if (handler) s.handler = handler;
    s.#server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const rec: Recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
        s.requests.push(rec);
        const r = s.handler(rec, s.requests.length);
        if ("hang" in r) return; // never answered
        if ("destroy" in r) return void req.socket.destroy();
        const payload = r.rawBody ?? (r.body === undefined ? "" : JSON.stringify(r.body));
        res.writeHead(r.status, { "Content-Type": "application/json", ...(r.headers ?? {}) });
        res.end(payload);
      });
    });
    s.#server.on("connection", (sock) => {
      s.#sockets.add(sock);
      sock.on("close", () => s.#sockets.delete(sock));
    });
    await new Promise<void>((resolve) => s.#server.listen(0, "127.0.0.1", resolve));
    s.baseUrl = `http://127.0.0.1:${(s.#server.address() as AddressInfo).port}`;
    return s;
  }

  async stop(): Promise<void> {
    for (const sock of this.#sockets) sock.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  get posts(): Recorded[] {
    return this.requests.filter((r) => r.method === "POST");
  }
}

export const ACCOUNT = "acct_r7k2m9qa";
export const WRITE = "stub-write-key";
export const READ = "stub-read-key";
export const ACCOUNT_BODY = { account: ACCOUNT, retention_ms: 86_400_000, max_in_flight_ms: null, search_lag_ms: 5000 };

export function frozenReq(o: { rail?: "instant" | "legacy"; amount_minor?: number; payee?: string; marker?: string; operation?: "PAYOUT" | "REFUND" } = {}): FrozenRequest {
  const rail = o.rail ?? "instant";
  const marker = o.marker ?? "r7k2m9qa:ZT4H9X.P02.NT101-20261110.APPR_DELAY";
  return {
    provider: rail === "instant" ? "sim_payout" : "sim_keyless",
    operation: o.operation ?? "PAYOUT",
    account: ACCOUNT,
    rail,
    amount_minor: o.amount_minor ?? 70000,
    currency: "CAD",
    payee_ref: o.payee ?? "payee_P02",
    parent_ref: null,
    metadata: { nt_marker: marker, nt_effect_key: marker.split(":")[1]!, nt_run_id: "r7k2m9qa", nt_type: "APPR_DELAY" },
  };
}

export function providerObject(o: { id?: string; amount_minor?: number; payee?: string; marker?: string; kind?: "payout" | "refund" } = {}) {
  const marker = o.marker ?? "r7k2m9qa:ZT4H9X.P02.NT101-20261110.APPR_DELAY";
  return {
    id: o.id ?? "po_3f9a1c07e2b84d55",
    kind: o.kind ?? "payout",
    status: "paid",
    amount_minor: o.amount_minor ?? 70000,
    currency: "CAD",
    payee_ref: o.payee ?? "payee_P02",
    parent_ref: null,
    metadata: { nt_marker: marker, nt_effect_key: marker.split(":")[1]!, nt_run_id: "r7k2m9qa", nt_type: "APPR_DELAY" },
    created_at: "2026-11-14T18:00:07.388Z",
  };
}

/** A handler that answers the account lookup and delegates everything else. */
export function withAccount(inner: Handler, accountBody: object = ACCOUNT_BODY): Handler {
  return (req, n) => (req.method === "GET" && req.url.startsWith("/v1/accounts/") ? { status: 200, body: accountBody } : inner(req, n));
}
