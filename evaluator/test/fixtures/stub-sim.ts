// Stub provider simulator for the evaluator's tests (node:http on an ephemeral port). Serves GET /v1/payouts only.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export function stubSim(objects: Record<string, unknown>[], key: string, pageSize = 2) {
  const seen: { url: string; auth: string | undefined; method: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization, method: req.method ?? "" });
    res.setHeader("X-Simulator", "never-twice-provider-sim");
    if (req.headers.authorization !== `Bearer ${key}`) { res.statusCode = 401; res.end('{"error":{"code":"unauthorized","message":"no"}}'); return; }
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/v1/payouts") { res.statusCode = 404; res.end("{}"); return; }
    const acct = u.searchParams.get("account");
    const mine = objects.filter((o) => (o as { account?: string }).account === acct);
    const after = u.searchParams.get("starting_after");
    const start = after ? mine.findIndex((o) => o.id === after) + 1 : 0;
    const page = mine.slice(start, start + pageSize);
    const has_more = start + pageSize < mine.length;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: page.map(({ account: _a, ...o }) => o), has_more, next_cursor: has_more ? page[page.length - 1].id : null }));
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

export function simObj(account: string, id: string, key: string | null, amount: number, payee: string): Record<string, unknown> {
  const run = account.slice(5);
  return { account, id, kind: "payout", status: "paid", amount_minor: amount, currency: "CAD", payee_ref: payee, parent_ref: null,
    created_at: "2026-11-14T18:00:00.000Z",
    metadata: key === null ? {} : { nt_effect_key: key, nt_marker: `${run}:${key}`, nt_run_id: run, nt_type: key.split(".").pop() } };
}
