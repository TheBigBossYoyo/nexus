import type { RuntimeStatus } from '@shared/runtime-protocol'
import type { LeaseState, WorkerLease, WorkerRecord, WorkerState } from '@shared/workers'
import { LIVE_WORKER_STATES } from '@shared/workers'
import { formatWhen } from '../../lib/dates'
import type { Tone } from '../../lib/status'

/** DOM-free model of the runtime diagnostics: the worker table, the leases and the runtime's identity. */

export const shortId = (id: string | null | undefined, n = 8): string => (id ? id.slice(0, n) : '—')

export const WORKER_TONE: Record<WorkerState, Tone> = {
  STARTING: 'waiting',
  IDLE: 'neutral',
  ASSIGNED: 'active',
  RUNNING: 'active',
  DRAINING: 'waiting',
  STOPPING: 'neutral',
  STOPPED: 'neutral',
  FAILED: 'danger',
  RECOVERING: 'warning',
}

export const WORKER_STATE_LABEL: Record<WorkerState, string> = {
  STARTING: 'Starting',
  IDLE: 'Idle',
  ASSIGNED: 'Assigned',
  RUNNING: 'Running',
  DRAINING: 'Draining',
  STOPPING: 'Stopping',
  STOPPED: 'Stopped',
  FAILED: 'Failed',
  RECOVERING: 'Recovering',
}

export const LEASE_TONE: Record<LeaseState, Tone> = {
  ACTIVE: 'active',
  RELEASED: 'neutral',
  EXPIRED: 'warning',
  REVOKED: 'danger',
}

/** A live worker whose last heartbeat is older than this is shown as late. */
export const HEARTBEAT_LATE_MS = 30_000

/** A span in the unit that reads best: "12 s", "3 min 5 s", "2 h 4 min". */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

export function ageText(fromIso: string | null, nowMs: number): string {
  if (!fromIso) return '—'
  const t = Date.parse(fromIso)
  return Number.isFinite(t) ? spanText(nowMs - t) : '—'
}

export function heartbeat(
  w: Pick<WorkerRecord, 'state' | 'heartbeatAt'>,
  nowMs: number,
): { text: string; late: boolean } {
  if (!LIVE_WORKER_STATES.includes(w.state)) return { text: '—', late: false }
  if (!w.heartbeatAt) return { text: 'none yet', late: w.state !== 'STARTING' }
  const age = nowMs - Date.parse(w.heartbeatAt)
  return { text: `${spanText(age)} ago`, late: Number.isFinite(age) && age > HEARTBEAT_LATE_MS }
}

/** How long the worker has run: up to its stop for an ended one, up to now for a live one. */
export function workerDuration(
  w: Pick<WorkerRecord, 'startedAt' | 'stoppedAt'>,
  nowMs: number,
): string {
  const end = w.stoppedAt ? Date.parse(w.stoppedAt) : nowMs
  const start = Date.parse(w.startedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—'
  return spanText(end - start)
}

export function assignmentLine(w: Pick<WorkerRecord, 'assignment'>): string {
  const a = w.assignment
  if (!a) return 'None'
  return `agent ${shortId(a.agentId)} · run ${shortId(a.runId)} · task ${shortId(a.taskId)}`
}

/** A path cut in the middle so its end (the folder name) stays readable; the full path goes in a title. */
export function truncateMiddle(text: string, max = 40): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep / 3)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

export interface WorkerRow {
  id: string
  short: string
  pid: string
  state: string
  tone: Tone
  /** Failed and recovering workers stand out in the table. */
  attention: boolean
  assignment: string
  provider: string
  session: string
  heartbeat: string
  heartbeatLate: boolean
  duration: string
  worktree: string
  worktreeFull: string
  assignments: number
  error: string | null
}

export function workerRow(w: WorkerRecord, nowMs: number): WorkerRow {
  const hb = heartbeat(w, nowMs)
  return {
    id: w.id,
    short: shortId(w.id),
    pid: w.pid === null ? '—' : String(w.pid),
    state: WORKER_STATE_LABEL[w.state],
    tone: WORKER_TONE[w.state],
    attention: w.state === 'FAILED' || w.state === 'RECOVERING',
    assignment: assignmentLine(w),
    provider: w.assignment?.provider ?? (w.capabilities.join(', ') || '—'),
    session: shortId(w.assignment?.sessionId),
    heartbeat: hb.text,
    heartbeatLate: hb.late,
    duration: workerDuration(w, nowMs),
    worktree: w.assignment ? truncateMiddle(w.assignment.worktree) : '—',
    worktreeFull: w.assignment?.worktree ?? '',
    assignments: w.assignments,
    error: w.state === 'FAILED' ? (w.error ?? (w.exitCode !== null ? `Exit code ${w.exitCode}` : null)) : null,
  }
}

export interface LeaseRow {
  id: string
  state: string
  tone: Tone
  agent: string
  worker: string
  granted: string
  ends: string
  reason: string
}

export function leaseRow(l: WorkerLease, nowMs: number): LeaseRow {
  const ends = l.releasedAt
    ? `released ${ageText(l.releasedAt, nowMs)} ago`
    : l.state === 'ACTIVE'
      ? Date.parse(l.expiresAt) > nowMs
        ? `expires in ${spanText(Date.parse(l.expiresAt) - nowMs)}`
        : 'expires now'
      : `expired ${ageText(l.expiresAt, nowMs)} ago`
  return {
    id: l.id,
    state: l.state.toLowerCase(),
    tone: LEASE_TONE[l.state],
    agent: shortId(l.agentId),
    worker: shortId(l.workerId),
    granted: `${ageText(l.grantedAt, nowMs)} ago`,
    ends,
    reason: l.reason ?? '—',
  }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function identityRows(s: RuntimeStatus): { label: string; value: string }[] {
  const r = s.recovery
  return [
    { label: 'Process', value: String(s.pid) },
    { label: 'Started', value: formatWhen(s.startedAt) },
    { label: 'Version', value: s.version },
    { label: 'Protocol', value: String(s.protocol) },
    {
      label: 'Clients',
      value: `${plural(s.clients.desktop, 'window')}, ${plural(s.clients.tool, 'tool')}`,
    },
    {
      label: 'Stays running because',
      value: s.keepAlive.reason ?? 'Nothing: it stops by itself after a quiet period with no window',
    },
    {
      label: 'Endpoint access',
      value:
        s.endpointAcl === 'restricted'
          ? 'Restricted to your Windows user'
          : 'Inherited from the data folder (could not be narrowed)',
    },
    {
      label: 'Last recovery',
      value: `${plural(r.workloads, 'workload')}, ${plural(r.workers, 'worker')}, ${plural(r.leases, 'lease')}${r.finishedAt ? `, finished ${formatWhen(r.finishedAt)}` : ', still in progress'}`,
    },
  ]
}

export const SHUTDOWN_CONFIRMATION = {
  title: 'Stop the NEXUS runtime?',
  lines: [
    'This stops the background runtime that runs your work.',
    'Running work is paused and can be resumed the next time NEXUS starts.',
    'Closing only the window stops nothing: work continues in the runtime.',
  ],
  confirmLabel: 'Stop runtime',
  keepLabel: 'Keep it running',
} as const

/** The lines of the stop dialog: what stops, how much work is running, and what this window shows afterwards. */
export function shutdownLines(running: number | null): string[] {
  const work =
    running === null
      ? 'It is not known how many workloads are running.'
      : running === 0
        ? 'No workload is running now.'
        : `${running} workload${running === 1 ? ' is' : 's are'} running now and will be paused.`
  return [...SHUTDOWN_CONFIRMATION.lines, work, 'This window will then show the disconnected state until the runtime is started again.']
}
