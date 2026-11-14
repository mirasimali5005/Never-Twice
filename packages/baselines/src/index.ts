// @nt/baselines: the baseline arms (task E5). Tier 1: arm A `control`. Arms B and R are Tier 2 and not built yet.
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
