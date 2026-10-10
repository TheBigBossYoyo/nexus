import { describe, expect, it } from 'vitest'
import { AGENT_ROLES, type AgentPurpose, type AgentRole } from '@shared/domain'
import { AUTO_DEFAULTS, DEFAULT_TOKEN_SETTINGS, checkOutputMode, estimateTokens, techniqueEnabled, weakestBasis } from '@shared/token'
import { DEFAULT_SETTINGS, SettingsSchema } from '@shared/settings'
import { parseContextUsage } from '@main/modules/agent-runtime/claude-sdk-runtime'
import type { RuntimeContextUsage } from '@main/modules/agent-runtime/types'
import { rolePrompt } from '@main/modules/context/prompts'
import { renderChecks, SECTION_LIMITS } from '@main/modules/context/render'
import {
  PromptComponentRegistry,
  allocateBudget,
  assemblePrompt,
  auditPrompt,
  buildBreakdown,
  cacheRateDrop,
  canonicalJson,
  canonicalText,
  capabilitiesOf,
  classifyCacheResult,
  composition,
  decideSessionAction,
  diagnoseCache,
  evaluateGate,
  filterOutput,
  mayLeaveOut,
  partsFromList,
  partsToList,
  planContextOptions,
  planTools,
  prefixParts,
  pressureOf,
  resultState,
  scoreRetrieval,
  summarizeOutput,
  toolSetHash,
  type PrefixIdentity,
  type TrialOutcome,
} from '@main/modules/token'

const identity = (over: Partial<PrefixIdentity> = {}): PrefixIdentity => ({
  provider: 'claude',
  model: 'opus',
  role: 'worker',
  effort: null,
  systemText: rolePrompt('worker', 'implement'),
  tools: ['Read', 'Edit', 'Bash', 'mcp__nexus__send_message'],
  flags: { stablePrefix: true, nexusToolsAlwaysLoaded: false, projectSettings: false, structuredOutput: false },
  dynamicSystem: null,
  ...over,
})

describe('canonical serialization', () => {
  it('orders object keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: undefined, b: null } })).toBe('{"a":{"b":null,"d":[3,1,2]},"b":1}')
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })

  it('normalizes line endings and trailing spaces and nothing else', () => {
    expect(canonicalText('a  \r\nb\t\n\n\n\nc\n')).toBe('a\nb\n\nc')
    expect(canonicalText('  keep   inner   spaces')).toBe('keep   inner   spaces')
  })
})

describe('prompt component registry', () => {
  it('gives the same component for the same text and a new version for changed text', () => {
    const r = new PromptComponentRegistry(null, () => '2026-10-07T00:00:00.000Z')
    const a = r.register({ key: 'worker-role', scope: 'system', priority: 10, text: 'Role: WORKER.', cacheability: 'stable' })
    const again = r.register({ key: 'worker-role', scope: 'system', priority: 10, text: 'Role: WORKER.\r\n', cacheability: 'stable' })
    const b = r.register({ key: 'worker-role', scope: 'system', priority: 10, text: 'Role: WORKER. Changed.', cacheability: 'stable' })
    expect(again).toBe(a)
    expect(a.id).toBe('worker-role@1')
    expect(b.id).toBe('worker-role@2')
    expect(b.hash).not.toBe(a.hash)
  })

  it('never emits the same immutable block twice in one request', () => {
    const r = new PromptComponentRegistry()
    const policy = r.register({ key: 'principles', scope: 'system', priority: 20, text: 'Investigate before claiming.', cacheability: 'stable' })
    const role = r.register({ key: 'role', scope: 'system', priority: 10, text: 'Role: WORKER.', cacheability: 'stable' })
    const samePolicy = r.register({ key: 'principles-again', scope: 'system', priority: 30, text: 'Investigate before claiming.', cacheability: 'stable' })
    const out = assemblePrompt([policy, role, samePolicy])
    expect(out.text).toBe('Role: WORKER.\n\nInvestigate before claiming.')
    expect(out.duplicates.map((d) => d.key)).toEqual(['principles-again'])
  })

  it('reports a stable block that sits after a volatile one, and does not move it', () => {
    const r = new PromptComponentRegistry()
    const task = r.register({ key: 'task', scope: 'user', priority: 1, text: 'Task t-1: fix the parser', cacheability: 'volatile' })
    const rules = r.register({ key: 'rules', scope: 'user', priority: 2, text: 'Never push.', cacheability: 'stable' })
    const out = assemblePrompt([task, rules])
    expect(out.components.map((c) => c.key)).toEqual(['task', 'rules'])
    expect(out.stableAfterVolatile).toBe(true)
    expect(out.stablePrefixTokens).toBe(0)
  })
})

describe('prefix hashing', () => {
  it('is deterministic and independent of tool order', () => {
    const a = prefixParts(identity())
    const b = prefixParts(identity({ tools: ['mcp__nexus__send_message', 'Bash', 'Edit', 'Read'] }))
    expect(b.hash).toBe(a.hash)
    expect(toolSetHash(['a', 'b', 'b'])).toBe(toolSetHash(['b', 'a']))
  })

  it('does not change with time, run or agent: nothing volatile is part of it', () => {
    const hashes = new Set<string>()
    for (let i = 0; i < 50; i++) hashes.add(prefixParts(identity()).hash)
    expect(hashes.size).toBe(1)
    // The identity has no field for a timestamp, a run id or an agent id.
    expect(Object.keys(identity()).sort()).toEqual(['dynamicSystem', 'effort', 'flags', 'model', 'provider', 'role', 'systemText', 'tools'])
  })

  it('changes when a tool, the model, the role text or a flag changes, and each change is attributable', () => {
    const base = prefixParts(identity())
    const tools = prefixParts(identity({ tools: ['Read', 'Edit', 'Bash'] }))
    const model = prefixParts(identity({ model: 'sonnet' }))
    const system = prefixParts(identity({ systemText: `${rolePrompt('worker', 'implement')}\nOne more rule.` }))
    expect(new Set([base.hash, tools.hash, model.hash, system.hash]).size).toBe(4)
    expect(tools.tools).not.toBe(base.tools)
    expect(tools.system).toBe(base.system)
    expect(model.model).not.toBe(base.model)
    expect(system.system).not.toBe(base.system)
    expect(partsFromList(base.hash, partsToList(base))).toEqual(base)
  })

  it('without the stable prefix the working directory is part of the prefix, so no two worktrees share one', () => {
    const off = (cwd: string) => prefixParts(identity({ flags: { stablePrefix: false, nexusToolsAlwaysLoaded: false, projectSettings: false, structuredOutput: false }, dynamicSystem: cwd }))
    expect(off('C:/wt/a').hash).not.toBe(off('C:/wt/b').hash)
    expect(prefixParts(identity()).hash).toBe(prefixParts(identity()).hash)
  })
})

describe('role prompts are a canonical prefix', () => {
  const purposes: Record<AgentRole, AgentPurpose> = { planner: 'plan', architect: 'research', worker: 'implement', debugger: 'diagnose', reviewer: 'review', verifier: 'verify', researcher: 'research', security_reviewer: 'review' }

  it('contain nothing that changes between requests', () => {
    for (const role of AGENT_ROLES) {
      const text = rolePrompt(role, purposes[role])
      const audit = auditPrompt([{ name: `${role} role prompt`, text, cacheability: 'stable', scope: 'system' }])
      expect(audit.findings.filter((f) => f.kind === 'dynamic_in_stable'), role).toEqual([])
      expect(rolePrompt(role, purposes[role])).toBe(text)
    }
  })

  it('keep every safety instruction: the principles and the tool list are in every role prompt', () => {
    for (const role of AGENT_ROLES) {
      const text = rolePrompt(role, purposes[role])
      expect(text).toContain('Never claim anything about code you did not inspect')
      expect(text).toContain('never delete, skip, or weaken a legitimate test')
      expect(text).toContain('mcp__nexus__report_blocker')
      expect(text).toContain('Do not spawn subagents')
    }
  })
})

describe('prompt auditor', () => {
  it('finds identical paragraphs, volatile text in a stable block, and passing-output spam', () => {
    const paragraph = 'Engineering principles: investigate before claiming, cite the file and line for every claim, and never weaken a legitimate test to make it pass.'
    const audit = auditPrompt([
      { name: 'role prompt', text: `Role: WORKER.\n\n${paragraph}`, cacheability: 'stable', scope: 'system' },
      { name: 'repair prompt', text: `Fix the failure.\n\n${paragraph}`, cacheability: 'volatile', scope: 'user' },
      { name: 'header', text: 'Run 3f2a9c1e-7b4d-4e1a-9c3f-2a1b4c5d6e7f started 2026-10-07T08:00:00.000Z', cacheability: 'stable', scope: 'system' },
      { name: 'check output', text: Array.from({ length: 40 }, (_, i) => `✔ test ${i} passes`).join('\n'), cacheability: 'volatile', scope: 'user' },
    ])
    const kinds = audit.findings.map((f) => `${f.kind}:${f.block}`)
    expect(kinds).toContain('duplicate_paragraph:repair prompt')
    expect(kinds).toContain('dynamic_in_stable:header')
    expect(kinds).toContain('passing_output_spam:check output')
    expect(audit.totalTokens).toBe(audit.blocks.reduce((n, b) => n + b.tokens, 0))
    expect(audit.blocks.reduce((n, b) => n + b.share, 0)).toBeCloseTo(1, 5)
  })

  it('does not call similar text a duplicate', () => {
    const a = 'The parser accepts version two and version three packets, and it rejects version one packets with a typed error for the caller.'
    const b = 'The parser accepts version two and version three packets, and it rejects version one packets with a typed error for the callers.'
    const audit = auditPrompt([
      { name: 'a', text: a, cacheability: 'volatile', scope: 'user' },
      { name: 'b', text: b, cacheability: 'volatile', scope: 'user' },
    ])
    expect(audit.findings).toEqual([])
  })

  it('reports a file injected twice and a tool schema that was loaded and never called', () => {
    const audit = auditPrompt([], { injectedFiles: ['src/a.ts', 'src/a.ts', 'src/b.ts'], toolSchemas: [{ name: 'mcp__big__query', tokens: 900 }, { name: 'Read', tokens: 400 }], toolsUsed: ['Read'] })
    expect(audit.findings.map((f) => `${f.kind}:${f.block}`).sort()).toEqual(['repeated_file:src/a.ts', 'unused_tool_schema:mcp__big__query'])
  })
})

describe('cache classification and diagnosis', () => {
  const at = '2026-10-07T10:00:00.000Z'
  const earlier = (minutes: number): string => new Date(Date.parse(at) - minutes * 60_000).toISOString()

  it('classifies a first request from what the runtime reported', () => {
    expect(classifyCacheResult({ inputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 8000 })).toBe('write')
    expect(classifyCacheResult({ inputTokens: 20, cacheReadTokens: 8000, cacheWriteTokens: 900 })).toBe('read')
    expect(classifyCacheResult({ inputTokens: 20, cacheReadTokens: 3000, cacheWriteTokens: 5000 })).toBe('partial')
    expect(classifyCacheResult({ inputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe('none')
  })

  it('names the part of the prefix that changed', () => {
    const current = prefixParts(identity())
    const d = (previous: PrefixIdentity) => diagnoseCache({ result: 'write', current, sameHash: null, previousForRole: prefixParts(previous), at })
    expect(d(identity({ tools: ['Read'] })).cause).toBe('TOOLS_CHANGED')
    expect(d(identity({ model: 'sonnet' })).cause).toBe('MODEL_CHANGED')
    expect(d(identity({ effort: 'high' })).cause).toBe('EFFORT_CHANGED')
    expect(d(identity({ systemText: 'other' })).cause).toBe('SYSTEM_CHANGED')
    expect(d(identity({ dynamicSystem: 'C:/wt/x' })).cause).toBe('DYNAMIC_PREFIX_CONTAMINATION')
    expect(d(identity({ tools: ['Read'] })).causeBasis).toBe('local_inference')
  })

  it('tells first use, expiry and an unexplained miss apart, and reports no cause for a read', () => {
    const current = prefixParts(identity())
    expect(diagnoseCache({ result: 'write', current, sameHash: null, previousForRole: null, at }).cause).toBe('FIRST_USE')
    const expired = diagnoseCache({ result: 'write', current, sameHash: { at: earlier(90), result: 'write' }, previousForRole: null, at })
    expect(expired).toMatchObject({ cause: 'EXPIRED', expectedWarm: false, reuseDistanceMs: 90 * 60_000 })
    const unexplained = diagnoseCache({ result: 'write', current, sameHash: { at: earlier(1), result: 'write' }, previousForRole: null, at })
    expect(unexplained).toMatchObject({ cause: 'UNKNOWN', expectedWarm: true })
    const read = diagnoseCache({ result: 'read', current, sameHash: { at: earlier(1), result: 'write' }, previousForRole: null, at })
    expect(read).toMatchObject({ cause: null, causeBasis: null, expectedWarm: true })
  })

  it('flags a large drop of the cached share and ignores small samples', () => {
    expect(cacheRateDrop({ inputTokens: 1_000, cacheReadTokens: 94_000, cacheWriteTokens: 5_000 }, { inputTokens: 2_000, cacheReadTokens: 8_000, cacheWriteTokens: 90_000 })).toEqual({ from: 0.94, to: 0.08 })
    expect(cacheRateDrop({ inputTokens: 10, cacheReadTokens: 940, cacheWriteTokens: 50 }, { inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 900 })).toBeNull()
    expect(cacheRateDrop({ inputTokens: 1_000, cacheReadTokens: 80_000, cacheWriteTokens: 19_000 }, { inputTokens: 1_000, cacheReadTokens: 75_000, cacheWriteTokens: 24_000 })).toBeNull()
  })
})

describe('check output filter', () => {
  const passing = (n: number): string => Array.from({ length: n }, (_, i) => `✔ slugify case ${i} (0.${i}ms)`).join('\n')
  const buried = `${passing(40)}\n✖ parser rejects v1 packets (2.1ms)\n  AssertionError: expected 'accepted' to be 'rejected'\n    at Object.<anonymous> (src/telemetry/parser.test.ts:41:18)\n${passing(400)}\nℹ tests 441\nℹ pass 440\nℹ fail 1`

  it('a failure buried before the tail stays visible, and everything the tail cut showed is still there', () => {
    const tail = filterOutput(buried, { failed: true, tailChars: 3000, mode: 'tail' })
    const superset = filterOutput(buried, { failed: true, tailChars: 3000, mode: 'superset' })
    expect(tail.text).not.toContain('parser rejects v1 packets')
    expect(superset.text).toContain('✖ parser rejects v1 packets')
    expect(superset.text).toContain("AssertionError: expected 'accepted' to be 'rejected'")
    expect(superset.text).toContain('src/telemetry/parser.test.ts:41:18')
    expect(superset.failureLinesShown).toBe(superset.failureLines)
    // Every line of the tail rendering (its omission marker aside) is in the superset rendering.
    for (const line of tail.text.split('\n').slice(1)) expect(superset.text).toContain(line)
    expect(superset.text).toMatch(/\[\.\.\. \d+ lines omitted; the full output is stored \.\.\.\]/)
  })

  it('never drops a failure line that the tail cut kept, on any output', () => {
    let seed = 7
    const rnd = (n: number): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
    for (let run = 0; run < 200; run++) {
      const lines = Array.from({ length: 50 + rnd(400) }, (_, i) => (rnd(25) === 0 ? `FAIL test ${i}: Error: boom ${i}` : `ok ${i} - passes ${'x'.repeat(rnd(60))}`))
      const output = lines.join('\n')
      const tail = filterOutput(output, { failed: true, tailChars: 1500, mode: 'tail' })
      const superset = filterOutput(output, { failed: true, tailChars: 1500, mode: 'superset' })
      const tailFailures = tail.text.split('\n').filter((l) => l.startsWith('FAIL'))
      for (const f of tailFailures) expect(superset.text.split('\n')).toContain(f)
      expect(superset.failureLinesShown).toBeGreaterThanOrEqual(tail.failureLinesShown)
    }
  })

  it('short output is untouched, and a passing run is shortened only in compact mode', () => {
    expect(filterOutput('all good\n3 passed', { failed: false, tailChars: 3000 })).toMatchObject({ text: 'all good\n3 passed', truncated: false })
    const long = `${passing(300)}\nℹ tests 300\nℹ pass 300\nℹ fail 0`
    const superset = filterOutput(long, { failed: false, tailChars: 3000, mode: 'superset' })
    const compact = filterOutput(long, { failed: false, tailChars: 3000, mode: 'compact' })
    const tail = filterOutput(long, { failed: false, tailChars: 3000, mode: 'tail' })
    expect(superset.shownChars).toBeGreaterThanOrEqual(tail.shownChars)
    expect(compact.shownChars).toBeLessThan(tail.shownChars / 3)
    expect(compact.text).toContain('ℹ pass 300')
    expect(compact.failureLines).toBe(0)
  })

  it('a run that exits 0 but prints a failure is not compacted away', () => {
    const output = `${passing(200)}\nError: unhandled rejection in teardown\n${passing(200)}`
    const compact = filterOutput(output, { failed: false, tailChars: 3000, mode: 'compact' })
    expect(compact.text).toContain('Error: unhandled rejection in teardown')
  })

  it('summarizes a run in one line', () => {
    expect(summarizeOutput(buried, 1, false)).toMatch(/^failed \(exit 1\); 446 lines, \d+ failure lines; .*ℹ fail 1/)
    expect(summarizeOutput('ok', 0, false)).toBe('passed; 1 lines')
    expect(summarizeOutput('', null, true)).toBe('timed out; 1 lines')
  })

  it('check results in a prompt show the buried failure and do not push a later check out', () => {
    const results = [
      { name: 'test', command: 'pnpm test', exitCode: 1, timedOut: false, durationMs: 10, output: buried, cwd: '.' },
      { name: 'lint', command: 'pnpm lint', exitCode: 1, timedOut: false, durationMs: 10, output: `${'src/a.ts:1:1 - warning: unused\n'.repeat(200)}src/b.ts:9:3 - error: no-undef`, cwd: '.' },
      { name: 'typecheck', command: 'pnpm typecheck', exitCode: 0, timedOut: false, durationMs: 10, output: 'ok', cwd: '.' },
    ] as never
    const old = renderChecks(results, 'tail') as string
    const now = renderChecks(results) as string
    expect(old).not.toContain('parser rejects v1 packets')
    expect(now).toContain('parser rejects v1 packets')
    for (const name of ['### test: FAILED (exit 1)', '### lint: FAILED (exit 1)', '### typecheck: PASSED']) expect(now).toContain(name)
    expect(now).toContain('the full output is stored by NEXUS')
    expect(SECTION_LIMITS.checkItem).toBe(3000)
  })
})

describe('context pressure, budget and session efficiency', () => {
  it('pressure levels follow the share of the window in use', () => {
    expect(pressureOf(10_000, 200_000)).toBe('LOW')
    expect(pressureOf(110_000, 200_000)).toBe('MODERATE')
    expect(pressureOf(150_000, 200_000)).toBe('HIGH')
    expect(pressureOf(180_000, 200_000)).toBe('CRITICAL')
    expect(pressureOf(null, 200_000)).toBe('LOW')
  })

  it('the graph budget narrows with pressure and widens with risk; risk wins', () => {
    const base = { windowTokens: 200_000, fixedTokens: 8_000, graphBudget: 2_000 }
    expect(allocateBudget({ ...base, historyTokens: 1_000, risk: 'low' }).graphTokens).toBe(2_000)
    expect(allocateBudget({ ...base, historyTokens: 150_000, risk: 'low' })).toMatchObject({ pressure: 'HIGH', graphTokens: 1_000 })
    expect(allocateBudget({ ...base, historyTokens: 150_000, risk: 'high' })).toMatchObject({ pressure: 'HIGH', graphTokens: 4_000 })
    expect(allocateBudget({ ...base, historyTokens: 1_000, risk: 'critical' }).graphTokens).toBe(6_000)
    expect(allocateBudget({ windowTokens: null, fixedTokens: null, historyTokens: 0, risk: 'medium', graphBudget: 2_000 }).freeTokens).toBeNull()
  })

  const session = { turns: 60, rotationTurns: 60, toolResultTokens: null, compactions: 0, canHandoff: true }

  it('with pressure rotation off the decision is exactly the 0.7.0 turn rule', () => {
    expect(decideSessionAction({ ...session, contextTokens: 20_000, maxTokens: 200_000, hitTurnLimit: true, pressureRotation: false }).action).toBe('HANDOFF_AND_ROTATE')
    expect(decideSessionAction({ ...session, contextTokens: 190_000, maxTokens: 200_000, hitTurnLimit: false, pressureRotation: false }).action).toBe('KEEP')
    expect(decideSessionAction({ ...session, rotationTurns: 0, contextTokens: null, maxTokens: null, hitTurnLimit: true, pressureRotation: false }).action).toBe('KEEP')
  })

  it('with pressure rotation on it does not rotate on a turn count alone', () => {
    const on = { ...session, pressureRotation: true }
    expect(decideSessionAction({ ...on, contextTokens: 20_000, maxTokens: 200_000, hitTurnLimit: true })).toMatchObject({ action: 'KEEP', pressure: 'LOW' })
    expect(decideSessionAction({ ...on, contextTokens: 120_000, maxTokens: 200_000, hitTurnLimit: true }).action).toBe('HANDOFF_AND_ROTATE')
    expect(decideSessionAction({ ...on, contextTokens: 180_000, maxTokens: 200_000, hitTurnLimit: false }).action).toBe('HANDOFF_AND_ROTATE')
    expect(decideSessionAction({ ...on, canHandoff: false, contextTokens: 180_000, maxTokens: 200_000, hitTurnLimit: false }).action).toBe('COMPACT')
    expect(decideSessionAction({ ...on, contextTokens: 150_000, maxTokens: 200_000, toolResultTokens: 100_000, hitTurnLimit: false }).action).toBe('CLEAR_STALE_TOOL_RESULTS')
    // No figure from the runtime: the turn rule, never a guess.
    expect(decideSessionAction({ ...on, contextTokens: null, maxTokens: null, hitTurnLimit: true }).action).toBe('HANDOFF_AND_ROTATE')
  })

  it('a result is left out of a prompt only when it is stored and no longer needed', () => {
    expect(resultState({ unresolved: true, superseded: true, stored: true, age: 5 })).toBe('PINNED')
    expect(resultState({ unresolved: false, superseded: true, stored: false, age: 5 })).toBe('ACTIVE')
    expect(resultState({ unresolved: false, superseded: true, stored: true, age: 5 })).toBe('STALE')
    expect(resultState({ unresolved: false, superseded: false, stored: true, age: 2 })).toBe('RETRIEVABLE')
    expect(resultState({ unresolved: false, superseded: false, stored: true, age: 0 })).toBe('ACTIVE')
    expect((['PINNED', 'ACTIVE', 'RETRIEVABLE', 'STALE'] as const).filter(mayLeaveOut)).toEqual(['RETRIEVABLE', 'STALE'])
  })
})

describe('quality non-regression gate', () => {
  const trial = (caseKey: string, over: Partial<TrialOutcome> = {}): TrialOutcome => ({ caseKey, hiddenPassed: true, acceptancePassed: true, firstPassVerified: true, criticalFindings: 0, highFindings: 0, repairs: 0, regressions: 0, humanInterventions: 0, wallClockMs: 60_000, inputTokens: 250_000, outputTokens: 10_000, turns: 30, ...over })
  const cases = (n: number): string[] => Array.from({ length: n }, (_, i) => `case-${i}`)

  it('rejects an optimization that saves tokens and loses quality', () => {
    const baseline = cases(10).map((c) => trial(c))
    const optimized = cases(10).map((c, i) => trial(c, { inputTokens: 100_000, hiddenPassed: i >= 3 }))
    const gate = evaluateGate(baseline, optimized)
    expect(gate.verdict).toBe('INFERIOR')
    expect(gate.mayBecomeDefault).toBe(false)
    expect(gate.inputTokenDelta).toBeCloseTo(-0.6, 5)
    expect(gate.regressions).toEqual(['case-0', 'case-1', 'case-2'])
  })

  it('keeps the baseline when there is too little evidence, however good it looks', () => {
    const gate = evaluateGate(cases(3).map((c) => trial(c)), cases(3).map((c) => trial(c, { inputTokens: 50_000 })))
    expect(gate).toMatchObject({ verdict: 'INSUFFICIENT_EVIDENCE', mayBecomeDefault: false, pairs: 3 })
  })

  it('accepts equal quality as non-inferior and better quality as improved', () => {
    const baseline = cases(10).map((c, i) => trial(c, { hiddenPassed: i !== 0 && i !== 1 }))
    expect(evaluateGate(baseline, cases(10).map((c, i) => trial(c, { hiddenPassed: i !== 0 && i !== 1, inputTokens: 200_000 }))).verdict).toBe('NON_INFERIOR')
    const better = evaluateGate(cases(12).map((c, i) => trial(c, { hiddenPassed: i >= 6 })), cases(12).map((c) => trial(c)))
    expect(better).toMatchObject({ verdict: 'IMPROVED', mayBecomeDefault: true })
  })

  it('a variant that is worse on no case is never inferior, however uneven its improvements are', () => {
    // What the real campaign of 0.7.1 produced: eight cases, seven equal and one that failed before and passes now.
    const baseline = cases(8).map((c, i) => trial(c, { hiddenPassed: i !== 0 }))
    const optimized = cases(8).map((c) => trial(c))
    const gate = evaluateGate(baseline, optimized)
    expect(gate.regressions).toEqual([])
    expect(gate.improvements).toEqual(['case-0'])
    // The normal-approximation bound is below the margin on the spread of that one improvement alone.
    expect(gate.passRateLowerBound).toBeLessThan(-0.05)
    expect(gate.verdict).toBe('NON_INFERIOR')
    expect(gate.mayBecomeDefault).toBe(true)
    // The same spread with one case worse is still refused: the bound applies as soon as anything dropped.
    const mixed = evaluateGate(cases(8).map((c, i) => trial(c, { hiddenPassed: i !== 0 })), cases(8).map((c, i) => trial(c, { hiddenPassed: i !== 1 })))
    expect(mixed.regressions).toEqual(['case-1'])
    expect(mixed.verdict).toBe('INFERIOR')
  })

  it('is stricter for high-risk work: more pairs, and one regression is enough to refuse', () => {
    const baseline = cases(16).map((c) => trial(c))
    const optimized = cases(16).map((c, i) => trial(c, { hiddenPassed: i !== 5 }))
    // One failure in sixteen cannot show non-inferiority within five points; a wider margin accepts it for ordinary work only.
    expect(evaluateGate(baseline, optimized, { risk: 'medium' }).verdict).toBe('INFERIOR')
    expect(evaluateGate(baseline, optimized, { risk: 'medium', margin: 0.2 }).verdict).toBe('NON_INFERIOR')
    expect(evaluateGate(baseline, optimized, { risk: 'high', margin: 0.2 }).verdict).toBe('INFERIOR')
    expect(evaluateGate(cases(10).map((c) => trial(c)), cases(10).map((c) => trial(c)), { risk: 'critical' }).verdict).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('refuses when critical findings or repairs rise even if everything passes', () => {
    const baseline = cases(8).map((c) => trial(c))
    expect(evaluateGate(baseline, cases(8).map((c, i) => trial(c, { repairs: i < 4 ? 1 : 0 }))).verdict).toBe('INFERIOR')
    expect(evaluateGate(baseline, cases(8).map((c, i) => trial(c, { highFindings: i }))).verdict).toBe('NON_INFERIOR')
  })

  it('scores retrieval: recall, precision, and a wrong node only when it is shown without a warning', () => {
    const c = { key: 'k', required: ['a', 'b'], forbidden: ['old'] }
    expect(scoreRetrieval(c, [{ path: 'a', warned: false }, { path: 'x', warned: false }], 100)).toMatchObject({ recall: 0.5, precision: 0.5, missed: ['b'], wrong: [] })
    expect(scoreRetrieval(c, [{ path: 'a', warned: false }, { path: 'b', warned: false }, { path: 'old', warned: false }], 100).wrong).toEqual(['old'])
    expect(scoreRetrieval(c, [{ path: 'a', warned: false }, { path: 'b', warned: false }, { path: 'old', warned: true }], 100).wrong).toEqual([])
    expect(scoreRetrieval({ key: 'e', required: [], forbidden: [] }, [], 0)).toMatchObject({ recall: 1, precision: 1 })
  })
})

describe('provider capabilities and tool planning', () => {
  it('Codex gets no Claude-specific capability and unknown providers get none at all', () => {
    expect(capabilitiesOf('claude')).toMatchObject({ stableSystemPrefix: true, alwaysLoadTools: true, contextUsageBreakdown: true, nexusTools: true })
    expect(capabilitiesOf('codex')).toMatchObject({ stableSystemPrefix: false, alwaysLoadTools: false, contextUsageBreakdown: false, perRequestUsage: false, toolSearch: false, nexusTools: false })
    expect(capabilitiesOf('gemini')).toMatchObject({ promptCaching: 'none', sessionResume: false })
  })

  it('tool loading follows the setting and the size of the tool set', () => {
    const on = { ...DEFAULT_TOKEN_SETTINGS, toolLoading: 'on' as const }
    expect(planTools({ nexusTools: 9, externalServers: 0, settings: on })).toMatchObject({ alwaysLoadNexusTools: true, action: 'LOAD_TOOLS_UPFRONT' })
    expect(planTools({ nexusTools: 40, externalServers: 0, settings: on })).toMatchObject({ alwaysLoadNexusTools: false, action: 'DEFER_TOOLS' })
    expect(planTools({ nexusTools: 9, externalServers: 0, settings: { ...on, toolLoading: 'off' } }).alwaysLoadNexusTools).toBe(false)
    expect(planTools({ nexusTools: 0, externalServers: 3, settings: on }).alwaysLoadNexusTools).toBe(false)
  })

  it('the defaults are QUALITY_FIRST: only what is lossless is on without evidence', () => {
    expect(DEFAULT_TOKEN_SETTINGS.mode).toBe('QUALITY_FIRST')
    expect(AUTO_DEFAULTS.outputFiltering).toBe(true)
    expect(AUTO_DEFAULTS.pressureRotation).toBe(false)
    expect(techniqueEnabled({ ...DEFAULT_TOKEN_SETTINGS, contextGraph: 'on' }, 'contextGraph')).toBe(true)
    expect(techniqueEnabled({ ...DEFAULT_TOKEN_SETTINGS, outputFiltering: 'off' }, 'outputFiltering')).toBe(false)
    expect(checkOutputMode(DEFAULT_TOKEN_SETTINGS)).toBe('superset')
    expect(checkOutputMode({ ...DEFAULT_TOKEN_SETTINGS, outputFiltering: 'off' })).toBe('tail')
    expect(checkOutputMode({ ...DEFAULT_TOKEN_SETTINGS, outputFiltering: 'on' })).toBe('compact')
    const options = planContextOptions({ settings: DEFAULT_TOKEN_SETTINGS, nexusTools: 5, externalServers: 0 }).options
    expect(options.stablePrefix).toBe(AUTO_DEFAULTS.stablePrefix)
    expect(options.contextUsageDetail).toBe('summary')
  })

  it('settings stored before 0.7.1 read as the defaults', () => {
    const { tokens: _dropped, ...old } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(old).tokens).toEqual(DEFAULT_TOKEN_SETTINGS)
  })
})

describe('request component accounting', () => {
  const usage = (over: Partial<RuntimeContextUsage> = {}): RuntimeContextUsage => ({
    detail: 'full',
    model: 'claude-opus-5-5',
    totalTokens: 54_318,
    maxTokens: 200_000,
    categories: [{ name: 'System prompt', tokens: 4_000, kind: 'used' }, { name: 'System tools', tokens: 9_000, kind: 'used' }, { name: 'MCP tools', tokens: 1_200, kind: 'used' }, { name: 'Messages', tokens: 40_118, kind: 'used' }, { name: 'MCP tools (deferred)', tokens: 5_000, kind: 'deferred' }, { name: 'Free space', tokens: 145_682, kind: 'free' }],
    systemPromptSections: [{ name: 'core', tokens: 3_000 }, { name: 'append', tokens: 1_000 }],
    systemTools: [{ name: 'Read', tokens: 5_000 }, { name: 'Bash', tokens: 4_000 }],
    mcpTools: [{ name: 'mcp__nexus__send_message', serverName: 'nexus', tokens: 1_200, isLoaded: true }, { name: 'mcp__big__query', serverName: 'big', tokens: 5_000, isLoaded: false }],
    memoryFiles: [],
    messageBreakdown: { toolCallTokens: 2_000, toolResultTokens: 24_000, attachmentTokens: 0, assistantMessageTokens: 8_118, userMessageTokens: 6_000, toolCallsByType: [] },
    ...over,
  })
  const pack = { entries: [{ section: 'Task', included: true, chars: 2_000 }, { section: 'Repository intelligence', included: true, chars: 1_600 }, { section: 'Project knowledge', included: true, chars: 4_000 }, { section: 'Project memory', included: false, chars: 9_999 }] as never }

  it('answers "why did this request contain 54,318 tokens": every component sums to the runtime total', () => {
    const b = buildBreakdown({ usage: usage(), pack, roleText: 'x'.repeat(3_600) })
    expect(b.totalTokens).toBe(54_318)
    expect(b.components.reduce((n, c) => n + c.tokens, 0)).toBe(54_318)
    const of = (c: string): number => b.components.filter((x) => x.component === c).reduce((n, x) => n + x.tokens, 0)
    expect(of('TOOL_RESULTS')).toBe(24_000)
    expect(of('TOOL_DEFINITIONS')).toBe(10_200)
    expect(of('ROLE')).toBe(900)
    expect(of('SYSTEM_CORE')).toBe(3_100)
    expect(of('CONTEXT_GRAPH')).toBe(1_000)
    expect(of('TASK')).toBe(500)
    expect(of('PROJECT_FACTS')).toBe(400)
    expect(of('HISTORY')).toBe(10_118)
    // The excluded pack entry is not counted, and deferred tool schemas are not in the window.
    expect(of('MEMORY')).toBe(0)
    // One estimated component makes the breakdown an estimate.
    expect(b.basis).toBe('estimated')
    expect(b.components.find((c) => c.component === 'TOOL_RESULTS')?.basis).toBe('exact')
  })

  it('labels a summary breakdown observed and an estimate-only breakdown estimated', () => {
    expect(buildBreakdown({ usage: usage({ detail: 'summary' }), pack: null, roleText: '' }).components.every((c) => c.basis === 'estimated')).toBe(true)
    const estimate = buildBreakdown({ usage: null, pack, roleText: 'x'.repeat(400), promptText: 'y'.repeat(12_000) })
    expect(estimate.basis).toBe('estimated')
    expect(estimate.maxTokens).toBeNull()
    expect(estimate.totalTokens).toBe(100 + 3_000)
  })

  it('reads the runtime rows when a summary leaves the lists empty, and drops a message split that cannot be right', () => {
    // The shape the real runtime returned for a one-turn session in summary detail.
    const real = usage({
      detail: 'summary',
      totalTokens: 24_873,
      categories: [{ name: 'System prompt', tokens: 4_545, kind: 'used' }, { name: 'System tools', tokens: 17_843, kind: 'used' }, { name: 'MCP tools', tokens: 2_484, kind: 'used' }, { name: 'Messages', tokens: 1, kind: 'used' }, { name: 'Free space', tokens: 175_127, kind: 'free' }],
      systemPromptSections: [],
      systemTools: [],
      mcpTools: [],
      messageBreakdown: { toolCallTokens: 0, toolResultTokens: 0, attachmentTokens: 26_005, assistantMessageTokens: 171, userMessageTokens: 13, toolCallsByType: [] },
    })
    const b = buildBreakdown({ usage: real, pack: null, roleText: 'x'.repeat(3_800) })
    const of = (c: string): number => b.components.filter((x) => x.component === c).reduce((n, x) => n + x.tokens, 0)
    expect(b.totalTokens).toBe(24_873)
    expect(b.components.reduce((n, c) => n + c.tokens, 0)).toBe(24_873)
    expect(of('SYSTEM_CORE') + of('ROLE')).toBe(4_545)
    expect(of('TOOL_DEFINITIONS')).toBe(20_327)
    expect(of('HISTORY')).toBe(1)
    expect(of('OTHER')).toBe(0)
    expect(b.basis).toBe('estimated')
  })

  it('composition percentages are whole numbers that sum to 100', () => {
    const rows = composition(buildBreakdown({ usage: usage(), pack, roleText: 'x'.repeat(3_600) }).components)
    expect(rows.reduce((n, r) => n + r.percent, 0)).toBe(100)
    expect(rows.every((r) => Number.isInteger(r.percent))).toBe(true)
    expect(rows[0]?.component).toBe('TOOL_RESULTS')
    expect(composition([])).toEqual([])
  })

  it('validates the runtime response: wrong shapes give null, numbers are bounded, names are cut', () => {
    expect(parseContextUsage(null, 'summary')).toBeNull()
    expect(parseContextUsage({ categories: [] }, 'summary')).toBeNull()
    const parsed = parseContextUsage({ totalTokens: 1234.6, rawMaxTokens: 200000, model: 'm', categories: [{ name: 'x'.repeat(500), tokens: -5, kind: 'weird' }, 'junk', { name: 'Deferred', tokens: 9, isDeferred: true }], mcpTools: [{ name: 'a', serverName: 's', tokens: 3, isLoaded: 'yes' }], messageBreakdown: { toolResultTokens: 7 } }, 'full')
    expect(parsed).toMatchObject({ detail: 'full', totalTokens: 1235, maxTokens: 200000 })
    expect(parsed?.categories).toEqual([{ name: 'x'.repeat(160), tokens: 0, kind: 'used' }, { name: 'Deferred', tokens: 9, kind: 'deferred' }])
    expect(parsed?.mcpTools[0]?.isLoaded).toBeNull()
    expect(parsed?.messageBreakdown).toMatchObject({ toolResultTokens: 7, toolCallTokens: 0 })
  })

  it('token estimates and bases', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcde')).toBe(2)
    expect(weakestBasis(['exact', 'observed'])).toBe('observed')
    expect(weakestBasis(['exact', 'estimated', 'observed'])).toBe('estimated')
    expect(weakestBasis([])).toBe('exact')
  })
})
