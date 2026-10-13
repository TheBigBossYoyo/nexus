import { describe, expect, it } from 'vitest'
import type { Run } from '@shared/domain'
import type { RunEvent } from '@shared/events'
import type { RawUserIntent } from '@shared/director-line'
import { createDirectorLineHost, protectedSecretStore } from '@main/runtime/director-line-host'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 0.9: what the Director Line is given of the runtime: facts, two controls of the user's own missions, and the
// ordinary way a mission is created. Nothing that grants anything.
const run = (id: string, projectId: string, state: Run['state'], pauseReason: Run['pauseReason'] = null): Run => ({ id, projectId, state, pauseReason, prompt: `Mission ${id}`, startedAt: null, createdAt: '2026-10-13T19:00:00Z' }) as unknown as Run
const intent = (text: string, over: Partial<RawUserIntent> = {}): RawUserIntent => ({ text, projectHint: null, source: 'OPERATOR_REMOTE', channel: 'TELEGRAM', operatorId: 'chat-1', messageId: 'm1', afterCurrent: false, ...over }) as RawUserIntent

function world(runs: Run[]) {
  const listeners: ((e: RunEvent) => void)[] = []
  const paused: string[] = []
  const resumed: string[] = []
  const created: { projectId: string; prompt: string }[] = []
  const host = createDirectorLineHost({
    openRuns: () => runs.filter((r) => !['completed', 'failed', 'cancelled'].includes(r.state)),
    projectName: (id) => ({ p1: 'RaceDeck', p2: 'Nexus' })[id] ?? null,
    projects: () => [{ id: 'p1', name: 'RaceDeck' }, { id: 'p2', name: 'Nexus' }],
    progressOf: () => null,
    eventsOf: () => [],
    pendingBoundaryRequests: () => 2,
    isOnline: () => true,
    latestOvernightReport: () => null,
    pauseRun: async (id) => void paused.push(id),
    resumeRun: async (id) => void resumed.push(id),
    createMission: async (input) => {
      created.push(input)
      return { id: `new-${created.length}-0000000` }
    },
    subscribe: (l) => void listeners.push(l),
    logger: () => undefined,
  })
  const emit = (type: string, runId: string): void => listeners.forEach((l) => l({ type, runId, taskId: null, agentId: null, payload: {}, seq: 1, createdAt: '' } as unknown as RunEvent))
  return { host, paused, resumed, created, emit }
}

describe('the Director Line and the runtime', () => {
  it('"pause after the current task" pauses a working mission when its task is done, not before, and once', async () => {
    const w = world([run('r1', 'p1', 'executing'), run('r2', 'p1', 'paused', 'user')])
    await w.host.actions.pauseAfterCurrentTask()
    expect(w.paused).toEqual([])
    w.emit('task.completed', 'r1')
    expect(w.paused).toEqual(['r1'])
    w.emit('task.completed', 'r1')
    expect(w.paused).toEqual(['r1'])
  })

  it('"continue" resumes what the user paused and nothing else: not a mission that waits for a provider, the network or a decision', async () => {
    const w = world([run('r1', 'p1', 'paused', 'user'), run('r2', 'p1', 'paused', 'quota'), run('r3', 'p2', 'paused', 'network'), run('r4', 'p2', 'awaiting_approval')])
    await w.host.actions.resume()
    expect(w.resumed).toEqual(['r1'])
  })

  it('a remote task goes to the ordinary creation of a mission, for the project named or the one that is working', async () => {
    const w = world([run('r1', 'p1', 'executing')])
    expect(await w.host.actions.submitIntent(intent('Add a lap timer'))).toMatchObject({ accepted: true })
    expect(w.created).toEqual([{ projectId: 'p1', prompt: 'Add a lap timer' }])
    expect(await w.host.actions.submitIntent(intent('Fix the build', { projectHint: 'nexus' }))).toMatchObject({ accepted: true })
    expect(w.created[1]).toEqual({ projectId: 'p2', prompt: 'Fix the build' })
    // A name that matches no single project creates nothing.
    expect(await w.host.actions.submitIntent(intent('x', { projectHint: 'Unknown' }))).toMatchObject({ accepted: false })
    expect(await w.host.actions.submitIntent(intent('   '))).toMatchObject({ accepted: false })
    expect(w.created).toHaveLength(2)
  })

  it('with several projects working and none named, it asks which and creates nothing', async () => {
    const w = world([run('r1', 'p1', 'executing'), run('r2', 'p2', 'executing')])
    expect(await w.host.actions.submitIntent(intent('Do something'))).toMatchObject({ accepted: false, reason: 'Say which project the task is for.' })
    expect(w.created).toEqual([])
  })

  it('"after this, add …" waits for the current work of that project to end, then is created once', async () => {
    const runs = [run('r1', 'p1', 'executing')]
    const w = world(runs)
    expect(await w.host.actions.submitIntent(intent('Redesign telemetry', { afterCurrent: true }))).toMatchObject({ accepted: true, reference: 'queued after the current work in RaceDeck' })
    expect(w.created).toEqual([])
    w.emit('task.completed', 'r1')
    expect(w.created).toEqual([])
    ;(runs[0] as Run).state = 'completed'
    w.emit('run.completed', 'r1')
    await Promise.resolve()
    expect(w.created).toEqual([{ projectId: 'p1', prompt: 'Redesign telemetry' }])
    w.emit('run.completed', 'r1')
    expect(w.created).toHaveLength(1)
  })

  it('reports what it reads: paused by the user, online, how many boundary requests wait', async () => {
    const w = world([run('r1', 'p1', 'paused', 'user')])
    expect((await w.host.reads.getStatus()).facts).toEqual({ paused: true, online: true, pendingBoundaryRequests: 2 })
  })
})

describe('the secrets of the Director Line', () => {
  const dir = resolve('test-results', 'director-line-secrets')
  const storage = { available: () => true, encrypt: (v: string) => Buffer.from(v, 'utf8').map((b) => b ^ 0x5a) as Buffer, decrypt: (v: Buffer) => Buffer.from(v.map((b) => b ^ 0x5a)).toString('utf8') }

  it('are kept only through the protected storage, never in the clear, and not at all without it', async () => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const token = ['123456', ':', 'AAF', 'not-a-real-token-value'].join('')
    const store = protectedSecretStore(dir, storage)
    await store.set('telegram.botToken', token)
    expect(await store.get('telegram.botToken')).toBe(token)
    expect(readFileSync(join(dir, 'secrets.bin')).includes(Buffer.from(token))).toBe(false)
    // Another object on the same folder reads it back; deleting removes it.
    expect(await protectedSecretStore(dir, storage).get('telegram.botToken')).toBe(token)
    await store.delete('telegram.botToken')
    expect(await store.get('telegram.botToken')).toBeNull()
    const without = protectedSecretStore(dir, undefined)
    await expect(without.set('telegram.botToken', token)).rejects.toThrow(/not kept/)
    expect(await without.get('telegram.botToken')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})
