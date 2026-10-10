import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateGate, type GateResult, type TrialOutcome } from '@main/modules/token'
import { CAMPAIGN_TASKS } from '../../manual/campaign/tasks'

/**
 * The evidence of the real quality campaign (docs/acceptance/campaign) through the release's quality gate.
 * Every run on file is a trial; runs of one task in one arm are repetitions of one case. Two comparisons,
 * each against the 0.7.0 sources: 0.7.1 with its default settings, and 0.7.1 with the Context Graph in agent
 * context. The gate decides whether a variant may be a default; this test checks that the evidence is what
 * it claims to be and prints the gate's answer. NEXUS_WRITE_BENCHMARK=1 stores it under docs/acceptance.
 */

const DIR = resolve(import.meta.dirname, '../../../docs/acceptance/campaign')

interface Run {
  task: string
  arm: '070' | '071' | '071-graph'
  nexusVersion: string
  quality: { completed: boolean; hiddenPassed: boolean; firstPassAllPassed: boolean; findingsBySeverity: Record<string, number>; repairs: number; regressions: string[]; humanIntervention: { approvalsRequestedAndRefused: number; pauses: string[] } }
  efficiency: { turns: number; inputTokensUncached: number; cacheCreationTokens: number; cacheReadTokens: number; outputTokens: number; wallMs: number; contextToolCalls: string[] }
}

function load(): Run[] {
  if (!existsSync(DIR)) return []
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Run & { kind: string }).filter((r) => r.kind === 'campaign-run')
}

const trial = (r: Run): TrialOutcome => ({
  caseKey: r.task,
  hiddenPassed: r.quality.hiddenPassed,
  // Acceptance is the mission's own: it ran to completion (its verifiers passed, nothing was left blocked).
  acceptancePassed: r.quality.completed,
  firstPassVerified: r.quality.firstPassAllPassed,
  criticalFindings: r.quality.findingsBySeverity['critical'] ?? 0,
  highFindings: r.quality.findingsBySeverity['high'] ?? 0,
  repairs: r.quality.repairs,
  regressions: r.quality.regressions.length,
  humanInterventions: r.quality.humanIntervention.approvalsRequestedAndRefused + r.quality.humanIntervention.pauses.length,
  wallClockMs: r.efficiency.wallMs,
  inputTokens: r.efficiency.inputTokensUncached + r.efficiency.cacheCreationTokens + r.efficiency.cacheReadTokens,
  outputTokens: r.efficiency.outputTokens,
  turns: r.efficiency.turns,
})

describe('real quality campaign through the quality gate', () => {
  const runs = load()

  it('every run was measured on the sources its arm names', () => {
    for (const r of runs) expect(r.nexusVersion, `${r.task} ${r.arm}`).toBe(r.arm === '070' ? '0.7.0' : '0.7.1')
    for (const r of runs) expect(CAMPAIGN_TASKS.some((t) => t.key === r.task), r.task).toBe(true)
  })

  it('reports the gate for 0.7.1 defaults and for the Context Graph, each against 0.7.0', () => {
    const of = (arm: Run['arm']): TrialOutcome[] => runs.filter((r) => r.arm === arm).map(trial)
    const gates: Record<string, GateResult> = { '071': evaluateGate(of('070'), of('071')), '071-graph': evaluateGate(of('070'), of('071-graph')) }
    const hiddenOnly = (arm: Run['arm']): TrialOutcome[] => of(arm).map((t) => ({ ...t, acceptancePassed: true }))
    // The same comparison judged by the hidden evaluation alone, for the reader: a mission that paused on a
    // review task the planner added, in every arm alike, fails acceptance on both sides and tells nothing apart.
    const byHidden: Record<string, GateResult> = { '071': evaluateGate(hiddenOnly('070'), hiddenOnly('071')), '071-graph': evaluateGate(hiddenOnly('070'), hiddenOnly('071-graph')) }
    const line = (name: string, g: GateResult): string => `${name}: ${g.verdict} over ${g.pairs} paired cases; pass rate ${(g.baselinePassRate * 100).toFixed(0)}% -> ${(g.optimizedPassRate * 100).toFixed(0)}%; regressions [${g.regressions.join(', ')}]; improvements [${g.improvements.join(', ')}]; turns ${(g.turnDelta * 100).toFixed(1)}%, input ${(g.inputTokenDelta * 100).toFixed(1)}%, output ${(g.outputTokenDelta * 100).toFixed(1)}%, wall ${(g.wallClockDelta * 100).toFixed(1)}%\n   ${g.reasons.join(' ')}`
    console.log(`\ncampaign gate (${runs.length} runs)\n${Object.entries(gates).map(([k, g]) => line(`0.7.0 -> ${k}`, g)).join('\n')}\nby the hidden evaluation alone:\n${Object.entries(byHidden).map(([k, g]) => line(`0.7.0 -> ${k}`, g)).join('\n')}`)
    if (process.env['NEXUS_WRITE_BENCHMARK'] === '1' && runs.length > 0) {
      const out = resolve(DIR, '..')
      mkdirSync(out, { recursive: true })
      const count = (arm: Run['arm']): Record<string, number> => Object.fromEntries(CAMPAIGN_TASKS.map((t) => [t.key, runs.filter((r) => r.arm === arm && r.task === t.key).length]))
      writeFileSync(join(out, 'campaign-gate.json'), `${JSON.stringify({ kind: 'campaign-gate', at: new Date().toISOString(), runs: runs.length, runsPerCell: { '070': count('070'), '071': count('071'), '071-graph': count('071-graph') }, gate: gates, gateByHiddenEvaluationAlone: byHidden, contextToolCallsWithGraph: runs.filter((r) => r.arm === '071-graph').reduce((n, r) => n + r.efficiency.contextToolCalls.length, 0) }, null, 2)}\n`)
    }
    // A verdict is whatever the evidence gives; what must hold is that the gate never promotes on too little.
    for (const g of Object.values(gates)) if (g.pairs < 8) expect(g.mayBecomeDefault).toBe(false)
  })
})
