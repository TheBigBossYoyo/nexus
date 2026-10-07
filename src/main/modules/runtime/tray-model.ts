import type { HealthLevel } from '@shared/control-plane'
import type { TrayModel } from '@main/modules/overnight/tray-model'

export type RuntimeTrayAction = 'open' | 'openControl' | 'pauseDispatch' | 'resumeDispatch' | 'stop'
export type RuntimeTrayStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'ATTENTION' | 'RECOVERING'

export interface RuntimeTrayInput {
  phase: 'RECOVERING' | 'READY' | 'STOPPING'
  /** Workloads that hold or wait for agents. */
  running: number
  waiting: number
  blocked: number
  agents: number
  health: HealthLevel
  dispatchPaused: boolean
}

export interface RuntimeTrayModel {
  status: RuntimeTrayStatus
  tooltip: string
  lines: string[]
  items: { action: RuntimeTrayAction; label: string; enabled: boolean }[]
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * What the tray says about the runtime: the icon exists while the runtime does, with or without a window.
 * Pure; the Electron binding renders it. Nothing destructive is one click away: "Stop NEXUS" asks first.
 */
export function buildRuntimeTrayModel(input: RuntimeTrayInput): RuntimeTrayModel {
  const status: RuntimeTrayStatus =
    input.phase === 'RECOVERING' ? 'RECOVERING' : input.blocked > 0 || input.health === 'BLOCKED' || input.health === 'DEGRADED' ? 'ATTENTION' : input.dispatchPaused ? 'PAUSED' : input.running > 0 ? 'RUNNING' : 'IDLE'
  const headline =
    input.phase === 'RECOVERING'
      ? 'recovering after a restart'
      : input.running > 0
        ? `${plural(input.running, 'workload')} running`
        : input.waiting > 0
          ? `${plural(input.waiting, 'workload')} waiting`
          : 'idle'
  const lines = [`NEXUS · ${headline}`]
  if (input.running > 0) lines.push(`${plural(input.agents, 'agent')} active`)
  if (input.running > 0 && input.waiting > 0) lines.push(`${plural(input.waiting, 'workload')} waiting`)
  if (input.blocked > 0) lines.push(`${plural(input.blocked, 'workload')} blocked`)
  if (input.dispatchPaused) lines.push('Dispatch is paused')
  if (input.health === 'DEGRADED' || input.health === 'BLOCKED') lines.push(`Runtime health: ${input.health.toLowerCase()}`)
  return {
    status,
    // Windows truncates tray tooltips at 127 characters.
    tooltip: lines.join('\n').slice(0, 127),
    lines,
    items: [
      { action: 'open', label: 'Open NEXUS', enabled: true },
      { action: 'openControl', label: 'Open Control Center', enabled: true },
      input.dispatchPaused ? { action: 'resumeDispatch', label: 'Resume dispatch', enabled: input.phase === 'READY' } : { action: 'pauseDispatch', label: 'Pause dispatch', enabled: input.phase === 'READY' },
      { action: 'stop', label: 'Stop NEXUS…', enabled: input.phase !== 'STOPPING' },
    ],
  }
}

/** What `runtime.tray` returns: the overnight part is the model 0.2 to 0.6 showed, unchanged. */
export interface TraySnapshot {
  overnight: TrayModel | null
  runtime: RuntimeTrayModel
}
