import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { AgentOutput } from '@shared/domain'
import type { EventType, RunEvent } from '@shared/events'
import { createPushHandler, keysForEvent } from '../../../src/renderer/src/lib/push'
import { qk } from '../../../src/renderer/src/lib/queries'

function event(type: EventType, extra: Partial<RunEvent> = {}): RunEvent {
  return {
    id: 'e1',
    seq: 1,
    runId: 'run1',
    taskId: null,
    agentId: null,
    type,
    payload: {} as never,
    createdAt: '2026-10-03T00:00:00Z',
    ...extra,
  }
}

describe('keysForEvent', () => {
  it('invalidates run detail and lists for run events', () => {
    const keys = keysForEvent(event('run.state_changed'))
    expect(keys).toContainEqual(qk.run('run1'))
    expect(keys).toContainEqual(qk.runsList())
    expect(keys).toContainEqual(qk.eventsRoot('run1'))
  })

  it('targets the task and agent in the event', () => {
    expect(keysForEvent(event('task.completed', { taskId: 't1' }))).toContainEqual(qk.taskDiff('t1'))
    const tool = keysForEvent(event('agent.tool.started', { agentId: 'a1' }))
    expect(tool).toContainEqual(qk.agent('a1'))
    expect(tool).toContainEqual(qk.agentTools('a1'))
    expect(keysForEvent(event('agent.state_changed', { agentId: 'a1' }))).not.toContainEqual(qk.agentTools('a1'))
  })

  it('maps approvals, reviews, verification, messages, memory and git', () => {
    expect(keysForEvent(event('approval.requested'))).toContainEqual(qk.approvals())
    expect(keysForEvent(event('review.completed', { taskId: 't1' }))).toContainEqual(qk.taskReviews('t1'))
    expect(keysForEvent(event('verification.failed', { taskId: 't1' }))).toContainEqual(qk.taskVerifications('t1'))
    expect(keysForEvent(event('checks.completed'))).toContainEqual(qk.verifications('run1'))
    expect(keysForEvent(event('message.sent'))).toContainEqual(qk.messagesRoot('run1'))
    expect(keysForEvent(event('memory.proposed'))).toContainEqual(qk.memoryRoot())
    expect(keysForEvent(event('git.commit.created'))).toContainEqual(qk.runDiff('run1'))
  })

  it('maps the 0.3 event families to their query roots', () => {
    expect(keysForEvent(event('usage.quota_paused'))).toEqual(expect.arrayContaining([qk.usageRoot(), qk.homeRoot(), qk.run('run1')]))
    expect(keysForEvent(event('strategy.selected'))).toContainEqual(qk.policyRoot())
    expect(keysForEvent(event('policy.decided'))).toEqual(expect.arrayContaining([qk.policyRoot(), qk.homeRoot()]))
    expect(keysForEvent(event('speculative.decided'))).toContainEqual(qk.speculative('run1'))
    expect(keysForEvent(event('outcome.recorded'))).toEqual(expect.arrayContaining([qk.policyRoot(), qk.usageRoot(), qk.arenaRoot()]))
  })

  it('refreshes the cross-run activity feed for every event', () => {
    expect(keysForEvent(event('task.completed'))).toContainEqual(qk.activityRoot())
    expect(keysForEvent(event('usage.probe'))).toContainEqual(qk.activityRoot())
  })

  it('falls back to refreshing the run for other families', () => {
    expect(keysForEvent(event('criterion.updated'))).toContainEqual(qk.run('run1'))
  })
})

describe('push handler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const live = () => ({ append: vi.fn(), clear: vi.fn() })

  it('coalesces a burst of events into one invalidation per key', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const h = createPushHandler(qc, { debounceMs: 100, live: live() })
    for (let i = 0; i < 50; i++) h.handle({ kind: 'event', event: event('task.state_changed', { taskId: 't1' }) })
    expect(spy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    const runDetailCalls = spy.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(qk.run('run1')))
    expect(runDetailCalls).toHaveLength(1)
    h.dispose()
  })

  it('invalidates the autonomy queries on an autonomy push', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const h = createPushHandler(qc, { debounceMs: 100, live: live() })
    h.handle({ kind: 'autonomy', pending: 2 })
    vi.advanceTimersByTime(100)
    expect(spy.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(['autonomy'])
    h.dispose()
  })

  it('invalidates the test environment keys of exactly the runs of a presentation push', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const h = createPushHandler(qc, { debounceMs: 100, live: live() })
    h.handle({ kind: 'presentation', runIds: ['r1', 'r2'] })
    vi.advanceTimersByTime(100)
    const keys = spy.mock.calls.map(([f]) => JSON.stringify(f?.queryKey))
    expect(keys).toContain(JSON.stringify(['presentation', 'metrics', 'r1']))
    expect(keys).toContain(JSON.stringify(['presentation', 'metrics', 'r2']))
    expect(keys.filter((k) => k.includes('presentation') && !k.includes('r1') && !k.includes('r2'))).toEqual([])
    h.dispose()
  })

  it('still flushes during a continuous stream', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const h = createPushHandler(qc, { debounceMs: 100, live: live() })
    for (let t = 0; t < 5; t++) {
      h.handle({ kind: 'event', event: event('agent.message', { agentId: 'a1' }) })
      vi.advanceTimersByTime(40)
    }
    expect(spy).toHaveBeenCalled()
    h.dispose()
  })

  it('appends agent.output to the cached list in seq order, ignoring duplicates, and clears live text', () => {
    const qc = new QueryClient()
    const first: AgentOutput = { id: 'a1:1', agentId: 'a1', seq: 1, kind: 'text', content: 'one', createdAt: 'x' }
    qc.setQueryData(qk.agentOutput('a1'), [first])
    const l = live()
    const h = createPushHandler(qc, { live: l })
    const out = (seq: number, content: string, outputKind = 'text') =>
      h.handle({ kind: 'agent.output', agentId: 'a1', runId: 'run1', seq, outputKind, content })
    out(3, 'three')
    out(2, 'two')
    out(2, 'two again')
    out(4, 'odd', 'something-new')
    const list = qc.getQueryData<AgentOutput[]>(qk.agentOutput('a1')) ?? []
    expect(list.map((o) => [o.seq, o.content])).toEqual([
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
      [4, 'odd'],
    ])
    expect(list[3]?.kind).toBe('system')
    expect(l.clear).toHaveBeenCalledWith('a1')
    h.dispose()
  })

  it('does not create a cache entry for an agent nobody is viewing', () => {
    const qc = new QueryClient()
    const h = createPushHandler(qc, { live: live() })
    h.handle({ kind: 'agent.output', agentId: 'zz', runId: 'r', seq: 1, outputKind: 'text', content: 'x' })
    expect(qc.getQueryData(qk.agentOutput('zz'))).toBeUndefined()
    h.dispose()
  })

  it('routes deltas to the live store and auth changes to invalidation', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const l = live()
    const h = createPushHandler(qc, { debounceMs: 10, live: l })
    h.handle({ kind: 'agent.delta', agentId: 'a1', runId: 'r', text: 'hel' })
    expect(l.append).toHaveBeenCalledWith('a1', 'hel')
    h.handle({ kind: 'auth.changed' })
    vi.advanceTimersByTime(10)
    expect(spy.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(qk.auth())
    h.dispose()
  })

  it('writes a usage push into the overview cache and refreshes Home', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const h = createPushHandler(qc, { debounceMs: 10, live: live() })
    const overview = { status: 'QUOTA_PAUSED' } as never
    h.handle({ kind: 'usage', overview })
    expect(qc.getQueryData(qk.usageOverview())).toBe(overview)
    vi.advanceTimersByTime(10)
    expect(spy.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(qk.homeRoot())
    h.dispose()
  })

  it('shows one notice per usage.notice push and invalidates arena and policy queries', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const notify = vi.fn()
    const h = createPushHandler(qc, { debounceMs: 10, live: live(), notify })
    h.handle({ kind: 'usage.notice', notice: 'limit_reached', title: 'Claude usage limit reached', detail: 'Paused 2 runs' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('Claude usage limit reached', 'Paused 2 runs', 'limit_reached')
    h.handle({ kind: 'arena', campaignId: 'c1' })
    h.handle({ kind: 'policy' })
    vi.advanceTimersByTime(10)
    const keys = spy.mock.calls.map(([f]) => JSON.stringify(f?.queryKey))
    expect(keys).toContain(JSON.stringify(qk.arenaCampaign('c1')))
    expect(keys).toContain(JSON.stringify(qk.policyRoot()))
    h.dispose()
  })
})
