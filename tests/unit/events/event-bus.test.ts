import { describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '@shared/events'
import { EventBus } from '@main/modules/events'
import { makeRun, openMemory, seed } from '../../integration/persistence/fixtures'

function setup() {
  const { repos } = openMemory()
  const ctx = seed(repos)
  const onError = vi.fn()
  const bus = new EventBus(repos.events, repos.transaction, onError)
  return { repos, bus, onError, ...ctx }
}

describe('EventBus', () => {
  it('persists before notifying and returns the stored event', () => {
    const { repos, bus, run } = setup()
    const seenInDb: (RunEvent | null)[] = []
    bus.subscribe((e) => seenInDb.push(repos.events.get(e.id)))
    const emitted = bus.emit({ runId: run.id, type: 'run.paused', payload: { reason: 'user' } })
    expect(emitted.seq).toBeGreaterThan(0)
    expect(seenInDb).toEqual([emitted])
    expect(repos.events.listByRun(run.id)).toEqual([emitted])
  })

  it('delivers in seq order to all subscribers and supports unsubscribe', () => {
    const { bus, run } = setup()
    const a: number[] = []
    const b: number[] = []
    bus.subscribe((e) => a.push(e.seq))
    const offB = bus.subscribe((e) => b.push(e.seq))
    const e1 = bus.emit({ runId: run.id, type: 'run.started', payload: {} })
    offB()
    const e2 = bus.emit({ runId: run.id, type: 'run.resumed', payload: {} })
    expect(a).toEqual([e1.seq, e2.seq])
    expect(b).toEqual([e1.seq])
  })

  it('subscribeRun only receives events of its run', () => {
    const { repos, bus, run, project } = setup()
    const other = repos.runs.insert(makeRun(project.id))
    const got: string[] = []
    bus.subscribeRun(run.id, (e) => got.push(e.runId))
    bus.emit({ runId: other.id, type: 'run.started', payload: {} })
    bus.emit({ runId: run.id, type: 'run.started', payload: {} })
    expect(got).toEqual([run.id])
  })

  it('isolates a throwing subscriber from emit and from other subscribers', () => {
    const { bus, run, onError } = setup()
    const after = vi.fn()
    bus.subscribe(() => {
      throw new Error('bad listener')
    })
    bus.subscribe(after)
    expect(() => bus.emit({ runId: run.id, type: 'run.started', payload: {} })).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('does not notify and does not persist when the insert fails', () => {
    const { bus } = setup()
    const listener = vi.fn()
    bus.subscribe(listener)
    expect(() => bus.emit({ runId: 'missing-run', type: 'run.started', payload: {} })).toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  describe('transaction', () => {
    it('holds notifications until commit, then flushes them in order', () => {
      const { repos, bus, run, t1 } = setup()
      const log: string[] = []
      bus.subscribe((e) => log.push(`notify:${e.type}`))
      const result = bus.transaction(() => {
        repos.tasks.update(t1.id, { state: 'ready' })
        bus.emit({ runId: run.id, taskId: t1.id, type: 'task.state_changed', payload: { from: 'draft', to: 'ready' } })
        log.push('after-emit')
        bus.emit({ runId: run.id, taskId: t1.id, type: 'task.ready', payload: {} })
        log.push('end-of-fn')
        return 42
      })
      expect(result).toBe(42)
      expect(log).toEqual(['after-emit', 'end-of-fn', 'notify:task.state_changed', 'notify:task.ready'])
      expect(repos.events.listByRun(run.id)).toHaveLength(2)
    })

    it('rolls back the event row and discards notifications on failure', () => {
      const { repos, bus, run, t1 } = setup()
      const listener = vi.fn()
      bus.subscribe(listener)
      expect(() =>
        bus.transaction(() => {
          repos.tasks.update(t1.id, { state: 'running' })
          bus.emit({ runId: run.id, type: 'run.started', payload: {} })
          throw new Error('abort')
        }),
      ).toThrow('abort')
      expect(listener).not.toHaveBeenCalled()
      expect(repos.events.listByRun(run.id)).toEqual([])
      expect(repos.tasks.require(t1.id).state).toBe('draft')
    })

    it('flushes only after the outermost transaction commits', () => {
      const { bus, run } = setup()
      const listener = vi.fn()
      bus.subscribe(listener)
      bus.transaction(() => {
        bus.transaction(() => {
          bus.emit({ runId: run.id, type: 'run.started', payload: {} })
        })
        expect(listener).not.toHaveBeenCalled()
        bus.emit({ runId: run.id, type: 'run.resumed', payload: {} })
      })
      expect(listener).toHaveBeenCalledTimes(2)
    })

    it('drops only the failed inner transaction when the outer one catches and commits', () => {
      const { repos, bus, run } = setup()
      const types: string[] = []
      bus.subscribe((e) => types.push(e.type))
      bus.transaction(() => {
        bus.emit({ runId: run.id, type: 'run.started', payload: {} })
        try {
          bus.transaction(() => {
            bus.emit({ runId: run.id, type: 'run.paused', payload: { reason: 'user' } })
            throw new Error('inner')
          })
        } catch {
          // The caller handles the inner failure and carries on.
        }
        bus.emit({ runId: run.id, type: 'run.resumed', payload: {} })
      })
      expect(types).toEqual(['run.started', 'run.resumed'])
      expect(repos.events.listByRun(run.id).map((e) => e.type)).toEqual(['run.started', 'run.resumed'])
    })

    it('keeps delivery order when a listener emits during a flush', () => {
      const { bus, run } = setup()
      const types: string[] = []
      bus.subscribe((e) => {
        types.push(e.type)
        if (e.type === 'run.started') bus.emit({ runId: run.id, type: 'run.completed', payload: { summary: 's' } })
      })
      bus.transaction(() => {
        bus.emit({ runId: run.id, type: 'run.started', payload: {} })
        bus.emit({ runId: run.id, type: 'run.resumed', payload: {} })
      })
      expect(types).toEqual(['run.started', 'run.resumed', 'run.completed'])
    })

    it('lets listeners read committed data when notified', () => {
      const { repos, bus, run, t1 } = setup()
      let stateSeen = ''
      bus.subscribe(() => {
        stateSeen = repos.tasks.require(t1.id).state
      })
      bus.transaction(() => {
        repos.tasks.update(t1.id, { state: 'queued' })
        bus.emit({ runId: run.id, type: 'task.ready', payload: {} })
      })
      expect(stateSeen).toBe('queued')
    })
  })
})
