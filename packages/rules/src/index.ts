// @nt/rules: the deterministic compensation rules engine (task E2). Only policy.ts reads files.
export { computeObligations, type ComputeInput } from "./compute.ts";
export { RulesError, selectBand, delayBand, deniedBoardingBand, refundCompensation, dueBy } from "./appr.ts";
export { lookupRegimeBand, selectRegime, computeRegimeObligations } from "./regime.ts";
export { goodwillEligibility, type GoodwillEligibility } from "./goodwill.ts";
export {
  loadPolicyBundle,
  parsePolicyBundle,
  PolicyError,
  STATUTORY_POLICY_ID,
  GOODWILL_POLICY_ID,
  EU261_POLICY_ID,
  REGIME_POLICY_IDS,
  DEFAULT_POLICY_IDS,
  type PolicyIds,
} from "./policy.ts";
