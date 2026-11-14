// Repository-relative locations used by the harness scripts. `.nt/` is the git-ignored working directory (HANDOVER §16).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NT_DIR = join(ROOT, ".nt");
export const PIDS_DIR = join(NT_DIR, "pids");
export const LOGS_DIR = join(NT_DIR, "logs");
export const CURRENT_FILE = join(NT_DIR, "current.json");
export const GROUPS_FILE = join(NT_DIR, "groups.json");
export const REPORTS_DIR = join(ROOT, "out", "reports");
export const FIXTURES_DIR = join(ROOT, "fixtures");
export const EVALUATOR_CLI = join(ROOT, "evaluator", "src", "cli.ts");
/** Where `evaluator manifest` writes. Read by the terminal renderer; written only by the evaluator. */
export const EVALUATOR_OUT = join(ROOT, "evaluator", "out");
export const STRIPE_SEED_SCRIPT = join(ROOT, "scripts", "stripe", "seed-ticket-payment.ts");
export const RUNNER_CLI = join(ROOT, "apps", "runner", "src", "cli.ts");
export const RECONCILER_MAIN = join(ROOT, "apps", "reconciler", "src", "main.ts");
export const DESK_SERVER = join(ROOT, "apps", "desk-api", "src", "server.ts");
export const SIM_SERVER = join(ROOT, "apps", "provider-sim", "src", "server.ts");

export const goFile = (ntDir: string, groupId: string) => join(ntDir, `go-${groupId}.json`);
