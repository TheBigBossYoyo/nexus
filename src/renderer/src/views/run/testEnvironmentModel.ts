import type { AppSessionView } from '@shared/isolation'
import type { UserDisturbanceMetrics } from '@shared/presentation'
import { APP_STATE_LABEL, APP_TYPE_LABEL } from '../autonomy/isolationModel'

/**
 * The "Test environment" panel of the mission page: the applications under test of a run and the disturbance the
 * user was spared. Pure; unit-tested. Unresolved or unmeasured data is never taken as "nothing happened".
 */

export const testEnvironmentKeys = {
  // Under ['isolation', 'apps'], so the `apps` push invalidates it too.
  apps: (runId: string) => ['isolation', 'apps', 'run', runId] as const,
  metrics: (runId: string) => ['presentation', 'metrics', runId] as const,
}
export const presentationMetricsKey = testEnvironmentKeys.metrics

export const NOTIFICATIONS_LINE = 'Notifications: not measured'

export interface TestEnvironmentApp {
  id: string
  name: string
  state: AppSessionView['state']
  stateLabel: string
  mode: string
  screenshots: number
  screenshotsLabel: string
  canViewScreenshot: boolean
}

export interface DisturbanceRow {
  key: 'uacPrompts' | 'visibleWindows' | 'foregroundSteals' | 'consoleFlashes' | 'unexpectedDialogs'
  label: string
  value: number
}

export type DisturbanceView =
  | { measured: false; text: string }
  | { measured: true; rows: DisturbanceRow[] }

export interface TestEnvironmentView {
  hidden: boolean
  apps: TestEnvironmentApp[]
  disturbance: DisturbanceView
  notifications: string
}

const ROWS: Array<[DisturbanceRow['key'], string]> = [
  ['uacPrompts', 'UAC prompts'],
  ['visibleWindows', 'Visible windows'],
  ['foregroundSteals', 'Foreground steals'],
  ['consoleFlashes', 'Console flashes'],
  ['unexpectedDialogs', 'Unexpected dialogs'],
]

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

export function testEnvironmentView(input: {
  runId: string
  live: boolean
  apps: AppSessionView[] | undefined
  metrics: UserDisturbanceMetrics | undefined
}): TestEnvironmentView {
  const { runId, live, apps, metrics } = input
  const rows: TestEnvironmentApp[] = (apps ?? [])
    .filter((s) => s.runId === runId)
    .map((s) => ({
      id: s.id,
      name: `${APP_TYPE_LABEL[s.type]} ${s.id}`,
      state: s.state,
      stateLabel: APP_STATE_LABEL[s.state],
      mode: s.type === 'electron' ? 'Private desktop' : 'Headless',
      screenshots: s.screenshots,
      screenshotsLabel: count(s.screenshots, 'screenshot'),
      canViewScreenshot: s.state === 'running' && s.screenshots > 0,
    }))
  const disturbance: DisturbanceView = !metrics
    ? { measured: false, text: 'Not available yet' }
    : !metrics.measured
      ? { measured: false, text: 'Not measured' }
      : { measured: true, rows: ROWS.map(([key, label]) => ({ key, label, value: metrics[key] })) }
  const quiet = metrics?.measured === true && ROWS.every(([key]) => metrics[key] === 0)
  const hidden = !live && apps !== undefined && rows.length === 0 && quiet
  return { hidden, apps: rows, disturbance, notifications: NOTIFICATIONS_LINE }
}
