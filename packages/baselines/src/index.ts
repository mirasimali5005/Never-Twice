// @nt/baselines: the baseline arms (task E5). Arm A `control` (Tier 1), arm B `documented` (Tier 2). Arm R `rules_only` is the nt path with
// the regex extractor in @nt/agents (createRegexModelClient), wired in apps/runner.
export {
  runControl,
  buildBaselineReport,
  writeReportFile,
  controlBarrier,
  isStatutory,
  killSpecFor,
  type BaselineDeps,
  type BaselineDoc,
  type BaselineDecision,
  type BaselineAttempt,
  type BaselinePayment,
  type BaselineGoodwillStep,
  type DecidedClaim,
} from "./control.ts";
export { runDocumented, stableKey, DOCUMENTED_MAX_RETRIES, type DocumentedDeps } from "./documented.ts";
