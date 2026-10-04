import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArenaTrialMetrics } from '@shared/v3'

export const metrics = (over: Partial<ArenaTrialMetrics> = {}): ArenaTrialMetrics => ({
  id: 'm',
  trialId: 't',
  buildPassed: null,
  typecheckPassed: null,
  testsPassed: true,
  hiddenPassed: true,
  acceptanceTotal: null,
  acceptancePassed: null,
  verifierPassed: true,
  criticalFindings: 0,
  highFindings: 0,
  mediumFindings: 0,
  repairs: 0,
  wallClockMs: 100_000,
  sessions: 4,
  turns: 10,
  inputTokens: 1000,
  outputTokens: 500,
  toolCalls: 5,
  humanInterventions: 0,
  approvals: 0,
  manualRetries: 0,
  blockers: 0,
  crashedAgents: 0,
  recoveredSessions: 0,
  schedulerFailures: 0,
  unfinishedTasks: 0,
  quotaPauses: 0,
  quotaWaitMs: 0,
  autoResumeSuccesses: 0,
  throttleEvents: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

export const definition = (over: Record<string, unknown> = {}) => ({
  id: 'demo-case',
  version: 1,
  name: 'Demo',
  description: 'A demo case',
  category: 'bugfix',
  complexity: 'small',
  risk: 'low',
  languages: ['JavaScript'],
  frameworks: [],
  taskPrompt: 'Fix the bug.',
  visibleAcceptance: ['It works'],
  checks: { build: null, test: 'node --test', lint: null, typecheck: null },
  setup: [],
  hiddenEvaluation: { command: 'node --test hidden-tests/', timeoutSeconds: 60 },
  budgets: { maxWallClockMinutes: 20, maxAgentSessions: 20, maxAgentsPerTrial: 2, maxTurnsPerAgent: 60 },
  allowedStrategies: ['SINGLE', 'BUILD'],
  ...over,
})

/** Writes `<root>/<id>/{case.json,fixture,evaluator}` and returns the case directory. */
export function writeCase(root: string, over: Record<string, unknown> = {}, evaluatorBody = 'hidden v1'): string {
  const def = definition(over)
  const dir = join(root, String(def.id))
  mkdirSync(join(dir, 'fixture'), { recursive: true })
  mkdirSync(join(dir, 'evaluator', 'hidden-tests'), { recursive: true })
  writeFileSync(join(dir, 'case.json'), JSON.stringify(def, null, 2))
  writeFileSync(join(dir, 'fixture', 'index.js'), 'export const x = 1\n')
  writeFileSync(join(dir, 'evaluator', 'hidden-tests', 'a.test.mjs'), evaluatorBody)
  return dir
}

