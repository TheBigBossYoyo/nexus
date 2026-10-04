export { ArenaService } from './campaign'
export type { ArenaRunHost, ArenaServiceDeps, CreateCampaignInput } from './campaign'
export {
  caseCommands,
  describeCommands,
  hashDirectory,
  hashEvaluator,
  importCase,
  listCaseDirectories,
  listFilesRecursive,
  loadCaseDirectory,
  loadVerifiedCase,
  registerCases,
  registerLoadedCase,
  trustCaseVersion,
} from './case-format'
export type { CaseCommands, CaseOrigin, ImportedCase, LoadedCase, RegisteredCase } from './case-format'
export { BASELINE_AUTHOR, assertNoEvaluatorFiles, provisionTrial } from './fixtures'
export type { ProvisionInput, ProvisionedTrial } from './fixtures'
export { EVALUATION_OUTPUT_CAP_BYTES, evaluateTrial } from './evaluator'
export type { EvaluateInput, EvaluationOutcome } from './evaluator'
export { collectTrialMetrics } from './metrics'
export {
  COUNTED_STATES,
  buildMatrix,
  compareStrategies,
  compareTrials,
  defaultScoring,
  detectRegressions,
  mergeScoring,
  observedTokens,
  resultNotes,
  scoreTrial,
  verificationPassed,
} from './scoring'
export type { ComparisonTrial, RankedTrial, RegressionGroup, ScoreResult } from './scoring'
