import { win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_SESSION_CAPABILITIES,
  type PersistenceReport,
  type PersistenceSnapshot,
  type PrivilegeSessionScope,
  type PrivilegeSessionStatus,
  type PrivilegedCapability,
  type PrivilegedOperationProposal,
  type PrivilegedOperationReceipt,
  type PrivilegedOperationRequest,
  type PrivilegedOperationReview,
  type PrivilegedOutcome,
  type PrivilegedPolicyDecision,
  type PrivilegedRequesterRole,
} from '@shared/privilege'
import type { SecurityEventSeverity } from '@shared/autonomy'
import type { BrokerExecRequest, BrokerExecResult, BrokerStart } from './broker-client'
import type { ReceiptChainVerification } from './chain'
import { PERSISTENCE_CAPABILITIES, diffPersistence, persistenceObservedLines } from './persistence'
import { redactArgs, redactText, type PrivilegedPolicyEngine } from './policy'
import type { PrivilegedReviewPipeline } from './review'
import type { PrivilegeSessionRow, PrivilegeStore } from './store'

/**
 * 0.9.1: privilege sessions (B1, B2, B9, B11, B14). One session at a time, prepared by the owner with ONE UAC
 * prompt, bound to a scope: a single operation, a mission, until NEXUS is idle, or one Overnight run. Within it any
 * number of operations may run, a failed one and the repairs it leads to included, with no further prompt, each
 * through the same pipeline: deterministic precheck, Technical Director (and Council when warranted), deterministic
 * final policy, the broker, verification, receipt. Every attempt has a receipt, refused ones too.
 *
 * The session ends when its scope ends, when its time is over, when the owner revokes it, when NEXUS stops, or when
 * the broker ends or can no longer be believed. A session is never carried over: NEXUS restarted means the session
 * is over (its broker ended with the runtime it watched), and the next Overnight prepares its own.
 */

/** The broker, as the service sees it (ElevatedBrokerClient). */
export interface BrokerHandle {
  readonly alive: boolean
  readonly elevated: boolean
  exec(req: BrokerExecRequest): Promise<BrokerExecResult>
  end(): Promise<void>
  /** Why it ended, as it said: with what it could not end ("may still be running: ..."). */
  readonly endReason?: string | null
}

export interface PrivilegeServiceDeps {
  store: PrivilegeStore
  policy: PrivilegedPolicyEngine
  review: PrivilegedReviewPipeline
  /** Starts the broker for a session: the one UAC prompt. `onEnded` is called when it goes away by itself. */
  startBroker: (o: { session: string; expiresAt: Date; capabilities: readonly PrivilegedCapability[]; onEnded: (reason: string) => void }) => Promise<BrokerStart | { ok: true; client: BrokerHandle }>
  /** What can be observed after an operation (files, registry keys, services), unelevated. */
  verify?: (req: PrivilegedOperationRequest) => Promise<string[]>
  /**
   * 0.9.1 (second review, L5): an unelevated, read-only snapshot of the persistence surfaces (services, scheduled
   * tasks, Run keys, the all-users StartUp folder), taken before and after an operation that installs, repairs or uninstalls.
   */
  persistence?: (signal?: AbortSignal) => Promise<PersistenceSnapshot>
  /** Companion files a request needs staged beside it (a shipped script's own helpers), with their hashes. */
  companions?: (req: PrivilegedOperationRequest) => { path: string; sha256: string }[]
  /** A security event worth the owner's attention (a forbidden request, a broker that could not be believed). */
  securityEvent?: (e: { severity: SecurityEventSeverity; runId: string | null; projectId: string | null; taskId: string | null; agentId: string | null; action: string; reason: string }) => void
  onChange?: (status: PrivilegeSessionStatus | null) => void
  now?: () => Date
  newId?: () => string
  log?: (line: string) => void
  /** Minutes without a privileged operation after which an UNTIL_IDLE session ends. Default 30. */
  idleMinutes?: number
  /**
   * 0.9.1 (review F3): the owner's own confirmation of one operation, asked natively (a dialog no page script can
   * answer). Without anyone to ask the answer is no. Absent: an operation that needs it does not run.
   */
  confirmOwner?: (o: { title: string; message: string; detail: string }) => Promise<boolean>
  /**
   * 0.9.1 (second review, H1): why no session may be prepared now, or null. A mission whose commands run as the owner
   * outside any containment could reach the broker's relay as the owner: no session while one runs.
   */
  blockedBy?: (runId: string | null) => string | null
}

/** Who asks, as NEXUS knows it: never what the agent says of itself. */
export interface PrivilegedRequester {
  projectId: string | null
  runId: string | null
  taskId: string | null
  agentId: string | null
  role: PrivilegedRequesterRole
  missionTitle: string | null
  taskTitle: string | null
  provenance: string
}

const DEFAULT_HOURS: Record<PrivilegeSessionScope, number> = { SINGLE_OPERATION: 1, MISSION: 8, UNTIL_IDLE: 4, OVERNIGHT: 14 }
/** Refused attempts of one task after which its further requests are refused without review (and still recorded). */
const REFUSALS_BEFORE_BLOCK = 8
const OUTPUT_KEPT = 4000
/** How long the owner's confirmation of one operation is waited for. */
const OWNER_ANSWER_MS = 10 * 60_000

export type PrepareResult = { ok: true; status: PrivilegeSessionStatus } | { ok: false; reason: string; status: PrivilegeSessionStatus | null }

export class PrivilegeService {
  private active: { row: PrivilegeSessionRow; broker: BrokerHandle | null } | null = null
  private preparing: Promise<PrepareResult> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly refusals = new Map<string, number>()
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly d: PrivilegeServiceDeps) {
    this.now = d.now ?? (() => new Date())
    this.newId = d.newId ?? randomUUID
  }

  /**
   * At start: a session a previous runtime left open is over; its broker ended with that runtime. An operation that
   * was running then (review F6) is closed as ABORTED: what it changed before it was stopped is not known.
   */
  recover(): void {
    for (const row of this.d.store.unfinished()) {
      this.d.store.saveSession({ ...row, state: 'ENDED', endedAt: this.now().toISOString(), endReason: 'NEXUS stopped; the broker ended with it' })
    }
    for (const r of this.d.store.executing()) {
      this.d.store.record({ ...r, outcome: 'ABORTED', finishedAt: this.now().toISOString(), outcomeReason: 'NEXUS stopped while this operation was running: the broker ended it, and what it had changed by then is not known.' })
    }
  }

  /** The capabilities of the session in progress, or null: what the policy engine checks a request against. */
  sessionCapabilities(): readonly PrivilegedCapability[] | null {
    return this.active?.row.state === 'ACTIVE' && this.active.broker?.alive === true ? this.active.row.capabilities : null
  }

  status(): PrivilegeSessionStatus | null {
    const row = this.active?.row ?? null
    return row ? this.statusOf(row) : null
  }

  statusOf(row: PrivilegeSessionRow): PrivilegeSessionStatus {
    return { ...row, counts: this.d.store.counts(row.id) }
  }

  /** The newest sessions, the one in progress first. */
  history(limit = 10): PrivilegeSessionStatus[] {
    return this.d.store.sessions({ limit }).map((r) => this.statusOf(r))
  }

  receipts(opts: { runId?: string; sessionId?: string; since?: string; limit?: number }): PrivilegedOperationReceipt[] {
    return this.d.store.receipts(opts)
  }

  /** M7: the receipt chain walked over every receipt kept, for the privileged activity report. */
  verifyChain(): ReceiptChainVerification {
    return this.d.store.verifyChain()
  }

  /**
   * Prepares a session: the ONE UAC prompt, now, while the owner is there. Only one session at a time; asking again
   * for the same scope and run gives the one in progress, with no new prompt.
   */
  async prepare(input: { scope: PrivilegeSessionScope; runId: string | null; projectId: string | null; capabilities?: readonly PrivilegedCapability[]; hours?: number }): Promise<PrepareResult> {
    if (this.preparing) return this.preparing
    const current = this.active
    if (current !== null && current.row.state === 'ACTIVE' && current.broker?.alive === true) {
      if (current.row.scope === input.scope && current.row.runId === input.runId) return { ok: true, status: this.statusOf(current.row) }
      return { ok: false, reason: 'Another privilege session is active; end it first.', status: this.statusOf(current.row) }
    }
    if ((input.scope === 'MISSION' || input.scope === 'OVERNIGHT') && input.runId === null) return { ok: false, reason: 'A mission or Overnight session belongs to one run.', status: null }
    const blocked = this.d.blockedBy?.(input.runId) ?? null
    if (blocked !== null) return { ok: false, reason: blocked, status: null }
    this.preparing = this.doPrepare(input).finally(() => {
      this.preparing = null
    })
    return this.preparing
  }

  private async doPrepare(input: { scope: PrivilegeSessionScope; runId: string | null; projectId: string | null; capabilities?: readonly PrivilegedCapability[]; hours?: number }): Promise<PrepareResult> {
    const at = this.now()
    const hours = Math.min(input.hours ?? DEFAULT_HOURS[input.scope], 14)
    const row: PrivilegeSessionRow = {
      id: this.newId(),
      scope: input.scope,
      runId: input.runId,
      projectId: input.projectId,
      state: 'PREPARING',
      capabilities: [...new Set(input.capabilities ?? DEFAULT_SESSION_CAPABILITIES)],
      createdAt: at.toISOString(),
      activeAt: null,
      expiresAt: new Date(at.getTime() + hours * 3600_000).toISOString(),
      endedAt: null,
      endReason: null,
      uacPrompts: 1,
      elevated: false,
    }
    this.active = { row, broker: null }
    this.d.store.saveSession(row)
    this.changed()
    let started: Awaited<ReturnType<PrivilegeServiceDeps['startBroker']>>
    try {
      started = await this.d.startBroker({ session: row.id, expiresAt: new Date(row.expiresAt), capabilities: row.capabilities, onEnded: (reason) => this.brokerEnded(row.id, reason) })
    } catch (e) {
      started = { ok: false, outcome: 'FAILED', reason: e instanceof Error ? e.message.slice(0, 200) : 'the broker could not be started' }
    }
    if (!started.ok) {
      this.finish(row, started.outcome === 'DECLINED' ? 'DECLINED' : 'FAILED', started.reason)
      return { ok: false, reason: started.reason, status: this.statusOf(row) }
    }
    if (this.active?.row.id !== row.id) {
      // Revoked while the prompt was open.
      await started.client.end().catch(() => undefined)
      return { ok: false, reason: 'The session was revoked before it started.', status: this.statusOf(row) }
    }
    // 0.9.1 (second review, L1): a broker that ended as it said hello is not a session.
    if (!started.client.alive) {
      this.finish(row, 'FAILED', 'the broker ended as it started')
      return { ok: false, reason: 'The broker ended as it started.', status: this.statusOf(row) }
    }
    row.state = 'ACTIVE'
    row.activeAt = this.now().toISOString()
    row.elevated = started.client.elevated
    this.active = { row, broker: started.client }
    this.d.store.saveSession(row)
    this.armTimers(row)
    this.d.log?.(`privilege: session ${row.id} active (${row.scope}${row.runId ? `, run ${row.runId}` : ''}) until ${row.expiresAt}`)
    this.changed()
    return { ok: true, status: this.statusOf(row) }
  }

  private armTimers(row: PrivilegeSessionRow): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    const left = new Date(row.expiresAt).getTime() - this.now().getTime()
    this.expiryTimer = setTimeout(() => void this.end('the session reached its time limit', row.id), Math.max(0, Math.min(left, 0x7fffffff)))
    this.expiryTimer.unref?.()
    this.touchIdle(row)
  }

  private touchIdle(row: PrivilegeSessionRow): void {
    if (row.scope !== 'UNTIL_IDLE') return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.end('NEXUS was idle', row.id), (this.d.idleMinutes ?? 30) * 60_000)
    this.idleTimer.unref?.()
  }

  private brokerEnded(sessionId: string, reason: string): void {
    const current = this.active
    if (current === null || current.row.id !== sessionId || current.row.state !== 'ACTIVE') return
    if (!/^ended(: ended)?$/.test(reason)) {
      this.d.securityEvent?.({ severity: /not the next signed|not in the protocol|could not be read|unexpected|nobody asked|wrong size|other capabilities|not elevated/.test(reason) ? 'ISOLATION_FAILURE' : 'NORMAL_AUTONOMOUS_ACTION', runId: current.row.runId, projectId: current.row.projectId, taskId: null, agentId: null, action: 'privilege broker ended', reason: reason.slice(0, 300) })
    }
    this.finish(current.row, 'ENDED', `the broker ended (${reason})`)
  }

  private finish(row: PrivilegeSessionRow, state: 'ENDED' | 'DECLINED' | 'FAILED', reason: string): void {
    row.state = state
    row.endedAt = this.now().toISOString()
    row.endReason = reason.slice(0, 400)
    this.d.store.saveSession(row)
    if (this.active?.row.id === row.id) this.active = null
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.expiryTimer = this.idleTimer = null
    this.d.log?.(`privilege: session ${row.id} ${state.toLowerCase()} (${row.endReason})`)
    this.changed()
  }

  /** Ends the session in progress (or the one named): the broker ends what it started and exits. */
  async end(reason: string, sessionId?: string): Promise<void> {
    const current = this.active
    if (current === null || (sessionId !== undefined && current.row.id !== sessionId)) return
    // Taken off first: nothing new is admitted while the broker ends.
    this.active = null
    const broker = current.broker
    this.finish(current.row, 'ENDED', reason)
    await broker?.end().catch(() => undefined)
    // 0.9.1 (second review, M8): what the broker could not end (an installation, a service) is said when NEXUS ends
    // the session too, not only when the broker ends by itself.
    const left = /may still be running: (.*)\)$/.exec(broker?.endReason ?? '')?.[1]
    if (left !== undefined) {
      this.d.store.saveSession({ ...current.row, endReason: `${current.row.endReason ?? reason}; may still be running: ${left}`.slice(0, 400) })
      this.d.securityEvent?.({ severity: 'NORMAL_AUTONOMOUS_ACTION', runId: current.row.runId, projectId: current.row.projectId, taskId: null, agentId: null, action: 'privilege session ended with work still running', reason: left.slice(0, 300) })
    }
  }

  /** The scope of a mission or Overnight session ended with its run. */
  async endForRun(runId: string, reason: string): Promise<void> {
    const current = this.active
    if (current !== null && current.row.runId === runId && (current.row.scope === 'MISSION' || current.row.scope === 'OVERNIGHT')) await this.end(reason)
  }

  /** 0.9.1 (second review, H1): something now keeps sessions out (an uncontained mission started): the one in progress ends. */
  async recheck(): Promise<void> {
    const current = this.active
    if (current === null || current.row.state !== 'ACTIVE') return
    const blocked = this.d.blockedBy?.(current.row.runId) ?? null
    if (blocked !== null) await this.end(blocked)
  }

  /** NEXUS has no work in progress: an UNTIL_IDLE session ends. */
  async idle(): Promise<void> {
    if (this.active?.row.scope === 'UNTIL_IDLE') await this.end('NEXUS has no work in progress')
  }

  async dispose(): Promise<void> {
    await this.end('NEXUS is stopping')
  }

  /** Submits one privileged operation. Operations run one at a time, in the order they came. */
  submit(proposal: PrivilegedOperationProposal, who: PrivilegedRequester): Promise<PrivilegedOperationReceipt> {
    const run = this.queue.then(() => this.process(proposal, who))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async process(proposal: PrivilegedOperationProposal, who: PrivilegedRequester): Promise<PrivilegedOperationReceipt> {
    const current = this.active
    const session = current?.row.state === 'ACTIVE' ? current.row : null
    const req: PrivilegedOperationRequest = { ...proposal, ...who, id: this.newId(), sessionId: session?.id ?? null, requestedAt: this.now().toISOString() }
    // 0.9.1 (review F12, second review M5): what the request gave as secret (its secret arguments, its environment's
    // values) is removed by value, before the patterns, from everything kept: the output, and the reasons of a refusal.
    const secrets = [...req.secretArgs.map((i) => req.args[i] ?? ''), ...Object.values(req.env)].filter((v) => v.length >= 6).sort((a, b) => b.length - a.length)
    const scrub = (text: string): string => redactText(secrets.reduce((t, secret) => t.split(secret).join('[secret]'), text))
    const scrubbed = (d: PrivilegedPolicyDecision | null | undefined): PrivilegedPolicyDecision | null => (d ? { ...d, reason: scrub(d.reason) } : null)
    const receipt = (outcome: PrivilegedOutcome, outcomeReason: string, extra: Partial<PrivilegedOperationReceipt> & { precheck: PrivilegedPolicyDecision }): PrivilegedOperationReceipt => {
      const r: PrivilegedOperationReceipt = {
        id: req.id,
        sessionId: req.sessionId,
        requestedAt: req.requestedAt,
        finishedAt: this.now().toISOString(),
        projectId: req.projectId,
        runId: req.runId,
        taskId: req.taskId,
        missionTitle: req.missionTitle,
        taskTitle: req.taskTitle,
        role: req.role,
        agentId: req.agentId,
        capability: req.capability,
        goal: redactText(req.goal),
        whyRequired: redactText(req.whyRequired),
        whyElevation: redactText(req.whyElevation),
        whyNoUnelevatedAlternative: redactText(req.whyNoUnelevatedAlternative),
        executable: req.executable,
        args: redactArgs(req.args, req.secretArgs),
        cwd: req.cwd ?? null,
        envNames: Object.keys(req.env),
        expected: req.expected,
        rollback: redactText(req.rollback),
        provenance: req.provenance,
        followsOperationId: req.followsOperationId ?? null,
        reviews: [],
        outcome,
        outcomeReason,
        exitCode: null,
        durationMs: null,
        observed: [],
        stdout: '',
        stderr: '',
        stagedSha256: null,
        ...extra,
        precheck: scrubbed(extra.precheck) as PrivilegedPolicyDecision,
        finalPolicy: scrubbed(extra.finalPolicy),
      }
      r.outcomeReason = scrub(r.outcomeReason)
      this.d.store.record(r)
      if (outcome === 'REJECTED_BY_POLICY' || outcome === 'REJECTED_BY_DIRECTOR') {
        const key = `${req.sessionId ?? 'none'}|${req.taskId ?? req.agentId ?? 'nexus'}`
        this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1)
      }
      this.changed()
      return r
    }

    // A session bound to a run serves that run only.
    let precheck: PrivilegedPolicyDecision
    // 0.9.1 (second review, L6): any session prepared for a run, whatever its scope.
    if (session !== null && session.runId !== null && req.runId !== session.runId) {
      precheck = { verdict: 'DENIED', reason: 'The privilege session in progress belongs to another run.', forbidden: null, councilRequired: false, councilWhy: [] }
    } else if ((this.refusals.get(`${req.sessionId ?? 'none'}|${req.taskId ?? req.agentId ?? 'nexus'}`) ?? 0) >= REFUSALS_BEFORE_BLOCK) {
      precheck = { verdict: 'DENIED', reason: 'This task was refused too many privileged requests; it gets no more reviews in this session.', forbidden: null, councilRequired: false, councilWhy: [] }
    } else {
      precheck = this.d.policy.precheck(req)
    }
    if (precheck.verdict === 'DENIED') {
      if (precheck.forbidden !== null) this.d.securityEvent?.({ severity: precheck.forbidden === 'READ_CREDENTIAL_STORE_ARBITRARILY' || precheck.forbidden === 'EXPORT_USER_SECRETS' ? 'CREDENTIAL_ACCESS_ATTEMPT' : 'ESCAPE_ATTEMPT', runId: req.runId, projectId: req.projectId, taskId: req.taskId, agentId: req.agentId, action: `privileged request: ${precheck.forbidden}`, reason: precheck.reason })
      return receipt('REJECTED_BY_POLICY', precheck.reason, { precheck })
    }
    const reviews: PrivilegedOperationReview[] = await this.d.review.review(req, precheck)
    const final = this.d.policy.final(req, reviews)
    if (final.verdict === 'DENIED') {
      // Refused by the policy again (it changes nothing a review said) or for want of an approval.
      const byPolicy = this.d.policy.precheck(req).verdict === 'DENIED'
      return receipt(byPolicy ? 'REJECTED_BY_POLICY' : 'REJECTED_BY_DIRECTOR', final.reason, { precheck, reviews, finalPolicy: final })
    }
    // 0.9.1 (review F3): a file an agent may have written or fetched runs only once the owner confirmed this very operation.
    if (final.ownerRequired === true) {
      const confirmed = await this.askOwner(req, final, reviews)
      if (!confirmed) return receipt('DECLINED_BY_OWNER', this.d.confirmOwner ? 'You did not confirm this operation (or nobody was there to confirm it): it did not run.' : 'This operation needs your own confirmation and there is no way to ask for it here: it did not run.', { precheck, reviews, finalPolicy: final })
    }
    const broker = this.active?.row.id === session?.id ? this.active?.broker : null
    if (session === null || broker == null || !broker.alive) return receipt('ABORTED', 'The privilege session ended before the operation could run.', { precheck, reviews, finalPolicy: final })
    this.touchIdle(session)
    // 0.9.1 (review F6): on record before it starts, so that a NEXUS stopped while it runs still leaves its trace.
    receipt('EXECUTING', 'Started with administrator rights.', { precheck, reviews, finalPolicy: final })
    // 0.9.1 (second review, L5): what an install, repair or uninstall leaves behind, seen from two unelevated snapshots.
    const collect = this.d.persistence !== undefined && PERSISTENCE_CAPABILITIES.has(req.capability) ? this.d.persistence : null
    const before = collect ? await this.snapshot(collect) : null
    const persisted = async (): Promise<{ report: PersistenceReport; lines: string[] } | null> => {
      if (collect === null || before === null) return null
      const report = diffPersistence(before, await this.snapshot(collect), req.expected)
      if (report.unexpected > 0) {
        const items = report.changes.filter((c) => !c.expected).map((c) => `${c.surface} ${c.id} ${c.change}`)
        this.d.securityEvent?.({ severity: 'ISOLATION_FAILURE', runId: req.runId, projectId: req.projectId, taskId: req.taskId, agentId: req.agentId, action: 'privileged operation left unexpected persistence', reason: scrub(items.join('; ')).slice(0, 300) })
      }
      return { report, lines: persistenceObservedLines(report) }
    }
    const result = await broker.exec({
      opId: req.id,
      capability: req.capability,
      executable: req.executable,
      args: req.args,
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
      env: req.env,
      timeoutMs: req.timeoutMs,
      ...(req.sha256 !== undefined ? { sha256: req.sha256 } : {}),
      inputs: req.inputs,
      files: this.d.companions?.(req) ?? [],
    })
    if (result.kind === 'refused') return receipt('REJECTED_BY_POLICY', `Refused by the broker: ${result.reason}`, { precheck, reviews, finalPolicy: final })
    if (result.kind === 'lost') {
      const lostPersistence = await persisted()
      return receipt('ABORTED', `The broker went away: ${result.reason}`, { precheck, reviews, finalPolicy: final, ...(lostPersistence ? { observed: lostPersistence.lines, persistence: lostPersistence.report } : {}) })
    }
    // Before the first final receipt: the store chains that one and keeps it unchanged after it (store.record).
    const persistence = await persisted()
    const outcome: PrivilegedOutcome = result.timedOut ? 'TIMEOUT' : result.exitCode === 0 ? 'EXECUTED' : 'FAILED'
    const cut = (s: string, truncated: boolean): string => {
      const clean = scrub(s)
      return clean.length > OUTPUT_KEPT || truncated ? `${clean.slice(0, OUTPUT_KEPT)}\n[cut]` : clean
    }
    const ran = (observed: string[]): PrivilegedOperationReceipt =>
      receipt(outcome, outcome === 'EXECUTED' ? 'The program ran and exited with 0.' : outcome === 'TIMEOUT' ? `The program did not finish within ${Math.round(req.timeoutMs / 1000)} s and was ended.` : `The program exited with ${result.exitCode}.`, {
        precheck,
        reviews,
        finalPolicy: final,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        observed: [
          ...observed,
          ...(result.leftoverEnded > 0 ? [`${result.leftoverEnded} process(es) it left running were ended.`] : []),
          ...(result.leftover ? [`Not ended by NEXUS, may still be running: ${result.leftover}`] : []),
          // 0.9.1 (second review, M1): what the program wrote in the result or log file the broker gave it (in its staging).
          ...(result.files ?? []).map((f) => `${f.name}: ${cut(f.text, false).slice(0, 1500)}`),
          ...(persistence?.lines ?? []),
        ],
        stdout: cut(result.stdout, result.stdoutTruncated),
        stderr: cut(result.stderr, result.stderrTruncated),
        stagedSha256: result.stagedSha256,
        ...(persistence ? { persistence: persistence.report } : {}),
      })
    // 0.9.1 (second review, L12): the outcome is on record before the verification, which may itself fail.
    ran([])
    let observed: string[]
    try {
      observed = (await this.d.verify?.(req)) ?? []
    } catch {
      observed = ['The verification after the operation could not be completed.']
    }
    const r = ran(observed)
    if (session.scope === 'SINGLE_OPERATION') await this.end('its single operation ran', session.id)
    return r
  }

  /**
   * One persistence snapshot. One that could not be taken is a snapshot whose every surface FAILED: the diff then
   * infers nothing there, the receipt says so, and the operation proceeds. Whether an incomplete snapshot BEFORE the
   * operation should instead stop it is the open question left to the user.
   */
  private async snapshot(collect: (signal?: AbortSignal) => Promise<PersistenceSnapshot>): Promise<PersistenceSnapshot> {
    try {
      return await collect()
    } catch (e) {
      const note = `the snapshot could not be taken: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`
      const failed = { state: 'FAILED' as const, note }
      return { takenAt: this.now().toISOString(), durationMs: 0, items: [], coverage: { SERVICE: failed, SCHEDULED_TASK: failed, RUN_KEY: failed, STARTUP_FOLDER: failed } }
    }
  }

  /** The owner's confirmation of one operation: what runs, why, what the reviews said. No model's words decide it. */
  private async askOwner(req: PrivilegedOperationRequest, final: PrivilegedPolicyDecision, reviews: readonly PrivilegedOperationReview[]): Promise<boolean> {
    if (this.d.confirmOwner === undefined) return false
    const detail = [
      `Command: ${[req.executable, ...redactArgs(req.args, req.secretArgs)].join(' ')}`,
      `Why your confirmation is asked: ${(final.ownerWhy ?? []).join('; ')}.`,
      `Requested by: ${req.role.toLowerCase()}${req.taskTitle ? `, task "${req.taskTitle}"` : ''}${req.missionTitle ? `, mission "${req.missionTitle}"` : ''}.`,
      `Its stated goal (the agent's words): ${redactText(req.goal)}`,
      `Why administrator rights (the agent's words): ${redactText(req.whyElevation)}`,
      ...reviews.map((r) => `${r.reviewer === 'DIRECTOR_COUNCIL' ? 'Council' : 'Technical Director'}: ${r.failed ? 'no valid review' : `${r.verdict} (risk ${r.risk})`}. ${r.reason}`),
      'It runs with administrator rights. If you did not expect it, choose Do not run.',
    ].join('\n\n')
    // Not answered in time (an Overnight run, the owner away) is a no: the operations behind it wait in the same queue.
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<boolean>((done) => {
      timer = setTimeout(() => done(false), OWNER_ANSWER_MS)
      timer.unref?.()
    })
    try {
      return await Promise.race([this.d.confirmOwner({ title: 'NEXUS: run as administrator?', message: `An agent asks to run ${win32.basename(req.executable)} with administrator rights.`, detail: detail.slice(0, 6000) }), late])
    } catch {
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private changed(): void {
    try {
      this.d.onChange?.(this.status())
    } catch {
      // A listener's failure is not the service's.
    }
  }
}

/** What an agent is told of a receipt: short, and nothing it should not have. */
export function receiptForAgent(r: PrivilegedOperationReceipt): string {
  const lines = [`Privileged operation ${r.id}: ${r.outcome}. ${r.outcomeReason}`]
  if (r.exitCode !== null) lines.push(`Exit code ${r.exitCode} after ${r.durationMs ?? 0} ms.`)
  for (const review of r.reviews) lines.push(`${review.reviewer === 'DIRECTOR_COUNCIL' ? 'Council' : 'Technical Director'}: ${review.verdict} (${review.risk}) ${review.reason}${review.restrictions.length ? ` Restrictions: ${review.restrictions.join('; ')}` : ''}`)
  if (r.observed.length) lines.push(`Observed: ${r.observed.join(' ')}`)
  if (r.stdout) lines.push(`stdout:\n${r.stdout.slice(0, 2000)}`)
  if (r.stderr) lines.push(`stderr:\n${r.stderr.slice(0, 2000)}`)
  if (r.outcome === 'FAILED' || r.outcome === 'TIMEOUT') lines.push(`A repair may be proposed as a new request with followsOperationId "${r.id}"; it is reviewed like any other.`)
  return lines.join('\n')
}
