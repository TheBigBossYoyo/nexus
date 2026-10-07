import { describe, expect, it } from 'vitest'
import type { RuntimeContextUsage } from '@main/modules/agent-runtime/types'
import { createTranslatorState, translateSdkMessage } from '@main/modules/agent-runtime/translate'
import { renderChecks, SECTION_LIMITS, truncateHead } from '@main/modules/context/render'
import { createRepositories, openDatabase } from '@main/modules/persistence'
import { MAX_EARLY_CHARS, TokenIntelligenceEngine, buildBreakdown, evaluateGate, filterOutput, isFailureLine, isSummaryLine, type TrialOutcome } from '@main/modules/token'
import { makeAgent, makeProject, makeRun } from '../../integration/persistence/fixtures'

/** Cases found by the 0.7.1 review of token accounting. Each one failed before its fix. */

describe('check output is bounded whatever a command prints', () => {
  const TAIL = SECTION_LIMITS.checkItem

  it('one enormous line cannot exceed the budget, in the tail or before it', () => {
    const huge = `FAIL ${'x'.repeat(2_000_000)} Error: boom`
    for (const output of [huge, `${huge}\n${'ok\n'.repeat(50)}`, `${'ok\n'.repeat(50)}${huge}`, `${huge}\n${huge}\n${huge}`, `${'Tests 1 passed '.repeat(100_000)}\nok`]) {
      for (const mode of ['superset', 'compact', 'tail'] as const) {
        const shown = filterOutput(output, { failed: true, tailChars: TAIL, mode })
        expect(shown.text.length).toBeLessThanOrEqual(TAIL + MAX_EARLY_CHARS)
      }
    }
  })

  it('many short failure lines cannot multiply the omission markers past the budget', () => {
    const output = Array.from({ length: 20_000 }, (_, i) => (i % 9 === 0 ? `E  x${i}` : '')).join('\n')
    const shown = filterOutput(output, { failed: true, tailChars: TAIL })
    expect(shown.text.length).toBeLessThanOrEqual(TAIL + MAX_EARLY_CHARS)
  })

  it('the check section of a prompt stays bounded with hostile output in every check', () => {
    const hostile = `${`FAIL ${'y'.repeat(500_000)}\n`.repeat(3)}${'ok\n'.repeat(2_000)}`
    const results = Array.from({ length: 6 }, (_, i) => ({ name: `check-${i}`, command: 'run', exitCode: 1, timedOut: false, durationMs: 1, output: hostile, cwd: '.' })) as never
    const text = renderChecks(results) as string
    expect(text.length).toBeLessThanOrEqual(SECTION_LIMITS.checks + 6 * (MAX_EARLY_CHARS + 200) + 200)
  })

  it('pattern matching stays fast on lines built to make a pattern backtrack', () => {
    const lines = [`    at ${'a '.repeat(200_000)}`, `==== ${'passed '.repeat(100_000)}`, `${' '.repeat(300_000)}at x`, `${'= '.repeat(200_000)}`, `Tests ${'x'.repeat(400_000)}`]
    const started = Date.now()
    for (const line of lines) {
      isFailureLine(line)
      isSummaryLine(line)
    }
    filterOutput(lines.join('\n'), { failed: true, tailChars: TAIL })
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('a failure at the start or the end of a very long line is still recognized', () => {
    expect(isFailureLine(`Error: boom ${'x'.repeat(50_000)}`)).toBe(true)
    expect(isFailureLine(`${'x'.repeat(50_000)} 3 failed`)).toBe(true)
    expect(isFailureLine('x'.repeat(50_000))).toBe(false)
  })

  it('shows exactly the characters the 0.7.0 rendering showed, after anything it adds', () => {
    let seed = 11
    const rnd = (n: number): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
    for (let run = 0; run < 300; run++) {
      const eol = run % 3 === 0 ? '\r\n' : '\n'
      const lines = Array.from({ length: 1 + rnd(300) }, (_, i) => (rnd(20) === 0 ? `FAIL test ${i}: Error: boom ${'z'.repeat(rnd(900))}` : `ok ${i} ${'x'.repeat(rnd(120))}`))
      const output = lines.join(eol)
      const normalized = output.replace(/\r\n?/g, '\n').trim()
      const old = normalized.length <= 700 ? normalized : normalized.slice(normalized.length - 700)
      const now = filterOutput(output, { failed: true, tailChars: 700 })
      expect(now.text.endsWith(old)).toBe(true)
      // And the 0.7.0 function itself, on output without carriage returns, ends in the same characters.
      if (eol === '\n') expect(truncateHead(output.trim(), 700).endsWith(old)).toBe(true)
    }
  })
})

describe('quality gate: no evidence is not equal quality', () => {
  const trial = (caseKey: string, over: Partial<TrialOutcome> = {}): TrialOutcome => ({ caseKey, hiddenPassed: true, acceptancePassed: true, firstPassVerified: true, criticalFindings: 0, highFindings: 0, repairs: 0, regressions: 0, humanInterventions: 0, wallClockMs: 60_000, inputTokens: 250_000, outputTokens: 10_000, turns: 30, ...over })
  const cases = (n: number): string[] => Array.from({ length: n }, (_, i) => `case-${i}`)

  it('nothing passing on either side decides nothing', () => {
    const gate = evaluateGate(cases(10).map((c) => trial(c, { hiddenPassed: false })), cases(10).map((c) => trial(c, { hiddenPassed: false, inputTokens: 100_000 })))
    expect(gate).toMatchObject({ verdict: 'INSUFFICIENT_EVIDENCE', mayBecomeDefault: false })
  })

  it('a baseline case with no optimized trial is not assumed to pass', () => {
    const gate = evaluateGate(cases(12).map((c) => trial(c)), cases(10).map((c) => trial(c)))
    expect(gate).toMatchObject({ verdict: 'INSUFFICIENT_EVIDENCE', mayBecomeDefault: false })
    expect(gate.reasons.join(' ')).toContain('case-10')
  })

  it('identical outcomes with zero variance are non-inferior only when something passed', () => {
    expect(evaluateGate(cases(10).map((c) => trial(c)), cases(10).map((c) => trial(c))).verdict).toBe('NON_INFERIOR')
  })
})

describe('request breakdown never exceeds the runtime total', () => {
  const usage = (over: Partial<RuntimeContextUsage> = {}): RuntimeContextUsage => ({
    detail: 'full',
    model: 'm',
    totalTokens: 10_000,
    maxTokens: 200_000,
    categories: [],
    systemPromptSections: [{ name: 'core', tokens: 4_000 }],
    systemTools: [{ name: 'Read', tokens: 5_000 }],
    mcpTools: [{ name: 'mcp__a__b', serverName: 'a', tokens: 6_000 }] as never,
    memoryFiles: [{ path: 'CLAUDE.md', tokens: 3_000 }] as never,
    messageBreakdown: null as never,
    ...over,
  })

  it('parts that claim more than the total are scaled to it and labelled estimates', () => {
    const b = buildBreakdown({ usage: usage(), pack: null, roleText: 'x'.repeat(400) })
    expect(b.totalTokens).toBe(10_000)
    expect(b.components.reduce((n, c) => n + c.tokens, 0)).toBe(10_000)
    expect(b.components.every((c) => c.basis === 'estimated' && c.tokens > 0)).toBe(true)
    expect(b.basis).toBe('estimated')
  })

  it('parts always add up to the total exactly, on any figures', () => {
    let seed = 5
    const rnd = (n: number): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
    for (let run = 0; run < 300; run++) {
      const u = usage({
        totalTokens: 1 + rnd(120_000),
        systemPromptSections: [{ name: 'core', tokens: rnd(9_000) }],
        systemTools: [{ name: 'Read', tokens: rnd(30_000) }],
        mcpTools: [{ name: 'mcp__a__b', serverName: 'a', tokens: rnd(9_000), isLoaded: rnd(2) === 0 }] as never,
        memoryFiles: rnd(2) === 0 ? [] : ([{ path: 'CLAUDE.md', tokens: rnd(4_000) }] as never),
        messageBreakdown: rnd(3) === 0 ? (null as never) : { toolCallTokens: rnd(5_000), toolResultTokens: rnd(40_000), attachmentTokens: rnd(100), assistantMessageTokens: rnd(9_000), userMessageTokens: rnd(9_000), toolCallsByType: [] },
      })
      const pack = { entries: [{ section: 'Task', included: true, chars: rnd(9_000) }, { section: 'Project knowledge', included: true, chars: rnd(9_000) }] as never }
      const b = buildBreakdown({ usage: u, pack, roleText: 'x'.repeat(rnd(8_000)) })
      expect(b.components.reduce((n, c) => n + c.tokens, 0)).toBe(b.totalTokens)
      expect(b.components.every((c) => c.tokens > 0)).toBe(true)
    }
  })
})

describe('a request is what the API answered', () => {
  const assistant = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'assistant', parent_tool_use_id: null, uuid: 'u', session_id: 's', message: { content: [], ...message }, ...extra }) as never
  const usages = (messages: unknown[]) => {
    const state = createTranslatorState({ expectStructuredOutput: false })
    return messages.flatMap((m) => translateSdkMessage(m as never, state)).filter((e) => e.type === 'request.usage')
  }
  const real = { input_tokens: 12, output_tokens: 300, cache_read_input_tokens: 15_000, cache_creation_input_tokens: 900 }

  it('counts one response once, however many messages carry it', () => {
    expect(usages([assistant({ id: 'msg_1', model: 'claude-opus-5-5', usage: real }), assistant({ id: 'msg_1', model: 'claude-opus-5-5', usage: real }), assistant({ id: 'msg_2', model: 'claude-opus-5-5', usage: real })])).toHaveLength(2)
  })

  it('a message the runtime made up is no request and takes no place in the numbering', () => {
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const out = usages([
      assistant({ id: 'synthetic-1', model: '<synthetic>', usage: real }, { error: 'rate_limit' }),
      assistant({ id: 'msg_0', model: 'claude-opus-5-5', usage: zero }, { error: 'authentication_failed' }),
      assistant({ id: '', model: 'claude-opus-5-5', usage: real }),
      assistant({ id: 'msg_none', model: 'claude-opus-5-5' }),
      assistant({ id: 'msg_1', model: 'claude-opus-5-5', usage: real }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ requestId: 'msg_1', cacheReadTokens: 15_000 })
  })

  it('an error that carries real usage (the output limit) is a request', () => {
    expect(usages([assistant({ id: 'msg_9', model: 'claude-opus-5-5', usage: real }, { error: 'max_output_tokens' })])).toHaveLength(1)
  })
})

describe('sessions that continue a conversation are not diagnosed as first requests', () => {
  const setup = () => {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const project = repos.projects.insert(makeProject())
    const run = repos.runs.insert(makeRun(project.id))
    let t = Date.parse('2026-10-07T09:00:00.000Z')
    const engine = new TokenIntelligenceEngine({ repos, now: () => new Date((t += 1000)).toISOString() })
    const agent = (): string => {
      const a = repos.agents.insert(makeAgent(run.id, null, { role: 'worker' as never }))
      engine.planSession({ runId: run.id, taskId: null, agentId: a.id, role: 'worker', model: 'opus', effort: null, cwd: 'C:/wt', systemText: 'Role: worker.', tools: ['Read', 'Edit'], nexusToolNames: ['send_message'], externalServers: [], loadProjectSettings: false, structuredOutput: false, settings: undefined })
      return a.id
    }
    const request = (agentId: string, id: string, read: number, write: number) => engine.requestUsage(agentId, 'sdk', { requestId: id, model: 'claude-opus-5-5', inputTokens: 10, cacheReadTokens: read, cacheCreationTokens: write, outputTokens: 1 })!
    return { db, repos, engine, agent, request, run }
  }

  it('a resumed session keeps numbering and gets no cause; a fresh session after it is compared with the agent’s own earlier use', () => {
    const { db, engine, agent, request } = setup()
    const a = agent()
    engine.sessionStarted(a, { provider: 'claude', model: 'claude-opus-5-5' })
    const first = request(a, 'r0', 0, 16_000)
    expect(first).toMatchObject({ requestIndex: 0, cause: 'FIRST_USE' })
    expect(request(a, 'r1', 16_000, 500)).toMatchObject({ requestIndex: 1, cause: null })

    // Continued after a turn limit: the same conversation, resumed.
    engine.sessionStarted(a, { provider: 'claude', model: 'claude-opus-5-5' }, { resumed: true })
    const resumed = request(a, 'r2', 0, 17_000)
    expect(resumed).toMatchObject({ requestIndex: 2, cause: null, expectedWarm: false })
    expect(resumed.prefixHash).toBe(first.prefixHash)

    // The handoff request sends no tools: it is not a use of the planned prefix.
    engine.sessionStarted(a, { provider: 'claude', model: 'claude-opus-5-5' }, { resumed: true, handoff: true })
    expect(request(a, 'r3', 0, 9_000)).toMatchObject({ prefixHash: null, cause: null })

    // The fresh session after the rotation: first request again, compared with this agent's own earlier use.
    engine.sessionStarted(a, { provider: 'claude', model: 'claude-opus-5-5' })
    const fresh = request(a, 'r4', 0, 16_000)
    expect(fresh.requestIndex).toBe(0)
    expect(fresh.prefixHash).toBe(first.prefixHash)
    expect(fresh.expectedWarm).toBe(true)
    expect(fresh.cause).toBe('UNKNOWN')
    db.close()
  })

  it('a request id seen twice is counted once, and usage for an unknown agent is ignored', () => {
    const { db, repos, engine, agent, request, run } = setup()
    const a = agent()
    engine.sessionStarted(a, { provider: 'claude', model: 'claude-opus-5-5' })
    request(a, 'r0', 0, 16_000)
    expect(engine.requestUsage(a, 'sdk', { requestId: 'r0', model: null, inputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1, outputTokens: 1 })).toBeNull()
    expect(engine.requestUsage('nobody', 'sdk', { requestId: 'r9', model: null, inputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1, outputTokens: 1 })).toBeNull()
    expect(repos.cacheEvents.listByRun(run.id)).toHaveLength(1)
    engine.sessionClosed(a)
    expect(engine.requestUsage(a, 'sdk', { requestId: 'r1', model: null, inputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1, outputTokens: 1 })).toBeNull()
    db.close()
  })
})
