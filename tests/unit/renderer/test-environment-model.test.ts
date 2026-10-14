import { describe, expect, it } from 'vitest'
import type { AppSessionView } from '../../../src/shared/isolation'
import type { UserDisturbanceMetrics } from '../../../src/shared/presentation'
import {
  testEnvironmentKeys,
  testEnvironmentView,
} from '../../../src/renderer/src/views/run/testEnvironmentModel'

const app = (over: Partial<AppSessionView> = {}): AppSessionView => ({
  id: 'a1b2c3d4e5f6',
  projectId: 'p1',
  runId: 'r1',
  taskId: null,
  type: 'electron',
  state: 'running',
  profile: 'RESTRICTED',
  endpoint: null,
  startedAt: '2026-01-01T00:00:00Z',
  exitCode: null,
  output: [],
  screenshots: 3,
  note: '',
  ...over,
})

const metrics = (over: Partial<UserDisturbanceMetrics> = {}): UserDisturbanceMetrics => ({
  runId: 'r1',
  measured: true,
  uacPrompts: 0,
  visibleWindows: 0,
  foregroundSteals: 0,
  consoleFlashes: 0,
  unexpectedDialogs: 0,
  notifications: null,
  recent: [],
  quietCommands: 0,
  ...over,
})

const view = (o: { live?: boolean; apps?: AppSessionView[] | undefined; metrics?: UserDisturbanceMetrics | undefined }) =>
  testEnvironmentView({ runId: 'r1', live: o.live ?? false, apps: o.apps, metrics: o.metrics })

describe('test environment keys', () => {
  it('keeps the apps key under the isolation apps root', () => {
    expect(testEnvironmentKeys.apps('r1')).toEqual(['isolation', 'apps', 'run', 'r1'])
    expect(testEnvironmentKeys.metrics('r1')).toEqual(['presentation', 'metrics', 'r1'])
  })
})

describe('testEnvironmentView', () => {
  it('no apps: an empty list, shown while live, hidden once finished and measured quiet', () => {
    expect(view({ live: true, apps: [], metrics: metrics() })).toMatchObject({ hidden: false, apps: [] })
    expect(view({ live: false, apps: [], metrics: metrics() }).hidden).toBe(true)
  })

  it('measured zero: five rows, all 0', () => {
    const d = view({ live: true, apps: [], metrics: metrics() }).disturbance
    expect(d.measured).toBe(true)
    if (d.measured) {
      expect(d.rows.map((r) => r.label)).toEqual(['UAC prompts', 'Visible windows', 'Foreground steals', 'Console flashes', 'Unexpected dialogs'])
      expect(d.rows.every((r) => r.value === 0)).toBe(true)
    }
    expect(view({ apps: [], metrics: metrics() }).notifications).toBe('Notifications: not measured')
  })

  it('not measured: says so, no zero rows, a finished run is not hidden', () => {
    const v = view({ live: false, apps: [], metrics: metrics({ measured: false }) })
    expect(v.disturbance).toEqual({ measured: false, text: 'Not measured' })
    expect(v.hidden).toBe(false)
    expect(v.notifications).toBe('Notifications: not measured')
  })

  it('one running Electron app with 3 screenshots', () => {
    const v = view({ live: true, apps: [app()], metrics: metrics() })
    expect(v.apps).toHaveLength(1)
    expect(v.apps[0]).toMatchObject({
      id: 'a1b2c3d4e5f6',
      name: 'Electron application a1b2c3d4e5f6',
      stateLabel: 'Running',
      mode: 'Private desktop',
      screenshots: 3,
      screenshotsLabel: '3 screenshots',
      canViewScreenshot: true,
    })
    expect(view({ apps: [app()], metrics: metrics() }).hidden).toBe(false)
  })

  it('a web app is headless; a stopped app or one without screenshots has no screenshot action', () => {
    expect(view({ apps: [app({ type: 'web' })] }).apps[0]?.mode).toBe('Headless')
    expect(view({ apps: [app({ state: 'stopped' })] }).apps[0]?.canViewScreenshot).toBe(false)
    expect(view({ apps: [app({ screenshots: 0 })] }).apps[0]?.canViewScreenshot).toBe(false)
  })

  it('2 foreground steals: the row shows 2 and a finished run with no apps is not hidden', () => {
    const v = view({ live: false, apps: [], metrics: metrics({ foregroundSteals: 2 }) })
    expect(v.hidden).toBe(false)
    const d = v.disturbance
    expect(d.measured && d.rows.find((r) => r.key === 'foregroundSteals')?.value).toBe(2)
  })

  it('filters out the apps of another run', () => {
    const v = view({ apps: [app(), app({ id: 'ffffffffffff', runId: 'r2' }), app({ id: 'eeeeeeeeeeee', runId: null })], metrics: metrics() })
    expect(v.apps.map((a) => a.id)).toEqual(['a1b2c3d4e5f6'])
  })

  it('never hides on unresolved data', () => {
    expect(view({ apps: undefined, metrics: metrics() }).hidden).toBe(false)
    expect(view({ apps: [], metrics: undefined }).hidden).toBe(false)
    expect(view({ apps: [], metrics: undefined }).disturbance.measured).toBe(false)
    expect(view({ apps: undefined, metrics: undefined }).hidden).toBe(false)
  })
})
