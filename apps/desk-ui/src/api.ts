// Read-only client of the desk API (ARCHITECTURE.md section 9). GET only: the UI has no write path.
// An error is returned as a value and rendered as "unavailable"; it is never turned into zero or green.
import { mockGet } from "./mocks/engine";
import type {
  AnyTrail,
  Certificate,
  ClaimCase,
  ClaimRow,
  GroupView,
  PaymentRow,
  Pool,
  ProviderStatement,
  RunSummary,
} from "./types";

export const MOCK: boolean =
  import.meta.env.VITE_MOCK === "1" || (typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "1");

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function get<T>(path: string): Promise<ApiResult<T>> {
  try {
    if (MOCK) {
      const r = mockGet(path);
      return r.status === 200 ? { ok: true, data: r.body as T } : failure(r.status, r.body);
    }
    const res = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body (a proxy error page) */
    }
    return res.ok ? { ok: true, data: body as T } : failure(res.status, body);
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "NETWORK" };
  }
}

function failure(status: number, body: unknown): { ok: false; status: number; error: string } {
  const b = (body ?? {}) as { error?: string; status?: string };
  return { ok: false, status, error: b.error ?? b.status ?? `HTTP_${status}` };
}

const run = (id: string) => `/api/runs/${encodeURIComponent(id)}`;

export const api = {
  group: (g: string) => get<GroupView>(`/api/groups/${encodeURIComponent(g)}`),
  summary: (r: string) => get<RunSummary>(`${run(r)}/summary`),
  claims: (r: string) => get<ClaimRow[]>(`${run(r)}/claims`),
  claim: (r: string, c: string) => get<ClaimCase>(`${run(r)}/claims/${encodeURIComponent(c)}`),
  payments: (r: string) => get<PaymentRow[]>(`${run(r)}/payments`),
  payment: (r: string, effectKey: string) => get<AnyTrail>(`${run(r)}/payments/${encodeURIComponent(effectKey)}`),
  statement: (r: string) => get<ProviderStatement>(`${run(r)}/provider-statement`),
  pool: (r: string) => get<Pool>(`${run(r)}/pool`),
  certificate: (r: string) => get<Certificate>(`${run(r)}/certificate`),
};

export const eventsUrl = (runId: string) => `${run(runId)}/events`;
