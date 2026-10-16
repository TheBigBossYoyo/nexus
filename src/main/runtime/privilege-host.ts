import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, win32 } from 'node:path'
import type { SecurityEventSeverity } from '@shared/autonomy'
import type { PrivilegeSessionStatus, PrivilegedOperationRequest } from '@shared/privilege'
import type { AdvisoryProvider } from '../modules/intelligence/compiler'
import type { PrivilegeRecords } from '../modules/ipc/privilege-handlers'
import type { Database } from '../modules/persistence/database'
import { ElevatedBrokerClient } from '../modules/privilege/broker-client'
import { PrivilegedPolicyEngine } from '../modules/privilege/policy'
import { buildPrivilegedActivityReport, buildPrivilegedActivitySummary } from '../modules/privilege/report'
import { PrivilegedReviewPipeline } from '../modules/privilege/review'
import { PrivilegeService } from '../modules/privilege/service'
import { SqlitePrivilegeStore } from '../modules/privilege/store'
import { createPrivilegeVerifier } from '../modules/privilege/verify'

/**
 * 0.9.1: what the runtime gives privilege sessions: the broker helper next to the other native helpers, NEXUS's own
 * elevated scripts and the acceptance fixture's, the reviewers (the Technical Director and the strategic Director
 * through the advisory routing), the receipts in the database, and the unelevated verification.
 *
 * `NEXUS_PRIVILEGE_UNELEVATED_TEST=1` (development builds only) starts the broker without elevation: the protocol,
 * the reviews and the receipts are exercised with no UAC prompt, and nothing runs with rights the user lacks.
 */

export interface PrivilegeHostDeps {
  db: Database
  dataDir: string
  launcherPath: string | undefined
  resourcesPath: string | undefined
  sandboxSetupDir: string | undefined
  isPackaged: boolean
  env: Record<string, string | undefined>
  runtimePid: number
  /** The worktrees and the project folder of a run: where a project's installer or repair script may come from. */
  projectRoots: (runId: string | null) => string[]
  /** The reviewers for one operation (the advisory routing), or none. */
  reviewers: (projectId: string | null, operationId: string) => Promise<{ technical?: AdvisoryProvider; strategic?: AdvisoryProvider }>
  securityEvent: (e: { severity: SecurityEventSeverity; runId: string | null; projectId: string | null; taskId: string | null; agentId: string | null; action: string; reason: string }) => void
  onChange: (status: PrivilegeSessionStatus | null) => void
  /** 0.9.1 (review F3): the owner's own confirmation of one operation, natively. */
  confirmOwner?: (o: { title: string; message: string; detail: string }) => Promise<boolean>
  /** 0.9.1 (second review, H1): why no session may be prepared now (an uncontained mission runs), or null. */
  blockedBy?: (runId: string | null) => string | null
  log: (line: string) => void
}

export interface PrivilegeHost {
  service: PrivilegeService | null
  /** Why there is no service. */
  unavailableReason: string | null
  /** The privileged activity of a run, short (the Overnight report) or full (the Activity screen). */
  section(runId: string, full?: boolean): string
  /** The UAC prompts the privilege sessions of a run caused. */
  uacPrompts(runId: string): number
  /** M7: the receipts, sessions and chain verification in the database, with or without a service. */
  records: PrivilegeRecords
}

const underFolder = (path: string, root: string): boolean => win32.normalize(path).toLowerCase().startsWith(`${win32.normalize(root).toLowerCase().replace(/\\+$/, '')}\\`)

/** A script a request names, to be checked against the deny list (review F3); larger than any script NEXUS runs, refused. */
const readScript = (path: string): Buffer | null => {
  try {
    if (statSync(path).size > 2 * 1024 * 1024) return null
    return readFileSync(path)
  } catch {
    return null
  }
}

const sha256 = (path: string): string | null => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

export function createPrivilegeHost(d: PrivilegeHostDeps): PrivilegeHost {
  const helper = d.launcherPath !== undefined ? join(dirname(d.launcherPath), 'nexus-elevate.exe') : null
  const store = new SqlitePrivilegeStore(d.db)
  const sectionOf = (runId: string, full = false): string => {
    const receipts = store.receipts({ runId, limit: 1000 })
    const sessions = store.sessions({ runId, limit: 20 }).map((s) => ({ ...s, counts: store.counts(s.id) }))
    const integrity = store.verifyChain()
    // M7: a broken record is never hidden, even from a run with no privileged activity of its own.
    if (receipts.length === 0 && sessions.length === 0 && integrity.state !== 'BROKEN') return ''
    return full ? buildPrivilegedActivityReport(receipts, sessions, integrity) : buildPrivilegedActivitySummary(receipts, sessions, integrity)
  }
  let unavailableReason: string | null = null
  if (process.platform !== 'win32') unavailableReason = 'Privilege sessions are a Windows feature.'
  else if (helper === null || !existsSync(helper)) unavailableReason = 'The privilege broker is not part of this build.'
  // 0.9.1 (review F1): the broker is the one program started with administrator rights. In a folder the user can write
  // (an install for this user only), any program running as the user could replace it before the UAC prompt. It is
  // started only from under Program Files, which only administrators can change; the broker checks its folder too.
  else if (d.isPackaged && !underFolder(helper, d.env['ProgramFiles'] ?? 'C:\\Program Files')) unavailableReason = 'NEXUS is installed for this user only, in a folder any program you run can change; privilege sessions need NEXUS installed for all users (under Program Files).'
  const uacPrompts = (runId: string): number => store.sessions({ runId, limit: 50 }).reduce((n, s) => n + s.uacPrompts, 0)
  const records: PrivilegeRecords = {
    receipts: (opts) => store.receipts(opts),
    history: (limit = 10) => store.sessions({ limit }).map((s) => ({ ...s, counts: store.counts(s.id) })),
    verifyChain: () => store.verifyChain(),
  }
  if (unavailableReason !== null || helper === null) return { service: null, unavailableReason, section: sectionOf, uacPrompts, records }
  const helperPath: string = helper

  const testMode = !d.isPackaged && d.env['NEXUS_PRIVILEGE_UNELEVATED_TEST'] === '1'
  const systemRoot = d.env['SystemRoot'] ?? 'C:\\Windows'
  const programFiles = d.env['ProgramFiles'] ?? 'C:\\Program Files'
  const programFilesX86 = d.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  // Packaged: resources/privilege-fixture. From the source tree: native/privilege-fixture (the helpers are in out/native).
  const fixtureDir = d.resourcesPath !== undefined ? join(d.resourcesPath, 'privilege-fixture') : d.launcherPath !== undefined ? resolve(dirname(d.launcherPath), '..', '..', 'native', 'privilege-fixture') : null
  const scriptsDir = d.sandboxSetupDir ?? null
  // 0.9.1 (review F8): where an elevated script writes its result and Windows Installer its log; nowhere else.
  const resultsDir = join(d.dataDir, 'privilege', 'results')
  mkdirSync(resultsDir, { recursive: true })

  const service: PrivilegeService = new PrivilegeService({
    store,
    policy: new PrivilegedPolicyEngine((req) => ({
      systemRoot,
      programFiles,
      programFilesX86,
      nexusScriptsDir: scriptsDir !== null && existsSync(scriptsDir) ? scriptsDir : null,
      fixtureDir: fixtureDir !== null && existsSync(fixtureDir) ? fixtureDir : null,
      trustedHash: sha256,
      projectRoots: req === null ? [] : d.projectRoots(req.runId),
      sessionCapabilities: service.sessionCapabilities(),
      readFile: readScript,
      resultsDir,
    })),
    review: new PrivilegedReviewPipeline({ providers: (req) => d.reviewers(req.projectId, `privileged:${req.id}`) }),
    startBroker: async (o) => {
      const staging = join(d.dataDir, 'privilege', 'test-staging', o.session)
      if (testMode) mkdirSync(staging, { recursive: true })
      d.log(testMode ? 'privilege: starting the broker UNELEVATED (test mode, no UAC prompt)' : 'privilege: asking Windows for the administrator broker (one UAC prompt)')
      return ElevatedBrokerClient.start({
        helperPath,
        runtimePid: d.runtimePid,
        session: o.session,
        expiresAt: o.expiresAt,
        capabilities: o.capabilities,
        cwd: systemRoot,
        ...(testMode ? { unelevatedTest: { stagingDir: staging } } : {}),
        log: d.log,
        onEnded: o.onEnded,
      })
    },
    verify: createPrivilegeVerifier({ systemRoot }),
    // setup-sandbox.ps1 reads its checks from the file beside it: staged beside it, with its own hash.
    companions: (req: PrivilegedOperationRequest) => {
      if (scriptsDir === null || !/setup-sandbox\.ps1$/i.test(req.args[5] ?? '')) return []
      const checks = win32.join(scriptsDir, 'sandbox-checks.ps1')
      const hash = sha256(checks)
      return hash === null ? [] : [{ path: checks, sha256: hash }]
    },
    securityEvent: d.securityEvent,
    onChange: d.onChange,
    ...(d.confirmOwner ? { confirmOwner: d.confirmOwner } : {}),
    ...(d.blockedBy ? { blockedBy: d.blockedBy } : {}),
    log: d.log,
  })
  service.recover()
  return { service, unavailableReason: null, section: sectionOf, uacPrompts, records }
}
