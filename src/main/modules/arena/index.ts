export { ArenaService } from './campaign'
export type { ArenaRunHost, ArenaServiceDeps, CreateCampaignInput } from './campaign'
export {
  caseCommands,
  describeCommands,
  hashDirectory,
  hashEvaluator,
  hashCaseEvaluator,
  canonicalJson,
  MAX_CASE_FILES,
  MAX_CASE_BYTES,
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
export { BASELINE_AUTHOR, assertNoEvaluatorFiles, gitGuard, guardedGit, provisionTrial } from './fixtures'
export type { ProvisionInput, ProvisionedTrial } from './fixtures'
export { EVALUATION_OUTPUT_CAP_BYTES, evaluateTrial, nothingRan, testsReported } from './evaluator'
export type { EvaluateInput, EvaluationOutcome } from './evaluator'
export { cleanEnv } from './env'
export { MIN_NODE_MAJOR, checkNode } from './preflight'
export type { NodeStatus } from './preflight'
export { collectTrialMetrics } from './metrics'
export {
  MIN_CASES_FOR_EVIDENCE,
  trialOutcome,
  buildMatrix,
  compareStrategies,
  compareTrials,
  defaultScoring,
  mergeScoring,
  observedTokens,
  resultNotes,
  scoreTrial,
  verificationPassed,
} from './scoring'
export type { ComparisonTrial, RankedTrial, ScoreResult } from './scoring'
