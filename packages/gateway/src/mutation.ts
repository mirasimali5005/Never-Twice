// The mutation switch (HANDOVER.md §16). mutation(id) is true only when NT_MUTATION equals that id, read at call time.
// Sites, one each: M1 authority.ts goodwillGuard; M2 outcomes.ts markUnknown; M3 resend.ts (the `unlicensed` option is
// accepted only under M3; the deciding site is the reconciler's apply); M4 resend.ts resend; M5 reserve.ts buildIntent.
import type { MutationId } from "@nt/contracts";

export function mutation(id: MutationId): boolean {
  return process.env.NT_MUTATION === id;
}
