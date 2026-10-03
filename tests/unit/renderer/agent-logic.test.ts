import { describe, expect, it } from 'vitest'
import type { Agent, Message, ToolEvent } from '@shared/domain'
import { emptyMetrics } from '@shared/domain'
import {
  clockTime,
  filesFromToolEvents,
  groupAgents,
  messageDirection,
  terminalLine,
  toolInputSummary,
} from '../../../src/renderer/src/views/agents/agentLogic'

function agent(over: Partial<Agent>): Agent {
  return {
    id: 'a1',
    runId: 'r1',
    taskId: 't1',
    role: 'worker',
    purpose: 'task',
    label: 'Worker',
    state: 'working',
    model: null,
    activity: null,
    metrics: emptyMetrics(),
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    stoppedAt: null,
    ...over,
  } as Agent
}

function tool(toolName: string, input: Record<string, unknown>, startedAt = '2026-01-01T10:00:00.000Z'): ToolEvent {
  return {
    id: `${toolName}-${JSON.stringify(input)}`,
    runId: 'r1',
    taskId: 't1',
    agentId: 'a1',
    toolUseId: 'u',
    toolName,
    input,
    status: 'completed',
    outputPreview: null,
    startedAt,
    completedAt: null,
  }
}

describe('groupAgents', () => {
  it('puts active agents first, each group oldest first', () => {
    const list = [
      agent({ id: 'old-done', state: 'stopped', createdAt: '2026-01-01T00:00:00.000Z' }),
      agent({ id: 'new-active', state: 'working', createdAt: '2026-01-01T02:00:00.000Z' }),
      agent({ id: 'old-active', state: 'waiting', createdAt: '2026-01-01T01:00:00.000Z' }),
      agent({ id: 'failed', state: 'failed', createdAt: '2026-01-01T03:00:00.000Z' }),
    ]
    const { active, inactive } = groupAgents(list)
    expect(active.map((a) => a.id)).toEqual(['old-active', 'new-active'])
    expect(inactive.map((a) => a.id)).toEqual(['old-done', 'failed'])
  })
})

describe('toolInputSummary', () => {
  it('prefers the command for shell tools and the path for file tools', () => {
    expect(toolInputSummary(tool('Bash', { command: 'pnpm test' }))).toBe('pnpm test')
    expect(toolInputSummary(tool('Read', { file_path: 'src/a.ts' }))).toBe('src/a.ts')
    expect(toolInputSummary(tool('NotebookEdit', { notebook_path: 'n.ipynb' }))).toBe('n.ipynb')
    expect(toolInputSummary(tool('Grep', { pattern: 'foo', glob: '*.ts' }))).toBe('foo')
  })

  it('truncates long values and tolerates empty input', () => {
    expect(toolInputSummary(tool('Bash', { command: 'x'.repeat(50) }), 10)).toHaveLength(10)
    expect(toolInputSummary(tool('Weird', {}))).toBe('')
  })
})

describe('terminalLine', () => {
  it('renders a bracketed local time and prompt', () => {
    const iso = new Date(2026, 0, 2, 16, 31, 10).toISOString()
    expect(clockTime(iso)).toBe('16:31:10')
    expect(terminalLine({ startedAt: iso, input: { command: 'pnpm test' } })).toBe('[16:31:10] > pnpm test')
  })
})

describe('filesFromToolEvents', () => {
  it('derives unique read and changed files with counts', () => {
    const files = filesFromToolEvents([
      tool('Read', { file_path: 'C:\\repo\\a.ts' }),
      tool('Read', { file_path: 'c:/repo/a.ts' }),
      tool('Read', { file_path: 'b.ts' }),
      tool('Edit', { file_path: 'a.ts' }),
      tool('Write', { file_path: 'new.ts' }),
      tool('Edit', { file_path: 'a.ts' }),
      tool('NotebookEdit', { notebook_path: 'n.ipynb' }),
      tool('Bash', { command: 'ls' }),
    ])
    expect(files.read).toEqual([
      { path: 'C:\\repo\\a.ts', count: 2 },
      { path: 'b.ts', count: 1 },
    ])
    expect(files.changed).toEqual([
      { path: 'a.ts', count: 2 },
      { path: 'n.ipynb', count: 1 },
      { path: 'new.ts', count: 1 },
    ])
  })
})

describe('messageDirection', () => {
  const base = { fromAgentId: null, fromTaskId: null } as Message
  it('is sent when the agent or its task authored the message', () => {
    const a = agent({ id: 'a1', taskId: 't1' })
    expect(messageDirection({ ...base, fromAgentId: 'a1' }, a)).toBe('sent')
    expect(messageDirection({ ...base, fromTaskId: 't1' }, a)).toBe('sent')
    expect(messageDirection({ ...base, fromAgentId: 'other', fromTaskId: 't2' }, a)).toBe('received')
  })
})
