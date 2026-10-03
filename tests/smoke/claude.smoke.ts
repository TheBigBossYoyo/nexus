// Manual smoke test against the REAL Claude runtime. Consumes usage. Run with `pnpm smoke:claude`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClaudeSdkRuntime } from '@main/modules/agent-runtime/claude-sdk-runtime'
import { resolveClaudeExecutable } from '@main/modules/agent-runtime/resolve-executable'
import type { AgentEvent, SessionSpec, ToolRequest } from '@main/modules/agent-runtime/types'

const READ_ONLY = ['Read', 'Glob', 'Grep']
const PACKAGE_NAME = 'nexus-smoke-fixture'

let dir: string
const runtime = new ClaudeSdkRuntime({ resolveExecutable: () => resolveClaudeExecutable() })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-smoke-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '1.0.0' }, null, 2))
})

afterAll(async () => {
  await runtime.shutdown()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function spec(prompt: string, denied: ToolRequest[]): SessionSpec {
  return {
    agentId: 'smoke-agent',
    role: 'researcher',
    cwd: dir,
    maxTurns: 6,
    systemPromptAppend: 'You are a read-only inspector. Be brief.',
    prompt,
    tools: READ_ONLY,
    authorize: async (r) => {
      if (READ_ONLY.includes(r.toolName)) return { behavior: 'allow' }
      denied.push(r)
      return { behavior: 'deny', reason: 'Only Read, Glob and Grep are permitted in this session.' }
    },
    requestApproval: async () => false,
    loadProjectSettings: false,
    subscriptionMode: true,
  }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = []
  for await (const e of events) all.push(e)
  return all
}

describe('real Claude runtime', () => {
  it('reports account info', async () => {
    const status = await runtime.getAccountInfo({ subscriptionMode: true })
    // Never print the email.
    console.log(`auth state=${status.state} mode=${status.mode} subscription=${status.subscriptionType ?? '-'}`)
    expect(status.state).toBe('authenticated')
  })

  it('runs a read-only session and reports the package name', async () => {
    const denied: ToolRequest[] = []
    const handle = runtime.startSession(spec('Inspect package.json and report the package name.', denied))
    handle.end()
    const events = await collect(handle.events)

    expect(events[0]?.type).toBe('session.started')
    expect(events.some((e) => e.type === 'tool.started' || e.type === 'text')).toBe(true)
    const turn = events.find((e) => e.type === 'turn.completed')
    if (turn?.type !== 'turn.completed') throw new Error('no turn.completed event')
    expect(turn.result.outcome).toBe('success')
    expect(turn.result.text).toContain(PACKAGE_NAME)
    expect(events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'completed' })
    expect(denied).toEqual([])
  })

  it('denies a Write attempt by policy', async () => {
    const denied: ToolRequest[] = []
    // Write is not in `tools`, so the model normally cannot even try; the policy gate is the backstop.
    const handle = runtime.startSession(
      spec('Create a file named hello.txt containing "hi". If you cannot, say so in one sentence.', denied),
    )
    handle.end()
    const events = await collect(handle.events)
    const wrote = events.some((e) => e.type === 'tool.started' && e.toolName === 'Write')
    expect(wrote ? events.some((e) => e.type === 'tool.denied') : true).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'session.ended' })
  })
})
