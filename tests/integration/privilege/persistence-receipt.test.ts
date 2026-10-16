import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '@main/modules/persistence'
import type { BrokerExecResult } from '@main/modules/privilege/broker-client'
import { receiptChainVault } from '@main/modules/privilege/chain-key'
import type { ProtectedStorage } from '@main/modules/intelligence/connection'
import type { PrivilegedPolicyEngine } from '@main/modules/privilege/policy'
import { buildPrivilegedActivityReport, buildPrivilegedActivitySummary } from '@main/modules/privilege/report'
import { PrivilegedReviewPipeline } from '@main/modules/privilege/review'
import { PrivilegeService, type BrokerHandle } from '@main/modules/privilege/service'
import { SqlitePrivilegeStore } from '@main/modules/privilege/store'
import { PRIVILEGED_CAPABILITIES, PrivilegedOperationProposalSchema, type PersistenceSnapshot, type PrivilegedPolicyDecision } from '@shared/privilege'

// 0.9.1 (second review, L5): the persistence an operation left behind reaches the STORED, chained receipt (the store
// chains the first final receipt and keeps it unchanged after it), and from there both privileged activity reports.

const storage: ProtectedStorage = {
  available: () => true,
  encrypt: (v) => Buffer.from(Buffer.from(v, 'utf8').reverse().toString('base64')),
  decrypt: (b) => Buffer.from(b.toString('utf8'), 'base64').reverse().toString('utf8'),
}

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const RUN = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'
const allowed: PrivilegedPolicyDecision = { verdict: 'ALLOWED', reason: 'ok', forbidden: null, councilRequired: false, councilWhy: [] }

const BEFORE: PersistenceSnapshot = { takenAt: '2026-10-16T01:00:00.000Z', durationMs: 5, items: [{ surface: 'SERVICE', id: 'ToolSvc', attrs: { startType: 'demand', binaryPath: 'C:\\Tool\\svc.exe' } }], coverage: {} }
const AFTER: PersistenceSnapshot = {
  takenAt: '2026-10-16T01:00:10.000Z',
  durationMs: 5,
  items: [
    { surface: 'SERVICE', id: 'ToolSvc', attrs: { startType: 'auto', binaryPath: 'C:\\Tool\\svc.exe' } },
    { surface: 'RUN_KEY', id: `${RUN}\\ToolUpdater`, attrs: { data: 'C:\\Tool\\updater.exe' } },
  ],
  coverage: { SCHEDULED_TASK: { state: 'FAILED', note: 'the task query failed (exit 1)' } },
}

const dirs: string[] = []
const dbs: Database[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

function setup(answer: BrokerExecResult) {
  const db = openDatabase(':memory:')
  dbs.push(db)
  const dir = mkdtempSync(join(tmpdir(), 'persistence-receipt-'))
  dirs.push(dir)
  const store = new SqlitePrivilegeStore(db, { vault: receiptChainVault(dir, storage), log: () => undefined })
  const broker: BrokerHandle = { alive: true, elevated: true, exec: async () => answer, end: async () => undefined }
  const snapshots = [BEFORE, AFTER]
  const events: { severity: string }[] = []
  const service = new PrivilegeService({
    store,
    policy: { precheck: () => allowed, final: () => allowed } as unknown as PrivilegedPolicyEngine,
    review: new PrivilegedReviewPipeline({ providers: async () => ({ technical: { complete: async () => ({ verdict: 'APPROVE', risk: 'LOW', reason: 'Narrow.', restrictions: [] }) } }) }),
    startBroker: async () => ({ ok: true, client: broker }),
    verify: async () => ['C:\\Tool\\svc.exe: present.'],
    persistence: async () => snapshots.shift() ?? AFTER,
    securityEvent: (e) => events.push(e),
  })
  return { store, service, events }
}

const install = PrivilegedOperationProposalSchema.parse({
  capability: 'PROJECT_TOOLCHAIN_INSTALL',
  goal: 'Install the tool',
  whyRequired: 'The build needs it.',
  whyElevation: 'It installs a service.',
  whyNoUnelevatedAlternative: 'Services need administrator rights.',
  executable: PS,
  args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\work\\racedeck\\install.ps1'],
  expected: { services: ['ToolSvc'] },
})
const who = { projectId: 'p1', runId: 'run-1', taskId: 'task-1', agentId: 'agent-1', role: 'WORKER' as const, missionTitle: 'RaceDeck', taskTitle: 'Install the tool', provenance: 'test' }
const ok: BrokerExecResult = { kind: 'result', exitCode: 0, durationMs: 120, timedOut: false, executable: PS, stagedSha256: null, leftoverEnded: 0, leftover: null, stdout: 'done', stderr: '', stdoutTruncated: false, stderrTruncated: false }

describe('persistence in the stored receipt and the reports', () => {
  for (const [name, answer, outcome] of [
    ['a program that ran', ok, 'EXECUTED'],
    ['a broker that went away', { kind: 'lost', reason: 'the relay ended' } as BrokerExecResult, 'ABORTED'],
  ] as const) {
    it(`keeps the persistence lines, the UNEXPECTED marker and the persistence field for ${name}`, async () => {
      const { store, service, events } = setup(answer)
      await service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
      const returned = await service.submit(install, who)
      expect(returned.outcome).toBe(outcome)

      const [stored] = store.receipts({ runId: 'run-1' })
      expect(stored).toBeDefined()
      if (stored === undefined) return
      expect(stored.outcome).toBe(outcome)
      expect(stored.observed).toEqual(expect.arrayContaining([expect.stringMatching(/run value .*ToolUpdater ADDED .*UNEXPECTED \(not declared\)/), expect.stringMatching(/service ToolSvc CHANGED .*expected \(declared\)/), expect.stringMatching(/^Persistence coverage .*scheduled task surface before COMPLETE, after FAILED/)]))
      expect(stored.persistence).toMatchObject({ unexpected: 1, coverageAfter: { SCHEDULED_TASK: { state: 'FAILED' } } })
      expect(stored.persistence?.changes.map((c) => [c.surface, c.change, c.expected])).toEqual([
        ['SERVICE', 'CHANGED', true],
        ['RUN_KEY', 'ADDED', false],
      ])
      expect(events.filter((e) => e.severity === 'ISOLATION_FAILURE')).toHaveLength(1)

      const verdict = store.verifyChain()
      expect(verdict).toMatchObject({ state: 'INTACT', pending: 0, findings: [] })
      const sessions = service.history()
      const full = buildPrivilegedActivityReport(store.receipts({ runId: 'run-1' }), sessions, verdict)
      expect(full).toContain('Persistence: 1 added, 0 removed, 1 changed, 1 UNEXPECTED (not declared)')
      expect(full).toMatch(/RUN_KEY .*ToolUpdater: ADDED.*UNEXPECTED \(not declared\)/)
      expect(full).toContain('ToolUpdater ADDED')
      const summary = buildPrivilegedActivitySummary(store.receipts({ runId: 'run-1' }), sessions, verdict)
      expect(summary).toContain('1 UNEXPECTED change (not declared)')
      expect(summary).toContain('SCHEDULED_TASK')
    })
  }
})
