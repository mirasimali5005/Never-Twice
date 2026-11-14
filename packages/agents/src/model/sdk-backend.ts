// Optional `sdk` backend. @anthropic-ai/sdk is not a dependency of this workspace, so this is a stub (task E1: "do NOT add the
// SDK unless trivial"). `replay` mode never reaches it, so a cassette recorded with the cli backend still replays under sdk.
import type { ModelParseRequest, ModelToolRunRequest } from "@nt/contracts";

export const SDK_NOT_CONFIGURED = "sdk backend not configured";

export function sdkParse<T>(_model: string, _req: ModelParseRequest<T>): Promise<never> {
  throw new Error(SDK_NOT_CONFIGURED);
}

export function sdkRunTools(_model: string, _req: ModelToolRunRequest): Promise<never> {
  throw new Error(SDK_NOT_CONFIGURED);
}
