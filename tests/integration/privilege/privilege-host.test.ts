import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '@main/modules/persistence'
import { receiptChainVault } from '@main/modules/privilege/chain-key'
import { SqlitePrivilegeStore } from '@main/modules/privilege/store'
import { createPrivilegeHost } from '@main/runtime/privilege-host'
import type { ProtectedStorage } from '@main/modules/intelligence/connection'
import type { PrivilegedOperationReceipt } from '@shared/privilege'

// M7: the host builds the store with the receipt-chain vault, and a run's section never hides a broken record.

const storage: ProtectedStorage = {
  available: () => true,
  encrypt: (v) => Buffer.from(Buffer.from(v, 'utf8').reverse().toString('base64')),
  decrypt: (b) => Buffer.from(b.toString('utf8'), 'base64').reverse().toString('utf8'),
}

const receipt = (id: string, runId: string): PrivilegedOperationReceipt => ({
  id,
  sessionId: 's1',
  requestedAt: '2026-10-14T02:00:00.001Z',
  finishedAt: '2026-10-14T02:00:30.001Z',
  projectId: 'p1',
  runId,
  taskId: 't1',
  missionTitle: 'Mission',
  taskTitle: 'Task',
  role: 'WORKER',
  agentId: null,
  capability: 'PROJECT_TOOLCHAIN_REPAIR',
  goal: 'Repair the toolchain',
  whyRequired: 'w',
  whyElevation: 'e',
  whyNoUnelevatedAlternative: 'n',
  executable: 'C:\\Windows\\System32\\sc.exe',
  args: ['query'],
  cwd: null,
  envNames: [],
  expected: { files: [], registry: [], services: [], network: 'none' },
  rollback: '',
  provenance: 'test',
  followsOperationId: null,
  precheck: { verdict: 'ALLOWED', reason: 'ok', forbidden: null, councilRequired: false, councilWhy: [] },
  reviews: [],
  finalPolicy: null,
  outcome: 'EXECUTED',
  outcomeReason: 'r',
  exitCode: 0,
  durationMs: null,
  observed: [],
  stdout: '',
  stderr: '',
  stagedSha256: null,
})

const dirs: string[] = []
const dbs: Database[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

function setup() {
  const db = openDatabase(':memory:')
  dbs.push(db)
  const dataDir = mkdtempSync(join(tmpdir(), 'privilege-host-'))
  dirs.push(dataDir)
  mkdirSync(join(dataDir, 'privilege'), { recursive: true })
  const host = createPrivilegeHost({
    db,
    dataDir,
    protectedStorage: storage,
    launcherPath: undefined,
    resourcesPath: undefined,
    sandboxSetupDir: undefined,
    isPackaged: false,
    env: {},
    runtimePid: 1,
    projectRoots: () => [],
    reviewers: async () => ({}),
    securityEvent: () => undefined,
    onChange: () => undefined,
    log: () => undefined,
  })
  // The same database and vault directory the host uses.
  const store = new SqlitePrivilegeStore(db, { vault: receiptChainVault(join(dataDir, 'privilege'), storage), log: () => undefined })
  return { db, host, store }
}

describe('createPrivilegeHost receipt chain', () => {
  it('shows the BROKEN verdict in a run whose only chained receipt was deleted, and nothing for an untouched empty run', () => {
    const { db, host, store } = setup()
    store.record(receipt('op-1', 'r1'))
    expect(host.integrity().state).toBe('INTACT')

    db.prepare('DELETE FROM privileged_operations WHERE id = ?').run('op-1')
    expect(host.integrity().state).toBe('BROKEN')
    expect(host.section('r1')).toContain('BROKEN')
    expect(host.section('r1', true)).toContain('BROKEN')
  })

  it('returns an empty section for an empty run while the record is intact', () => {
    const { host, store } = setup()
    store.record(receipt('op-1', 'r1'))
    expect(host.integrity().state).toBe('INTACT')
    expect(host.section('r2')).toBe('')
  })
})
