// @nt/runner: the deterministic orchestrator CLI and the final report (task E4).
export { runArm, runReportOnly, payout, payoutOrder, ORCHESTRATED_ARMS, type RunnerDeps, type RunnerGateway, type RunnerDb, type RunOptions, type PayoutOutcome } from "./orchestrator.ts";
export { ingest, adjudicate, assertIngestBarrier, BarrierError, type IngestSummary, type AdjudicateSummary } from "./ingest.ts";
export { buildFinalReport, deriveReport, rewriteReport, writeReportFile, reportPath, ReportError } from "./final-report.ts";
export { goFilePath, parseGoFile, waitForGoFile, crashSpecFor, STATUTORY_TYPES, type GoFile } from "./go-file.ts";
export { runAudit, ORCHESTRATOR, RUNNER_WORKER } from "./audit.ts";
