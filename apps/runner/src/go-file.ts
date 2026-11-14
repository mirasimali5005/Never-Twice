// The go file (HANDOVER.md §16): `.nt/go-<group_id>.json`, written by `pnpm demo:go`, read by every runner of the group.
// It may carry { "kill_at_passenger": "P05" }; the runner turns that into a crash spec for that passenger's statutory payment.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Arm, Obligation } from "@nt/contracts";

export type GoFile = { kill_at_passenger?: string | undefined };

export const STATUTORY_TYPES = ["APPR_DELAY", "APPR_DENIED_BOARDING", "APPR_REFUND_COMP"] as const;

export function goFilePath(repoRoot: string, groupId: string): string {
  return join(repoRoot, ".nt", `go-${groupId}.json`);
}

/** Parses the go file. A file that is not a JSON object is an error; an unknown or non-string kill_at_passenger is ignored. */
export function parseGoFile(text: string): GoFile {
  const v: unknown = JSON.parse(text);
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("go file must be a JSON object");
  const k = (v as Record<string, unknown>)["kill_at_passenger"];
  return typeof k === "string" && k !== "" ? { kill_at_passenger: k } : {};
}

/** Polls until the go file exists and parses (a half-written file is retried). Resolves immediately when it is already there. */
export async function waitForGoFile(path: string, opts: { pollMs: number; timeoutMs?: number | undefined; sleep?: ((ms: number) => Promise<void>) | undefined }): Promise<GoFile> {
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const started = Date.now();
  for (;;) {
    if (existsSync(path)) {
      try {
        return parseGoFile(readFileSync(path, "utf8"));
      } catch {
        // being written: try again
      }
    }
    if (opts.timeoutMs !== undefined && Date.now() - started >= opts.timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await sleep(opts.pollMs);
  }
}

/**
 * The crash spec for `kill_at_passenger`: the barrier that fires after the provider applied that passenger's statutory payment and before
 * the system recorded it (arm A: CTRL_AFTER_PROVIDER_RESPONSE). Null when the passenger has no OWED statutory obligation.
 */
export function crashSpecFor(arm: Arm, passengerId: string, obligations: readonly Pick<Obligation, "effect_key" | "passenger_id" | "entitlement_type" | "status">[]): string | null {
  const target = obligations
    .filter((o) => o.passenger_id === passengerId && o.status === "OWED" && (STATUTORY_TYPES as readonly string[]).includes(o.entitlement_type))
    .sort((a, b) => a.effect_key.localeCompare(b.effect_key))[0];
  if (!target) return null;
  const barrier = arm === "control" ? "CTRL_AFTER_PROVIDER_RESPONSE" : "BR_DISPATCH_RESPONSE_RECEIVED";
  return `${barrier}@${target.effect_key}`;
}
