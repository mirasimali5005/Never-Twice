// Client for the simulator's /admin/* routes (admin key; read only by the harness scripts and tests).
export class SimAdminError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SimAdminError";
    this.status = status;
  }
}

export type SimFault = Record<string, unknown>;

export class SimAdmin {
  readonly baseUrl: string;
  readonly #key: string;
  constructor(baseUrl: string, adminKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#key = adminKey;
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${this.#key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      signal: AbortSignal.timeout(10_000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, init);
    } catch (e) {
      throw new SimAdminError(`provider simulator not reachable at ${this.baseUrl} (${e instanceof Error ? e.message : String(e)}); start it with \`pnpm sim\``, 0);
    }
    const text = await res.text();
    if (!res.ok) throw new SimAdminError(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`, res.status);
    return text === "" ? null : JSON.parse(text);
  }

  /** True when GET /healthz answers (no credential needed). */
  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  createAccount(account: string): Promise<unknown> {
    return this.#call("POST", "/admin/accounts", { account });
  }
  installFaults(account: string, faults: SimFault[]): Promise<unknown> {
    return this.#call("POST", "/admin/faults", { account, faults });
  }
  resetAccount(account: string): Promise<unknown> {
    return this.#call("POST", "/admin/reset", { account });
  }
  releaseHeld(account: string, filter: { payee_ref?: string; marker?: string } = {}): Promise<unknown> {
    return this.#call("POST", "/admin/faults/release", { account, ...filter });
  }
  stateHash(account: string): Promise<unknown> {
    return this.#call("GET", `/admin/state-hash?account=${encodeURIComponent(account)}`);
  }
}
