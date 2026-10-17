// 0.9.1: what the Director line's interpreter makes of real sentences, on the real Claude runtime (fast tier).
// About ten model turns. Run with `pnpm smoke:message`. The evidence is written to test-results/message-interpreter.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeSdkRuntime } from '@main/modules/agent-runtime/claude-sdk-runtime'
import { resolveClaudeExecutable } from '@main/modules/agent-runtime/resolve-executable'
import { interpretMessage } from '@main/modules/director-line/intent'
import { createMessageInterpreter } from '@main/modules/director-line/message-interpreter'

const MODEL = process.env['MESSAGE_MODEL'] || 'haiku'
const CONTEXT = [
  'Open missions (the R-… and T-… references are the targets you may name):',
  '- R-8b3ba7d1 Nexus: Three independent improvements to NEXUS, each with its own tests (state paused, paused: user)',
  '  - blocked task T-5e1c0a9f "Security review: no privilege or boundary check weakened": the security_reviewer role\'s hook refuses pnpm in both Bash and PowerShell.',
  '- R-f8c86165 F1: Four independent improvements to NEXUS (state paused, paused: user)',
  '  - blocked task T-77d2b4e0 "Confirm the worktree is not the NEXUS repository": Wrong repository: this worktree is RaceDeck.',
  '',
  'Last message NEXUS sent the operator:',
  'NEXUS: Nexus: blocked for 30 min. Security review: the security_reviewer role\'s hook refuses pnpm.',
].join('\n')

// What each sentence must become. `target` is checked only when given.
const CASES: { said: string; kind: string; target?: string | null }[] = [
  { said: 'Start a new task to fix all the blockers', kind: 'ANSWER_BLOCKED' },
  { said: 'Tell the security reviewer it does not need pnpm, it can finish from reading the code', kind: 'ANSWER_BLOCKED' },
  { said: 'Lance une nouvelle tâche pour corriger tous les blocages', kind: 'ANSWER_BLOCKED' },
  { said: 'Stop the F1 mission, it is on the wrong repository', kind: 'STOP_RUN', target: 'R-f8c86165' },
  { said: 'what exactly is blocking the nexus mission right now?', kind: 'BLOCKERS' },
  { said: 'add a task to the nexus mission that updates the changelog', kind: 'ADD_TASK_TO_RUN', target: 'R-8b3ba7d1' },
  { said: 'how much longer do you think this will take', kind: 'ETA' },
  { said: 'ok just carry on with everything please', kind: 'CONTINUE' },
  { said: 'can you give me a quick summary of how things are going', kind: 'STATUS' },
  { said: 'what is the weather like in Paris today', kind: 'UNKNOWN' },
]

describe('real Claude runtime: Director line interpreter', () => {
  it('reads the owner\'s sentences as sentences', async () => {
    const root = resolve(import.meta.dirname, '../../test-results/message-interpreter')
    const cwd = join(root, 'session')
    mkdirSync(cwd, { recursive: true })
    const log: string[] = []
    const classify = createMessageInterpreter({
      runtime: new ClaudeSdkRuntime({ resolveExecutable: () => resolveClaudeExecutable() }),
      cwd,
      model: () => MODEL,
      subscriptionMode: () => true,
      log: (l) => log.push(l),
    })
    const rows: { said: string; expected: string; got: unknown; ms: number }[] = []
    for (const c of CASES) {
      const t0 = Date.now()
      const got = await interpretMessage(c.said, classify, CONTEXT)
      rows.push({ said: c.said, expected: c.kind, got, ms: Date.now() - t0 })
    }
    writeFileSync(join(root, `message-interpreter-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify({ model: MODEL, rows, log }, null, 2)}\n`)
    for (const row of rows) console.log(`${row.ms} ms  ${row.expected.padEnd(15)} ${JSON.stringify(row.got)}  <- ${row.said}`)
    for (const [i, c] of CASES.entries()) {
      const got = rows[i]!.got as { kind: string; target?: string | null }
      expect(got.kind, c.said).toBe(c.kind)
      if (c.target !== undefined) expect(got.target, c.said).toBe(c.target)
    }
  })
})
