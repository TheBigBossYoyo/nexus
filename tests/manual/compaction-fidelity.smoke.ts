// Manual acceptance against the REAL Claude runtime: ONE long session, compacted once on purpose, with the
// durable requirements of its task established before the compaction and checked after it. Consumes usage
// (one worker session of six turns). Run with `pnpm accept:compaction`. Writes evidence to docs/acceptance.
//
// What is and is not tested:
//  - the compaction is the runtime's own (the same summariser a full context triggers), started by sending
//    `/compact` to the session. NEXUS never does that in a mission; it is the supported way to reach the
//    path without filling a window of 100,000 tokens or more. The automatic trigger is NOT exercised;
//  - "retained" means the session can restate the fact with no tool call after the compaction. A fact that
//    is also in a file of the repository can be read again and is marked so; the facts that exist only in
//    the conversation are the real test of the summary;
//  - after the compaction the session continues the task, and a hidden evaluation judges the result.
// Nothing is faked: if the runtime reports no compaction, the evidence says NOT VERIFIED.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeSdkRuntime } from '@main/modules/agent-runtime/claude-sdk-runtime'
import { resolveClaudeExecutable } from '@main/modules/agent-runtime/resolve-executable'
import type { AgentEvent, NexusToolHandlers, SessionSpec } from '@main/modules/agent-runtime/types'
import { rolePrompt } from '@main/modules/context/prompts'
import { createAuthorizer } from '@main/modules/policies/authorizer'
import { toolsForRole } from '@main/modules/policies/tools'

const MODEL = process.env['NEXUS_COMPACTION_MODEL'] ?? 'sonnet'

const FILES: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'ratelimit', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  'README.md': '# ratelimit\n\nRequest rate limiting for the gateway. Nothing is implemented yet.\n',
  'config/limits.json': '{}\n',
  'src/limiter/window.js': "/** Counts the requests of a key inside a sliding window. KNOWN DEFECT BUG-412: a request exactly on the boundary is counted in both windows. */\nexport function inWindow(timestamps, now, windowMs) {\n  return timestamps.filter((t) => now - t <= windowMs).length\n}\n",
  'src/limiter/window.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { inWindow } from './window.js'\n\ntest('counts the requests inside the window', () => {\n  assert.equal(inWindow([100, 200, 900], 1000, 500), 1)\n})\n",
}

const BRIEF = `You are implementing rate limiting for the gateway in this repository. This first message is the task brief. Keep every item of it: later messages build on it and will not repeat it.

OBJECTIVE
Add a token-bucket rate limiter per client key to the gateway, with a retry schedule clients can follow.

ACCEPTANCE CRITERIA
AC1. A client key gets at most the bucket capacity of requests in a burst, and tokens refill one at a time at the refill interval.
AC2. All time comes from an injected clock; no test sleeps.
AC3. node --test passes, including a test for refill after an empty bucket.

NUMERIC VALUES
- Bucket capacity: 37 tokens.
- Refill interval: 250 milliseconds per token.
- Burst multiplier of the retry schedule: 1.6 (each retry delay is the previous one times 1.6). This value is not written in any file yet.
- Maximum retries: 6. This value is not written in any file yet.

PATHS
- src/limiter/bucket.js: the token bucket (step 1).
- src/limiter/schedule.js: the refill schedule helper (step 2).
- src/limiter/retry.js: the retry schedule (a later step).
- config/limits.json: capacity and refill interval only.

DECISIONS ALREADY TAKEN
- D1: token counts are integers; no fractional tokens are ever stored.
- D2: the clock is injected as a function now() returning milliseconds; Date.now is only its default.

OPEN BUGS, NOT PART OF THIS TASK
- BUG-412: src/limiter/window.js counts a request exactly on the window boundary in both windows. Do not fix it and do not edit that file; another team owns it.
- BUG-431: the gateway's health endpoint is rate limited like any other. Out of scope.

SECURITY CONSTRAINTS
- S1: a client key is never written to a log. A log line carries the first 12 hexadecimal characters of the SHA-256 of the key instead.
- S2: config/limits.json is read from its fixed path only; a path that comes from a request is never used to load limits.

PROJECT KNOWLEDGE REFERENCES
- context://project/ratelimit/decisions/integer-token-arithmetic
- notes/limiter/burst-factor-origin-3fa9c1

STEP 1 (do this now, nothing else): write capacity and refill interval into config/limits.json, implement createBucket({ capacity, refillMs, now }) in src/limiter/bucket.js with tryTake(key) returning true or false, and write src/limiter/bucket.test.js. Run node --test. Then stop and report which files you changed and which tests exist.`

const STEP2 = 'STEP 2: add src/limiter/schedule.js exporting nextRefillAt(lastRefill, tokens, capacity, refillMs): the time at which the bucket next gains a token, or null when it is full. Follow the decisions of the brief. Write src/limiter/schedule.test.js with at least four cases, run node --test, and report the files changed in this step and the tests that now exist.'

const PROBE = 'Do not use any tool for this message. From what you know of this task right now, answer with one JSON object and nothing else, with exactly these keys: "objective" (string), "acceptanceCriteria" (array of strings), "capacity" (number), "refillMs" (number), "burstMultiplier" (number), "maxRetries" (number), "paths" (array of the file paths the brief named), "decisions" (array of strings), "openBugs" (array of strings, each with its id and what must be done about it), "securityConstraints" (array of strings), "filesChanged" (array of the files you created or edited so far), "tests" (array of the test files that exist), "contextRefs" (array of the project knowledge references, exactly as written). Use null for anything you do not know; do not guess.'

const STEP3 = "STEP 3: implement src/limiter/retry.js exporting retryDelays(): the delays in milliseconds of the retry schedule, one per retry up to the maximum number of retries, starting at the refill interval and applying the burst multiplier each time, each rounded to the nearest integer; and logKey(key): the text a log line carries for a client key under the security constraints of the brief. Write src/limiter/retry.test.js and run node --test. Respect the open bugs as the brief said."

/** What the session must still know. `inRepository` marks facts a file also holds by the time of the compaction. */
const FACTS: { key: string; group: string; inRepository: boolean; holds: (a: Record<string, unknown>) => boolean }[] = (() => {
  const text = (v: unknown): string => JSON.stringify(v ?? '').toLowerCase()
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : [])
  return [
    { key: 'objective', group: 'objective', inRepository: false, holds: (a) => /token.?bucket/.test(text(a['objective'])) && /retry/.test(text(a['objective'])) },
    { key: 'AC1 burst and refill', group: 'acceptance criteria', inRepository: false, holds: (a) => /burst|capacity/.test(text(a['acceptanceCriteria'])) && /refill/.test(text(a['acceptanceCriteria'])) },
    { key: 'AC2 injected clock, no sleeping', group: 'acceptance criteria', inRepository: false, holds: (a) => /inject|clock/.test(text(a['acceptanceCriteria'])) && /sleep/.test(text(a['acceptanceCriteria'])) },
    { key: 'AC3 tests pass, refill after empty', group: 'acceptance criteria', inRepository: false, holds: (a) => /node --test|tests? pass/.test(text(a['acceptanceCriteria'])) && /empty/.test(text(a['acceptanceCriteria'])) },
    { key: 'capacity 37', group: 'numeric values', inRepository: true, holds: (a) => a['capacity'] === 37 },
    { key: 'refill 250 ms', group: 'numeric values', inRepository: true, holds: (a) => a['refillMs'] === 250 },
    { key: 'burst multiplier 1.6', group: 'numeric values', inRepository: false, holds: (a) => a['burstMultiplier'] === 1.6 },
    { key: 'maximum retries 6', group: 'numeric values', inRepository: false, holds: (a) => a['maxRetries'] === 6 },
    ...['src/limiter/bucket.js', 'src/limiter/schedule.js', 'src/limiter/retry.js', 'config/limits.json'].map((p) => ({ key: `path ${p}`, group: 'paths', inRepository: p !== 'src/limiter/retry.js', holds: (a: Record<string, unknown>) => list(a['paths']).some((x) => x.replace(/\\/g, '/').endsWith(p)) })),
    { key: 'D1 integer tokens', group: 'decisions', inRepository: false, holds: (a) => /integer/.test(text(a['decisions'])) },
    { key: 'D2 injected clock now()', group: 'decisions', inRepository: false, holds: (a) => /now\(\)|inject/.test(text(a['decisions'])) },
    { key: 'BUG-412 not to be fixed, file not edited', group: 'open bugs', inRepository: false, holds: (a) => list(a['openBugs']).some((b) => /bug-412/i.test(b) && /not|out of scope|another team|leave/i.test(b)) },
    { key: 'BUG-431 out of scope', group: 'open bugs', inRepository: false, holds: (a) => list(a['openBugs']).some((b) => /bug-431/i.test(b)) },
    { key: 'S1 key never logged, 12 hex of SHA-256', group: 'security constraints', inRepository: false, holds: (a) => /sha-?256/.test(text(a['securityConstraints'])) && /12/.test(text(a['securityConstraints'])) },
    { key: 'S2 limits never loaded from a request path', group: 'security constraints', inRepository: false, holds: (a) => /request/.test(text(a['securityConstraints'])) && /path/.test(text(a['securityConstraints'])) },
    ...['config/limits.json', 'src/limiter/bucket.js', 'src/limiter/bucket.test.js', 'src/limiter/schedule.js', 'src/limiter/schedule.test.js'].map((p) => ({ key: `changed ${p}`, group: 'files changed', inRepository: true, holds: (a: Record<string, unknown>) => list(a['filesChanged']).some((x) => x.replace(/\\/g, '/').endsWith(p)) })),
    ...['bucket.test.js', 'schedule.test.js', 'window.test.js'].map((p) => ({ key: `test ${p}`, group: 'tests', inRepository: true, holds: (a: Record<string, unknown>) => list(a['tests']).some((x) => x.replace(/\\/g, '/').endsWith(p)) })),
    { key: 'ref context://project/ratelimit/decisions/integer-token-arithmetic', group: 'Context Graph references', inRepository: false, holds: (a) => list(a['contextRefs']).includes('context://project/ratelimit/decisions/integer-token-arithmetic') },
    { key: 'ref notes/limiter/burst-factor-origin-3fa9c1', group: 'Context Graph references', inRepository: false, holds: (a) => list(a['contextRefs']).includes('notes/limiter/burst-factor-origin-3fa9c1') },
  ]
})()

const HIDDEN = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { retryDelays, logKey } from './src/limiter/retry.js'

test('the retry schedule uses the interval, the multiplier and the maximum of the brief', () => {
  assert.deepEqual(retryDelays(), [250, 400, 640, 1024, 1638, 2621])
})

test('a log line carries 12 hex characters of the SHA-256 of the key, never the key', () => {
  const key = 'client-key-AbC-123'
  const out = String(logKey(key))
  assert.ok(out.includes(createHash('sha256').update(key).digest('hex').slice(0, 12)))
  assert.ok(!out.includes(key))
})
`

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

describe('real Claude runtime: fidelity of one deliberate compaction', () => {
  it('records what a session still knows and does after the runtime compacted it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-compaction-'))
    for (const [path, content] of Object.entries(FILES)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    for (const args of [['config', 'user.name', 'Compaction'], ['config', 'user.email', 'compaction@example.com'], ['add', '-A'], ['commit', '-q', '-m', 'initial']]) execFileSync('git', ['-C', dir, ...args])
    const windowBefore = createHash('sha256').update(readFileSync(join(dir, 'src/limiter/window.js'))).digest('hex')

    const runtime = new ClaudeSdkRuntime({ resolveExecutable: () => resolveClaudeExecutable() })
    const said = async (): Promise<string> => 'ok'
    const nexusTools: NexusToolHandlers = { sendMessage: said, reportBlocker: said, recordDecision: said, proposeMemory: said }
    const spec: SessionSpec = {
      agentId: 'compaction-fidelity',
      role: 'worker',
      cwd: dir,
      model: MODEL,
      maxTurns: 60,
      systemPromptAppend: rolePrompt('worker', 'implement'),
      prompt: BRIEF,
      tools: toolsForRole('worker', { allowNetworkTools: false }),
      // The real policy of a worker in its worktree: nothing outside it, checks by `node --test`.
      authorize: createAuthorizer({ role: 'worker', worktreeRoot: dir, projectRoot: dir, safeCommandPrefixes: ['node --test', 'npm test'], allowNetworkTools: false, allowedMcpServers: [] }),
      requestApproval: async () => false,
      nexusTools,
      loadProjectSettings: false,
      subscriptionMode: true,
      contextOptions: { stablePrefix: false, alwaysLoadNexusTools: false, contextUsageDetail: 'summary' },
    }

    const startedAt = new Date().toISOString()
    const handle = runtime.startSession(spec)
    const stream = handle.events[Symbol.asyncIterator]()
    let ended = false
    interface Turn { label: string; text: string; tools: string[]; denied: number; compactions: Extract<AgentEvent, { type: 'compaction' }>[]; contextTokens: number | null; outcome: string | null; requests: number; cacheRead: number; cacheWrite: number; uncached: number; ms: number }
    const turns: Turn[] = []
    /** Reads the stream until the turn that is running completes. */
    const turn = async (label: string, send?: string): Promise<Turn> => {
      const t: Turn = { label, text: '', tools: [], denied: 0, compactions: [], contextTokens: null, outcome: null, requests: 0, cacheRead: 0, cacheWrite: 0, uncached: 0, ms: 0 }
      turns.push(t)
      if (ended) return t
      const started = Date.now()
      if (send !== undefined) handle.send(send)
      for (;;) {
        const next = await stream.next()
        if (next.done) {
          ended = true
          break
        }
        const e = next.value
        if (e.type === 'text') t.text += `${e.text}\n`
        else if (e.type === 'tool.started') t.tools.push(e.toolName)
        else if (e.type === 'tool.denied') t.denied++
        else if (e.type === 'compaction') t.compactions.push(e)
        else if (e.type === 'context.usage') t.contextTokens = e.usage.totalTokens
        else if (e.type === 'request.usage') {
          t.requests++
          t.cacheRead += e.cacheReadTokens
          t.cacheWrite += e.cacheCreationTokens
          t.uncached += e.inputTokens
        } else if (e.type === 'session.ended') ended = true
        else if (e.type === 'turn.completed') {
          t.outcome = e.result.outcome
          break
        }
      }
      t.ms = Date.now() - started
      return t
    }

    await turn('step 1: brief and first implementation')
    await turn('step 2: more work', STEP2)
    const probeBefore = await turn('probe before the compaction', PROBE)
    const compact = await turn('/compact', '/compact')
    const probeAfter = await turn('probe after the compaction', PROBE)
    const step3 = await turn('step 3: continue the task', STEP3)
    handle.end()
    await handle.stop().catch(() => undefined)
    await runtime.shutdown()

    const compaction = turns.flatMap((t) => t.compactions)[0] ?? null
    const before = parseJson(probeBefore.text)
    const after = parseJson(probeAfter.text)
    const facts = FACTS.map((f) => ({ key: f.key, group: f.group, alsoInRepository: f.inRepository, before: before ? f.holds(before) : false, after: after ? f.holds(after) : false }))
    // Only a fact the session held before can be said to have been lost by the compaction.
    const established = facts.filter((f) => f.before)
    const lost = established.filter((f) => !f.after)

    // The continuation, judged by what the brief said and the session was not told again.
    writeFileSync(join(dir, 'hidden.test.js'), HIDDEN)
    let hiddenPassed = true
    let hiddenOutput: string
    try {
      hiddenOutput = execFileSync('node', ['--test', 'hidden.test.js'], { cwd: dir, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      hiddenPassed = false
      hiddenOutput = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}` || String(e)
    }
    rmSync(join(dir, 'hidden.test.js'), { force: true })
    let suitePassed = true
    try {
      execFileSync('node', ['--test'], { cwd: dir, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      suitePassed = false
    }
    const windowUntouched = createHash('sha256').update(readFileSync(join(dir, 'src/limiter/window.js'))).digest('hex') === windowBefore

    const evidence = {
      kind: 'compaction-fidelity',
      startedAt,
      finishedAt: new Date().toISOString(),
      model: MODEL,
      mechanism: "The runtime's own compaction of a streaming session, started deliberately by sending /compact (trigger 'manual'). The automatic trigger at a full context window was not exercised.",
      compactionOccurred: compaction !== null,
      compaction: compaction ? { trigger: compaction.trigger, preTokens: compaction.preTokens, postTokens: compaction.postTokens, durationMs: compaction.durationMs } : null,
      observableContext: { tokensBeforeCompaction: probeBefore.contextTokens, tokensAfterCompaction: probeAfter.contextTokens ?? compact.contextTokens },
      facts: {
        total: facts.length,
        establishedBefore: established.length,
        retainedAfter: established.length - lost.length,
        lost: lost.map((f) => f.key),
        notEstablishedBefore: facts.filter((f) => !f.before).map((f) => f.key),
        onlyInConversation: { established: established.filter((f) => !f.alsoInRepository).length, retained: established.filter((f) => !f.alsoInRepository && f.after).length },
        byGroup: [...new Set(facts.map((f) => f.group))].map((g) => ({ group: g, established: established.filter((f) => f.group === g).length, retained: established.filter((f) => f.group === g && f.after).length })),
        detail: facts,
      },
      probeUsedTools: { before: probeBefore.tools, after: probeAfter.tools },
      taskQualityAfterCompaction: { continuedOutcome: step3.outcome, hiddenPassed, hiddenOutput: hiddenOutput.slice(-900), suitePassed, bug412FileUntouched: windowUntouched, toolsUsedInContinuation: step3.tools.length },
      turns: turns.map((t) => ({ label: t.label, outcome: t.outcome, tools: t.tools.length, denied: t.denied, requests: t.requests, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, uncached: t.uncached, contextTokens: t.contextTokens, ms: t.ms })),
      probeAnswers: { before, after },
      verdict: compaction === null ? 'NOT VERIFIED: the runtime reported no compaction' : lost.length === 0 && hiddenPassed && windowUntouched ? 'VERIFIED for this scenario: every established fact was retained and the task continued correctly' : 'VERIFIED WITH LOSSES: see facts.lost and taskQualityAfterCompaction',
    }
    const out = resolve(import.meta.dirname, '../../docs/acceptance')
    mkdirSync(out, { recursive: true })
    const file = join(out, `compaction-fidelity-${startedAt.replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(`compaction ${compaction ? `occurred (${compaction.trigger}, ${compaction.preTokens} -> ${compaction.postTokens} tokens)` : 'DID NOT OCCUR'}; facts established ${established.length}/${facts.length}, retained ${established.length - lost.length}, lost [${lost.map((f) => f.key).join('; ')}]; continuation hidden ${hiddenPassed ? 'passed' : 'FAILED'}, BUG-412 file ${windowUntouched ? 'untouched' : 'EDITED'}\nevidence: ${file}`)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    expect(evidence.kind).toBe('compaction-fidelity')
  })
})
