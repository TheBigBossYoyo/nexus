import type { OvernightStatus } from '@shared/overnight'

export type TrayStatus = 'RUNNING' | 'PAUSED' | 'FINALIZING' | 'SHUTDOWN SCHEDULED'
export type TrayAction = 'open' | 'pause' | 'resume' | 'cancelPower' | 'cancelMission'

export interface TrayItem {
  action: TrayAction
  label: string
  enabled: boolean
}

export interface TrayModel {
  /** The tray icon exists only while an overnight mission needs the app to stay alive. */
  visible: boolean
  runId: string | null
  status: TrayStatus | null
  tooltip: string
  lines: string[]
  items: TrayItem[]
}

export interface TrayInput {
  overnight: OvernightStatus | null
  projectName: string
  runState: string | null
  activeAgents: number
  /** Formats an ISO timestamp as local wall-clock time. */
  time: (iso: string) => string
}

const HIDDEN: TrayModel = { visible: false, runId: null, status: null, tooltip: 'NEXUS', lines: [], items: [] }

const ACTION_LABEL: Record<string, string> = { SHUTDOWN: 'Shutdown', SLEEP: 'Sleep', HIBERNATE: 'Hibernate' }

/** Pure description of the tray icon for the current overnight run; the Electron binding only renders it. */
export function buildTrayModel(input: TrayInput): TrayModel {
  const o = input.overnight
  if (!o) return HIDDEN
  const live = o.state === 'ARMING' || o.state === 'RUNNING' || o.state === 'QUOTA_PAUSED' || o.state === 'FINALIZING' || o.state === 'POWER_ACTION_SCHEDULED' || o.state === 'CANCELLING'
  if (!live) return HIDDEN

  const pendingFinal = o.state === 'POWER_ACTION_SCHEDULED' && o.powerAction !== null && !o.powerAction.cancelledAt && !o.powerAction.executedAt
  const failsafeArmed = o.failsafe !== null && o.failsafe.result.ok && !o.failsafe.cancelledAt && !o.failsafe.lostAt
  const paused = o.state === 'QUOTA_PAUSED' || input.runState === 'paused'
  const status: TrayStatus = pendingFinal ? 'SHUTDOWN SCHEDULED' : o.state === 'FINALIZING' || o.state === 'CANCELLING' ? 'FINALIZING' : paused ? 'PAUSED' : 'RUNNING'

  const what = o.workloadType === 'arena_campaign' ? 'Arena campaign' : o.workloadType === 'program' ? 'program' : 'mission'
  const lines = ['NEXUS']
  if (status === 'SHUTDOWN SCHEDULED' && o.powerAction) {
    lines.push(`Overnight ${what} finished`, `${ACTION_LABEL[o.powerAction.action] ?? o.powerAction.action} scheduled ${input.time(o.powerAction.executeAt)}`)
  } else {
    lines.push(status === 'PAUSED' ? (o.state === 'QUOTA_PAUSED' ? `Overnight ${what} waiting for the usage limit` : `Overnight ${what} paused`) : status === 'FINALIZING' ? `Overnight ${what} finalizing` : `Overnight ${what} running`)
    lines.push(`${input.activeAgents} agent${input.activeAgents === 1 ? '' : 's'} active`)
    if (failsafeArmed && o.failsafe) lines.push(`Shutdown scheduled ${input.time(o.failsafe.deadline)}`)
    else if (o.policy.endAction === 'NONE') lines.push('No power action')
  }
  // Windows truncates tray tooltips at 127 characters.
  const tooltip = [`NEXUS: ${input.projectName}`, status, ...lines.slice(2)].join('\n').slice(0, 127)

  const working = o.state === 'RUNNING' || o.state === 'QUOTA_PAUSED'
  const items: TrayItem[] = [
    { action: 'open', label: 'Open NEXUS', enabled: true },
    input.runState === 'paused' && o.state === 'RUNNING'
      ? { action: 'resume', label: 'Resume', enabled: true }
      : { action: 'pause', label: 'Pause', enabled: o.state === 'RUNNING' && input.runState !== 'paused' },
    { action: 'cancelPower', label: 'Cancel shutdown', enabled: pendingFinal || (working && (failsafeArmed || o.policy.endAction !== 'NONE')) },
    { action: 'cancelMission', label: o.workloadType === 'arena_campaign' ? 'Cancel campaign' : o.workloadType === 'program' ? 'Cancel program' : 'Cancel mission', enabled: working },
  ]
  return { visible: true, runId: o.runId, status, tooltip, lines, items }
}

export type CloseChoice = 'hide' | 'cancel' | 'return'

/** What closing the main window does. With no overnight mission the window simply closes. */
export function closeBehaviour(hasActiveOvernight: boolean): 'close' | 'ask' {
  return hasActiveOvernight ? 'ask' : 'close'
}

export const CLOSE_DIALOG = {
  message: 'NEXUS is running an overnight mission.',
  detail: 'Closing the window does not stop it. The mission, its failsafe and its end-of-run power action are owned by the NEXUS background process.',
  buttons: ['Hide to tray and continue', 'Cancel mission', 'Return'] as const,
  choices: ['hide', 'cancel', 'return'] as const satisfies readonly CloseChoice[],
}
