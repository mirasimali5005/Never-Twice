// One fetch wrapper with a timeout and error classification (task C2). This is the only place a transport failure is interpreted;
// the only place an HTTP status is interpreted is sim-client.ts. No retries: the gateway owns retries.

/** A programmer or configuration error (wrong key, unknown account, wrong rail passed to a client). Never an outcome. */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/** A read method could not read (transport failure or unexpected status). Thrown only by methods that have no
 *  "incomplete" channel (getOperation, listOperations); findOperationEvidence returns `complete: false` instead. */
export class ProviderReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderReadError";
  }
}

export type HttpOutcome =
  | { kind: "response"; status: number; headers: Headers; text: string }
  | { kind: "timeout"; detail: string }
  | { kind: "connection"; detail: string };

type ErrWithCause = { name?: string; code?: string; message?: string; cause?: unknown };

function isTimeout(e: unknown): boolean {
  const x = e as ErrWithCause | null;
  return x?.name === "TimeoutError" || x?.name === "AbortError" || x?.code === "UND_ERR_HEADERS_TIMEOUT" || x?.code === "UND_ERR_BODY_TIMEOUT";
}

function describe(e: unknown): string {
  const x = e as ErrWithCause | null;
  const cause = x?.cause as ErrWithCause | undefined;
  const code = cause?.code ?? x?.code;
  const msg = cause?.message ?? x?.message ?? String(e);
  return code ? `${code}: ${msg}` : msg;
}

/** One HTTP request. Never throws for transport problems: a timeout, a refused or reset connection, or a socket that closed
 *  without a response (including while the body was being read) comes back as a value. */
export async function httpRequest(
  url: string,
  o: { method: "GET" | "POST"; headers: Record<string, string>; body?: Uint8Array; timeoutMs: number },
): Promise<HttpOutcome> {
  const signal = AbortSignal.timeout(o.timeoutMs);
  try {
    const init: RequestInit = { method: o.method, headers: o.headers, signal };
    if (o.body !== undefined) init.body = o.body;
    const res = await fetch(url, init);
    const text = await res.text();
    return { kind: "response", status: res.status, headers: res.headers, text };
  } catch (e) {
    if (isTimeout(e) || signal.aborted) return { kind: "timeout", detail: `no complete response within ${o.timeoutMs} ms` };
    return { kind: "connection", detail: describe(e) };
  }
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
