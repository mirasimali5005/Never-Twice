// The provider's own list for a run's simulator account, read with the read key through the strongly consistent list endpoint
// (GET /v1/payouts, never /v1/search), all pages, grouped by metadata.nt_effect_key. Never logs the key or a provider response.
import { ACCEPTED_STATUSES } from "@nt/contracts";

export type StatementObject = { id: string; status: string; amount_minor: number; created_at: string };
export type ProviderStatement = {
  run_id: string;
  account: string;
  read_at: string;
  complete: boolean;
  entitlements: { effect_key: string; count: number; amount_minor_total: number; objects: StatementObject[] }[];
  unattributed: StatementObject[];
  paid_twice: number;
};

export type SimAccess = { url: string; readKey: string; fetch?: typeof fetch; timeoutMs?: number };

export class ProviderUnreachable extends Error {
  constructor() {
    super("PROVIDER_UNREACHABLE");
    this.name = "ProviderUnreachable";
  }
}

type WireObject = { id?: unknown; status?: unknown; amount_minor?: unknown; created_at?: unknown; metadata?: unknown };
const MAX_PAGES = 100;
const ACCEPTED = ACCEPTED_STATUSES.sim_payout;

function asObject(o: WireObject): { obj: StatementObject; effect_key: string | null } | null {
  if (typeof o.id !== "string" || typeof o.status !== "string" || typeof o.amount_minor !== "number" || typeof o.created_at !== "string") return null;
  const md = o.metadata && typeof o.metadata === "object" ? (o.metadata as Record<string, unknown>) : {};
  const ek = md["nt_effect_key"];
  return {
    obj: { id: o.id, status: o.status, amount_minor: o.amount_minor, created_at: o.created_at },
    effect_key: typeof ek === "string" && ek !== "" ? ek : null,
  };
}

/** Every object of the account, in creation order. Throws ProviderUnreachable on any transport, status or shape problem. */
export async function readStatement(access: SimAccess, runId: string, account: string, now: () => Date): Promise<ProviderStatement> {
  const doFetch = access.fetch ?? fetch;
  const timeout = access.timeoutMs ?? 4000;
  const base = access.url.replace(/\/+$/, "");
  const attributed = new Map<string, StatementObject[]>();
  const unattributed: StatementObject[] = [];
  let cursor: string | null = null;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ account, limit: "100" });
    if (cursor) qs.set("starting_after", cursor);
    let body: { data?: unknown; has_more?: unknown; next_cursor?: unknown };
    try {
      const res = await doFetch(`${base}/v1/payouts?${qs.toString()}`, {
        headers: { authorization: `Bearer ${access.readKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new ProviderUnreachable();
      body = (await res.json()) as typeof body;
    } catch {
      throw new ProviderUnreachable();
    }
    if (!Array.isArray(body.data)) throw new ProviderUnreachable();
    for (const raw of body.data as WireObject[]) {
      const o = asObject(raw);
      if (!o) throw new ProviderUnreachable();
      if (o.effect_key === null) unattributed.push(o.obj);
      else {
        const list = attributed.get(o.effect_key) ?? [];
        list.push(o.obj);
        attributed.set(o.effect_key, list);
      }
    }
    if (body.has_more !== true) {
      complete = true;
      break;
    }
    if (typeof body.next_cursor !== "string" || body.next_cursor === "") throw new ProviderUnreachable();
    cursor = body.next_cursor;
  }
  // `count` and the total are over objects in an accepted status; `objects` lists every object so nothing is hidden.
  const entitlements = [...attributed.entries()].map(([effect_key, objects]) => {
    const accepted = objects.filter((o) => ACCEPTED.has(o.status));
    return { effect_key, count: accepted.length, amount_minor_total: accepted.reduce((s, o) => s + o.amount_minor, 0), objects };
  });
  return {
    run_id: runId,
    account,
    read_at: now().toISOString(),
    complete,
    entitlements,
    unattributed,
    paid_twice: entitlements.filter((e) => e.count >= 2).length,
  };
}
