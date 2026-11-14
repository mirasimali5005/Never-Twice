// Shared fixtures for the probe tests: the notify.send tool description, a good spec and the known-bad variants.
import { readFileSync } from "node:fs";
import { ToolDescription, completeSpec } from "../../src/probes/index.ts";
import type { CanaryHarness, ProbeDraft, ProbeSpec } from "../../src/probes/index.ts";
import { SIM_KEYS } from "./sim-process.ts";

export const NOTIFY_TOOL = ToolDescription.parse(JSON.parse(readFileSync(new URL("../../../../fixtures/tool-descriptions/notify.send.json", import.meta.url), "utf8")));

export const GOOD_DRAFT: ProbeDraft = {
  request: {
    method: "GET",
    path: "/v1/messages",
    query: { account: "{{account}}", recipient: "{{payee_ref}}", created_gte: "{{first_dispatch_at}}", limit: "20" },
    credential: "read",
  },
  items_path: "$.data[*]",
  marker_path: "$.metadata.nt_marker",
  pagination: { cursor_param: "starting_after", next_path: "$.next_cursor", max_pages: 5 },
};

export const goodSpec = (): ProbeSpec => completeSpec(structuredClone(GOOD_DRAFT), NOTIFY_TOOL);

/** Variant of the good spec. */
export function variant(edit: (s: ProbeSpec) => void): ProbeSpec {
  const s = goodSpec();
  edit(s);
  return s;
}

export function harness(baseUrl: string, fetchImpl?: typeof fetch): CanaryHarness {
  return { baseUrl, readKey: SIM_KEYS.read, adminKey: SIM_KEYS.admin, fetchImpl, accountPrefix: `pc${Math.random().toString(36).slice(2, 7)}` };
}

export function policy(baseUrl: string) {
  return { tool: NOTIFY_TOOL, allowedOrigins: [new URL(baseUrl).origin] };
}

/** fetch wrapper that counts requests (the static stage must make none). */
export function countingFetch(): { fetchImpl: typeof fetch; count: () => number } {
  let n = 0;
  return {
    fetchImpl: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      n++;
      return fetch(input, init);
    }) as typeof fetch,
    count: () => n,
  };
}
