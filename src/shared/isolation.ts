import type { ContainmentSettingName } from './security'

/**
 * 0.8: what the window shows about the containment of project code, and about the applications under test
 * that are running. Read-only views: nothing here is an instruction to the runtime.
 */

export interface ContainmentCheckView {
  available: boolean
  /** What was established at start, or why the profile is not available. */
  detail: string
  checkedAt: string
}

export interface IsolationStatusView {
  /** What Settings asks for. */
  requested: ContainmentSettingName
  /** What that means on this machine now. */
  effective: 'ISOLATED' | 'RESTRICTED' | 'STANDARD'
  /** Whether the effective profile was run at this start and held. When false, enrolled projects run no command. */
  usable: boolean
  detail: string
  isolated: ContainmentCheckView | null
  restricted: ContainmentCheckView | null
  /** Whether the machine's sandbox account is set up for this user. */
  sandboxAccount: boolean
  /** Whether this build can start the one-time setup (Windows, with its setup script present). */
  setupAvailable: boolean
  /** The folders and files marked unreadable for contained code. */
  protectedPaths: string[]
}

export interface SandboxSetupOutcome {
  ok: boolean
  detail: string
  status: IsolationStatusView
}

export interface AppSessionView {
  id: string
  projectId: string
  runId: string | null
  taskId: string | null
  type: 'web' | 'electron'
  state: 'starting' | 'running' | 'exited' | 'stopped'
  profile: 'ISOLATED' | 'RESTRICTED' | 'STANDARD'
  endpoint: string | null
  startedAt: string
  exitCode: number | null
  /** The last lines the application printed. */
  output: string[]
  /** How many screenshots were kept for this session. */
  screenshots: number
  note: string
}
