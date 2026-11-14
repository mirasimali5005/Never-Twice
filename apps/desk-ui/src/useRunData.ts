// Data for one run. Events are a change signal: each one bumps `version`, and every resource refetches (debounced).
// Baseline runs also refetch /provider-statement once per second (they write no audit events worth waiting for).
// The auditor writes no audit event, so certificates are polled (2 s until one exists, then 8 s).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, MOCK, type ApiResult } from "./api";
import { useEvents, type StreamStatus } from "./useEvents";
import type { AnyTrail, Certificate, GroupRun, PaymentRow, ProviderStatement, RunSummary } from "./types";

type Keyed<T> = { key: string; result: ApiResult<T> };

/** Fetches whenever `key` or `version` changes (and every `intervalMs`). Returns null until a result for the current key exists;
 *  while refetching the previous result for the same key stays on screen, so nothing flickers. */
export function useResource<T>(
  key: string | null,
  fetcher: () => Promise<ApiResult<T>>,
  version: number,
  intervalMs?: number,
): ApiResult<T> | null {
  const [state, setState] = useState<Keyed<T> | null>(null);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const load = () =>
      fetchRef.current().then((result) => {
        if (!cancelled) setState({ key, result });
      });
    void load();
    const timer = intervalMs ? setInterval(() => void load(), intervalMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [key, version, intervalMs]);
  return state && state.key === key ? state.result : null;
}

/** 2 s after the first miss, doubling to a 10 s ceiling. */
export function certificateBackoffMs(misses: number): number {
  return Math.min(2000 * 2 ** Math.max(0, misses - 1), 10000);
}

/** 404 NOT_AUDITED is an expected answer ("not audited yet"), not a failure. */
export function isNotAudited(r: ApiResult<unknown> | null): boolean {
  return r !== null && !r.ok && (r.status === 404 || r.error === "NOT_AUDITED");
}

/** The screen follows one entitlement: P02's statutory payment until a card is clicked. */
export function defaultKey(rows: { effect_key: string; passenger_id: string; entitlement_type: string }[]): string | null {
  const p02 = rows.find((r) => r.passenger_id === "P02" && r.entitlement_type !== "TICKET_REFUND");
  return (p02 ?? rows[0])?.effect_key ?? null;
}

export type RunData = {
  selectedKey: string | null;
  summary: ApiResult<RunSummary> | null;
  payments: ApiResult<PaymentRow[]> | null;
  statement: ApiResult<ProviderStatement> | null;
  certificate: ApiResult<Certificate> | null;
  trail: ApiResult<AnyTrail> | null;
  stream: StreamStatus;
};

export function useRunData(run: GroupRun | undefined, pickedKey: string | null, full: boolean): RunData {
  const id = run?.run_id ?? null;
  const baseline = run ? run.arm === "control" || run.arm === "documented" : false;
  const [version, setVersion] = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bump = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setVersion((v) => v + 1), 150);
  }, []);
  useEffect(() => () => debounce.current && clearTimeout(debounce.current), []);

  const stream = useEvents(full ? id : null, bump, bump);
  // Events are only a signal. If the stream is down, poll every 2 s so the screen still moves; while it is up, a slow 6 s refetch is a
  // safety net against a stream that stalls silently (a proxy can hold a dead connection open; keep-alive comments are invisible to the page).
  // Baseline arms write no audit events: their payments, trail and statement are refetched once per second.
  const poll = !full ? undefined : baseline ? 1000 : MOCK ? undefined : stream === "live" ? 6000 : 2000;

  const summary = useResource(full && id ? `s:${id}` : null, () => api.summary(id!), version, poll);
  const payments = useResource(full && id ? `p:${id}` : null, () => api.payments(id!), version, poll);
  const statement = useResource(full && id ? `st:${id}` : null, () => api.statement(id!), version, poll);
  const selectedKey = pickedKey ?? (payments?.ok ? defaultKey(payments.data) : null);
  const trail = useResource(full && id && selectedKey ? `t:${id}:${selectedKey}` : null, () => api.payment(id!, selectedKey!), version, poll);

  // The certificate. The desk API says per run whether a certificate file exists (`audited`); until then there is nothing to ask for,
  // so no request is made (a 404 per poll was logged as a red network error each time). Without that field (mock, a recording) the
  // poll backs off: 2 s, 4 s, 8 s, then every 10 s while the answer is 404 NOT_AUDITED, and every 8 s once a certificate exists.
  const [certMisses, setCertMisses] = useState(0);
  const certKey = id && run?.audited !== false ? `c:${id}` : null;
  const [certFound, setCertFound] = useState(false);
  const certInterval = certFound ? 8000 : certificateBackoffMs(certMisses);
  const certificate = useResource(certKey, () => api.certificate(id!), version, certInterval);
  useEffect(() => {
    if (certificate === null) return;
    setCertFound(certificate.ok);
    if (certificate.ok) setCertMisses(0);
    else if (isNotAudited(certificate)) setCertMisses((n) => Math.min(n + 1, 8));
  }, [certificate]);

  return { selectedKey, summary, payments, statement, certificate, trail, stream };
}
