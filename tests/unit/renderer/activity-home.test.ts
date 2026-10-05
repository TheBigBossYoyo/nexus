import { describe, expect, it } from 'vitest'
import type { Project, Run } from '@shared/domain'
import type { EventType, RunEvent } from '@shared/events'
import type { HomeSummary } from '@shared/v3-read'
import {
  activityCategory,
  activityTime,
  filterActivity,
  mergeFeed,
  olderCursor,
} from '../../../src/renderer/src/views/activity/activityModel'
import {
  composeHome,
  fromSummary,
  isFirstLaunch,
  summaryLine,
  taskProgress,
} from '../../../src/renderer/src/views/home/homeModel'

const ev = (seq: number, type: EventType): RunEvent => ({
  id: `e${seq}`,
  seq,
  runId: 'r',
  taskId: null,
  agentId: null,
  type,
  payload: {} as never,
  createdAt: '2026-10-04T10:00:00Z',
})

describe('activity model', () => {
  it('categorises event families, including the 0.3 ones', () => {
    expect(activityCategory('task.completed')).toBe('tasks')
    expect(activityCategory('agent.tool.started')).toBe('agents')
    expect(activityCategory('verification.passed')).toBe('quality')
    expect(activityCategory('usage.quota_paused')).toBe('usage')
    expect(activityCategory('policy.decided')).toBe('strategy')
    expect(activityCategory('speculative.decided')).toBe('strategy')
    expect(activityCategory('run.completed')).toBe('missions')
  })

  it('filters by category', () => {
    const events = [ev(3, 'task.completed'), ev(2, 'usage.probe'), ev(1, 'run.completed')]
    expect(filterActivity(events, 'all')).toHaveLength(3)
    expect(filterActivity(events, 'usage').map((e) => e.seq)).toEqual([2])
  })

  it('merges pages newest first without duplicates and finds the older cursor', () => {
    const merged = mergeFeed(
      [ev(10, 'run.completed'), ev(9, 'run.completed')],
      [ev(9, 'run.completed'), ev(8, 'run.completed')],
    )
    expect(merged.map((e) => e.seq)).toEqual([10, 9, 8])
    expect(olderCursor(merged)).toBe(8)
    expect(olderCursor([])).toBeNull()
  })

  it('adds the date to times that are not today', () => {
    const now = new Date(2026, 9, 4, 12, 0, 0).getTime()
    expect(activityTime(new Date(2026, 9, 4, 9, 5, 7).toISOString(), now)).toBe('09:05:07')
    expect(activityTime(new Date(2026, 9, 3, 9, 5, 7).toISOString(), now)).toBe('10-03 09:05:07')
    expect(activityTime('nope', now)).toBe('—')
  })
})

const run = (id: string, state: Run['state'], createdAt: string): Run =>
  ({
    id,
    projectId: 'p1',
    mode: 'mission',
    state,
    prompt: `prompt ${id}`,
    createdAt,
    startedAt: null,
    config: {},
  }) as unknown as Run
const project = {
  id: 'p1',
  name: 'Alpha',
  profile: { currentBranch: 'main' },
  lastOpenedAt: '2026-10-03T00:00:00Z',
} as unknown as Project

describe('home model', () => {
  it('composes a degraded Home without inventing task counts', () => {
    const h = composeHome({
      projects: [project],
      runs: [
        run('a', 'executing', '2026-10-04T09:00:00Z'),
        run('b', 'completed', '2026-10-04T08:00:00Z'),
      ],
      overnight: [],
    })
    expect(h.source).toBe('composed')
    expect(h.activeRuns.map((m) => m.run.id)).toEqual(['a'])
    expect(h.activeRuns[0]?.projectName).toBe('Alpha')
    expect(h.activeRuns[0] && taskProgress(h.activeRuns[0])).toBeNull()
    expect(h.arena).toBeNull()
    expect(h.policy).toBeNull()
  })

  it('draws a progress ratio only with a known denominator', () => {
    expect(taskProgress({ tasksTotal: 8, tasksCompleted: 3 })).toEqual({ done: 3, total: 8 })
    expect(taskProgress({ tasksTotal: 0, tasksCompleted: 0 })).toBeNull()
    expect(taskProgress({ tasksTotal: null, tasksCompleted: 2 })).toBeNull()
    expect(taskProgress({ tasksTotal: 4, tasksCompleted: 9 })).toEqual({ done: 4, total: 4 })
  })

  it('detects a first launch and writes a neutral summary line', () => {
    const empty = composeHome({ projects: [], runs: [], overnight: [] })
    expect(isFirstLaunch(empty)).toBe(true)
    expect(summaryLine(empty, 'Available')).toBe('No mission is running · Claude: available')
    const busy = composeHome({
      projects: [project],
      runs: [run('a', 'executing', '2026-10-04T09:00:00Z')],
      overnight: [],
    })
    expect(isFirstLaunch(busy)).toBe(false)
    expect(summaryLine(busy, null)).toBe('1 mission running')
  })

  it('maps home.summary', () => {
    const s = {
      activeRuns: [
        {
          run: run('a', 'executing', '2026-10-04T09:00:00Z'),
          projectName: 'Alpha',
          tasksTotal: 5,
          tasksCompleted: 2,
          activeAgents: 2,
          strategy: 'BUILD',
        },
      ],
      recentRuns: [],
      projects: [],
      activeAgents: 2,
      overnight: [],
      arena: { campaigns: 0, trials: 0, latest: null, headline: null },
      policy: { version: 1, preferences: 0, candidates: 0, exploration: 'OFF', pinned: false },
    } as unknown as HomeSummary
    const h = fromSummary(s)
    expect(h.source).toBe('summary')
    expect(h.activeRuns[0] && taskProgress(h.activeRuns[0])).toEqual({ done: 2, total: 5 })
    expect(summaryLine(h, 'Available')).toBe(
      '1 mission running · 2 active agents · Claude: available',
    )
  })
})
