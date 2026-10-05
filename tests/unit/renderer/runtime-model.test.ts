import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from '@shared/runtime-protocol'
import type { WorkerLease, WorkerRecord } from '@shared/workers'
import { ageText, assignmentLine, heartbeat, HEARTBEAT_LATE_MS, identityRows, leaseRow, shortId, truncateMiddle, workerDuration, workerRow, WORKER_TONE } from '../../../src/renderer/src/views/control/runtimeModel'
import { AGING_HINT, claudeLine, COMPONENT_LABEL, describeDecision, dispatchView, ROW_LIMIT, visibleRows, workersLine } from '../../../src/renderer/src/views/control/controlModel'

const NOW = Date.parse('2026-01-01T01:00:00Z')
const worker = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({
  id: 'worker-0123456789',
  bootId: 'b',
  pid: 777,
  state: 'RUNNING',
  startedAt: '2026-01-01T00:55:00Z',
  heartbeatAt: '2026-01-01T00:59:55Z',
  stoppedAt: null,
  exitCode: null,
  error: null,
  assignments: 3,
  capabilities: ['claude'],
  assignment: { leaseId: 'l1', agentId: 'agent-abcdef123', runId: 'run-abcdef123', taskId: null, provider: 'claude', sessionId: 'session-abcdef123', worktree: 'C:\\Users\\me\\AppData\\Local\\nexus\\worktrees\\project\\task-123456', assignedAt: '2026-01-01T00:56:00Z' },
  ...over,
})

describe('worker view model', () => {
  it('measures heartbeat age and flags a live worker whose heartbeat is late', () => {
    expect(heartbeat(worker(), NOW)).toEqual({ text: '5 s ago', late: false })
    expect(heartbeat(worker({ heartbeatAt: new Date(NOW - HEARTBEAT_LATE_MS - 1000).toISOString() }), NOW).late).toBe(true)
    expect(heartbeat(worker({ heartbeatAt: null }), NOW)).toEqual({ text: 'none yet', late: true })
    expect(heartbeat(worker({ state: 'STARTING', heartbeatAt: null }), NOW).late).toBe(false)
    // An ended worker has no heartbeat to be late.
    expect(heartbeat(worker({ state: 'STOPPED' }), NOW)).toEqual({ text: '—', late: false })
  })

  it('formats ages and durations', () => {
    expect(ageText('2026-01-01T00:57:55Z', NOW)).toBe('2 min 5 s')
    expect(ageText('2025-12-31T22:30:00Z', NOW)).toBe('2 h 30 min')
    expect(ageText(null, NOW)).toBe('—')
    expect(workerDuration(worker(), NOW)).toBe('5 min 0 s')
    expect(workerDuration(worker({ state: 'STOPPED', stoppedAt: '2026-01-01T00:56:00Z' }), NOW)).toBe('1 min 0 s')
  })

  it('gives failed and recovering workers a distinct tone and attention, and shows why one failed', () => {
    expect(WORKER_TONE.FAILED).toBe('danger')
    expect(WORKER_TONE.RECOVERING).toBe('warning')
    expect(WORKER_TONE.RUNNING).not.toBe(WORKER_TONE.FAILED)
    const failed = workerRow(worker({ state: 'FAILED', error: 'The process exited.', assignment: null }), NOW)
    expect(failed).toMatchObject({ attention: true, tone: 'danger', error: 'The process exited.', assignment: 'None', worktree: '—' })
    expect(workerRow(worker({ state: 'FAILED', error: null, exitCode: 3 }), NOW).error).toBe('Exit code 3')
    expect(workerRow(worker({ state: 'RECOVERING' }), NOW).attention).toBe(true)
    expect(workerRow(worker(), NOW).attention).toBe(false)
  })

  it('shows short ids, the assignment, a truncated worktree with the full path kept', () => {
    const row = workerRow(worker(), NOW)
    expect(row).toMatchObject({ short: 'worker-0', pid: '777', provider: 'claude', session: 'session-', assignments: 3, state: 'Running' })
    expect(row.assignment).toBe('agent agent-ab · run run-abcd · task —')
    expect(row.worktree.length).toBeLessThanOrEqual(40)
    expect(row.worktree).toContain('…')
    expect(row.worktree.endsWith('task-123456')).toBe(true)
    expect(row.worktreeFull).toContain('AppData')
    expect(shortId(null)).toBe('—')
    expect(truncateMiddle('short')).toBe('short')
    expect(assignmentLine({ assignment: null })).toBe('None')
    expect(workerRow(worker({ pid: null, assignment: null }), NOW)).toMatchObject({ pid: '—', provider: 'claude' })
  })

  it('describes leases by state', () => {
    const lease = (over: Partial<WorkerLease> = {}): WorkerLease => ({ id: 'lease-1', workerId: 'worker-123456', bootId: 'b', agentId: 'agent-123456', runId: null, taskId: null, provider: 'claude', state: 'ACTIVE', grantedAt: '2026-01-01T00:56:00Z', heartbeatAt: '', expiresAt: '2026-01-01T01:05:00Z', releasedAt: null, reason: null, ...over })
    expect(leaseRow(lease(), NOW)).toMatchObject({ state: 'active', ends: 'expires in 5 min 0 s', reason: '—', granted: '4 min 0 s ago' })
    expect(leaseRow(lease({ state: 'RELEASED', releasedAt: '2026-01-01T00:58:00Z' }), NOW).ends).toBe('released 2 min 0 s ago')
    expect(leaseRow(lease({ state: 'EXPIRED', expiresAt: '2026-01-01T00:59:00Z', reason: 'heartbeat lost' }), NOW)).toMatchObject({ tone: 'warning', ends: 'expired 1 min 0 s ago', reason: 'heartbeat lost' })
    expect(leaseRow(lease({ state: 'REVOKED' }), NOW).tone).toBe('danger')
  })

  it('describes the runtime identity', () => {
    const status: RuntimeStatus = { protocol: 1, version: '0.7.0', pid: 99, bootId: 'b', startedAt: '2026-01-01T00:00:00Z', phase: 'READY', recovery: { workloads: 3, workers: 2, leases: 1, finishedAt: '2026-01-01T00:00:05Z' }, clients: { desktop: 1, tool: 0 }, dispatchPaused: false, endpointAcl: 'inherited', resources: { uptimeSeconds: 60, rssMb: 120, heapUsedMb: 40, timers: 5, handles: 9, dbMb: 2, walMb: 0.1 }, keepAlive: { reason: 'Work is running' } }
    const rows = Object.fromEntries(identityRows(status).map((r) => [r.label, r.value]))
    expect(rows['Process']).toBe('99')
    expect(rows['Clients']).toBe('1 window, 0 tools')
    expect(rows['Stays running because']).toBe('Work is running')
    expect(rows['Endpoint access']).toContain('Inherited')
    expect(rows['Last recovery']).toContain('3 workloads, 2 workers, 1 lease')
    expect(identityRows({ ...status, endpointAcl: 'restricted', keepAlive: { reason: null } }).find((r) => r.label === 'Endpoint access')?.value).toContain('Restricted')
  })
})

describe('runtime strip, dispatch and long lists', () => {
  it('labels the dispatch control for both states, and says what a pause does', () => {
    expect(dispatchView(false)).toMatchObject({ state: 'Running', button: 'Pause dispatch', notice: null, next: true })
    const paused = dispatchView(true)
    expect(paused).toMatchObject({ state: 'Paused', button: 'Resume dispatch', next: false })
    expect(paused.notice).toContain('nothing new starts')
    expect(paused.notice).toContain('running continues')
  })

  it('says where sessions run when there are no worker processes', () => {
    expect(workersLine({ live: 4, busy: 3, max: 6 })).toEqual({ value: '4 / 6', detail: '3 busy' })
    expect(workersLine(null).detail).toContain('inside the runtime')
    expect(claudeLine(true)).toBe('Available')
    expect(claudeLine(false)).toContain('Waiting')
  })

  it('names the runtime components as the brief does, and explains aging', () => {
    expect(['database', 'scheduler', 'workers', 'providers', 'git', 'usage', 'ipc', 'power_supervisor', 'schedules'].map((k) => COMPONENT_LABEL[k])).toEqual(['Database', 'Global scheduler', 'Worker manager', 'Providers', 'Git', 'Usage', 'IPC', 'Power', 'Schedules'])
    expect(AGING_HINT).toContain('one priority higher')
  })

  it('cuts long lists and can show the rest', () => {
    const rows = Array.from({ length: 120 }, (_, i) => i)
    expect(visibleRows(rows, false)).toMatchObject({ hidden: 120 - ROW_LIMIT })
    expect(visibleRows(rows, false).rows).toHaveLength(ROW_LIMIT)
    expect(visibleRows(rows, true)).toMatchObject({ hidden: 0 })
    expect(visibleRows(rows, true).rows).toHaveLength(120)
    expect(visibleRows(rows.slice(0, 10), false).hidden).toBe(0)
  })

  it('reads a scheduler decision as a sentence', () => {
    expect(describeDecision({ at: 'x', decision: 'wait_for_capacity', reason: 'No agent is free.' })).toEqual({ at: 'x', label: 'Wait for capacity', reason: 'No agent is free.' })
    expect(describeDecision({ at: 'x', decision: '', reason: 'r' }).label).toBe('Decision')
  })
})
