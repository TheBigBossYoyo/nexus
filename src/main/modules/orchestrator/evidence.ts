import type { Review, Task } from '@shared/domain'
import type { EventType } from '@shared/events'
import type { GraphProposal, GraphRevision } from '@shared/v2'
import { RESULT_BLOCK_CHARS, oneLine, type OrchestrationEvidence } from '@main/modules/context/render'
import type { Repositories } from '@main/modules/persistence'
import type { MessageMeta } from '@main/modules/persistence/repositories/agents'
import { ARBITRATION_ARTIFACT, attachArbitration, effectiveFindings } from './arbitration'

/**
 * The canonical TaskEvidenceBuilder: the ONLY place that assembles orchestration evidence for the
 * reviewer, verifier, repair (debugger) and mission-verifier prompts. Reviewers and verifiers see only
 * the repository, so everything NEXUS knows about a task that the repository cannot show is read here
 * from durable state and handed over as records.
 *
 * Authority: ids, senders, recipients, types, states, exit codes and times are NEXUS facts. Every text an
 * agent wrote (subjects, titles, summaries, commit messages, reasons) is flattened to one bounded line
 * and rendered as quoted, agent-written text by `renderOrchestrationEvidence`; longer agent text (the
 * reported result, message body excerpts) is rendered as a `> `-prefixed block. Nothing agent-written is
 * presented as proof. Every list is capped here, once, and reports how many items were left out; the
 * renderer prints exactly what the builder selected.
 *
 * Reads are bounded: message headers without bodies, artifact headers without content, one recipient
 * query per run, check runs / context packs / commits limited and counted in SQL.
 */

/** Longest list of message records for the mission verifier (whole run). */
export const MESSAGE_CAP = 60
/** Longest list of message records per direction for one task: it rarely has more than a few dozen. */
export const TASK_MESSAGE_CAP = 80
/** Cap for every other list. */
export const LIST_CAP = 15
const FILE_CAP = 30
const REVIEW_CAP = 6
const CHECK_CAP = 2
/** Characters of a sent message's body shown, and the total for all of them. */
const BODY_EXCERPT = 600
const BODY_TOTAL = 6_000
/** Mission scope: one result per top-level task, within a total budget. */
const MISSION_RESULT_EACH = 1_500
const MISSION_RESULT_TOTAL = 12_000

/** What the caller already has and the builder should not recompute (e.g. no extra git calls). */
export interface EvidenceInput {
  /** The task's diff against its base (from the caller's already computed DiffResult). */
  changedFiles?: readonly { status: string; path: string; additions: number; deletions: number }[]
  /** Commits of the task when the caller knows them; otherwise read from git.commit.created / git.merged events. */
  commits?: readonly { commit: string; branch: string; message: string; at?: string; kind?: 'created' | 'merged' }[]
}

type CommitRecord = { commit: string; branch: string; message: string; at: string; kind: 'created' | 'merged' }
type Omitted = NonNullable<OrchestrationEvidence['omitted']>

/** Newest first, bounded, with the number of items left out. */
function cap<T>(items: readonly T[], max: number, newestFirstKey?: (t: T) => string): { shown: T[]; omitted: number } {
  const ordered = newestFirstKey ? [...items].sort((a, b) => newestFirstKey(b).localeCompare(newestFirstKey(a))) : [...items]
  return { shown: ordered.slice(0, max), omitted: Math.max(0, ordered.length - max) }
}

const SEVERITY_RANK = ['critical', 'high', 'medium', 'low', 'info']
function bySeverity(findings: readonly { severity: string }[]): { severity: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1)
  const rank = (s: string): number => (SEVERITY_RANK.indexOf(s) === -1 ? SEVERITY_RANK.length : SEVERITY_RANK.indexOf(s))
  return [...counts].sort((a, b) => rank(a[0]) - rank(b[0])).map(([severity, count]) => ({ severity, count }))
}

export class TaskEvidenceBuilder {
  constructor(private readonly repos: Repositories) {}

  /** `task === null` means the whole run (the mission verifier). */
  build(runId: string, taskArg: Task | null, input: EvidenceInput = {}): OrchestrationEvidence {
    const { repos } = this
    // The caller's copy may predate the result being stored; the row is the truth.
    const task = taskArg ? (repos.tasks.get(taskArg.id) ?? taskArg) : null
    const allTasks = repos.tasks.listByRun(runId)
    const keyOf = new Map(allTasks.map((t) => [t.id, t.key]))
    const children = task ? repos.tasks.listByParent(task.id) : allTasks.filter((t) => t.kind === 'repair')
    const taskIds = task ? new Set([task.id, ...children.map((t) => t.id)]) : null
    const scope: string[] = taskIds ? [...taskIds] : []
    const scopeOrNull = taskIds ? scope : null
    const agentIds = new Set(
      repos.agents
        .listByRun(runId)
        .filter((a) => taskIds === null || (a.taskId !== null && taskIds.has(a.taskId)))
        .map((a) => a.id),
    )
    const mine = (taskId: string | null, agentId: string | null): boolean =>
      taskIds === null ? true : (taskId !== null && taskIds.has(taskId)) || (agentId !== null && agentIds.has(agentId))
    const omitted: Omitted = {}
    const note = <K extends keyof Omitted>(key: K, n: number): void => {
      if (n > 0) omitted[key] = n
    }

    const recipients = repos.messages.recipientsByRun(runId)
    const agentMessages = repos.messages.listMetaByRun(runId).filter((m) => m.type !== 'review_finding' && m.type !== 'user_instruction')
    const messages = this.messages(agentMessages, taskIds, mine, recipients, task !== null)

    const decisions = cap(
      repos.decisions.listByRun(runId).filter((d) => mine(d.taskId, d.agentId)),
      LIST_CAP * 2,
      (d) => d.createdAt,
    )
    note('decisions', decisions.omitted)
    const proposalRows = repos.graphProposals.listByRun(runId)
    const proposals = cap(
      proposalRows.filter((p) => mine(p.taskId, p.proposedByAgentId)),
      LIST_CAP * 2,
      (p) => p.createdAt,
    )
    note('proposals', proposals.omitted)

    const artifacts = repos.artifacts.listMeta(runId, scopeOrNull, ARBITRATION_ARTIFACT, LIST_CAP)
    note('artifacts', artifacts.total - artifacts.items.length)

    const files = cap(input.changedFiles ?? [], FILE_CAP)
    note('changedFiles', files.omitted)

    const commits = this.commits(runId, scopeOrNull, input)
    note('commits', commits.omitted)

    const checks = repos.verifications.latestChecks(runId, scopeOrNull, CHECK_CAP)
    note('checks', checks.total - checks.items.length)

    const handoffs = task ? this.handoffs(task, agentMessages, taskIds!, recipients) : { shown: [], omitted: 0 }
    note('handoffs', handoffs.omitted)

    const reviews = this.reviews(runId, task ? scope : null)
    note('reviews', reviews.omitted)

    const repairs = cap(children, LIST_CAP, (t) => t.createdAt)
    note('repairs', repairs.omitted)
    const repairCycles = task ? task.repairCycles : allTasks.reduce((n, t) => n + t.repairCycles, 0)

    const revisions = cap(this.revisions(runId, taskIds, keyOf, proposalRows), LIST_CAP, (r) => r.at)
    note('revisions', revisions.omitted)

    const packs = repos.contextPacks.listMeta(runId, scopeOrNull, LIST_CAP)
    note('contextPacks', packs.total - packs.items.length)

    const results = task ? this.taskResult(task, children) : this.missionResults(allTasks)

    return {
      ...messages,
      scope: task ? 'task' : 'run',
      results: results.shown,
      ...(results.omitted > 0 ? { omittedResults: results.omitted } : {}),
      decisions: decisions.shown.map((d) => ({
        id: d.id,
        title: oneLine(d.title),
        at: d.createdAt,
        text: [d.decision, d.rationale ? `Rationale: ${d.rationale}` : ''].filter((part) => part.trim() !== '').join('\n'),
      })),
      proposals: proposals.shown.map((p) => ({
        id: p.id,
        type: p.type,
        status: p.status,
        title: oneLine(p.changes.tasks.length > 0 ? p.changes.tasks.map((t) => t.title).join('; ') : (p.changes.targetTask ?? '(none)')),
        at: p.createdAt,
      })),
      artifacts: artifacts.items.map((a) => ({ id: a.id, kind: oneLine(a.kind, 40), title: oneLine(a.title), task: a.taskId ? (keyOf.get(a.taskId) ?? '?') : '(run)' })),
      changedFiles: files.shown.map((f) => ({ status: f.status, path: f.path, additions: f.additions, deletions: f.deletions })),
      commits: commits.shown.map((c) => ({ commit: c.commit, branch: c.branch, message: oneLine(c.message), at: c.at, kind: c.kind })),
      checks: checks.items.map((v) => ({
        id: v.id,
        attempt: v.attempt,
        passed: v.passed,
        at: v.createdAt,
        commands: v.commands.slice(0, 8).map((c) => ({ name: c.name, command: c.command, exitCode: c.exitCode, timedOut: c.timedOut })),
      })),
      handoffs: handoffs.shown,
      reviews: reviews.shown,
      repairs: repairs.shown.map((t) => ({ key: t.key, state: t.state, trigger: oneLine(t.title, 120), at: t.createdAt })),
      repairCycles,
      revisions: revisions.shown,
      contextPacks: packs.items.map((p) => ({ id: p.id, purpose: p.purpose, at: p.createdAt })),
      omitted,
    }
  }

  /**
   * What the implementing agent reported. The latest repair child that reported a result wins (the parent's
   * summary predates the repair); otherwise the task's own summary, otherwise the final text of its latest agent.
   */
  private taskResult(task: Task, children: readonly Task[]): { shown: NonNullable<OrchestrationEvidence['results']>; omitted: number } {
    const { repos } = this
    const latestChild = [...children].filter((c) => c.resultSummary).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    let source: { key: string; text: string } | null = latestChild
      ? { key: latestChild.key, text: latestChild.resultSummary ?? '' }
      : task.resultSummary
        ? { key: task.key, text: task.resultSummary }
        : null
    if (!source) {
      const agents = [...repos.agents.listByTask(task.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      for (const a of agents) {
        const text = repos.outputs.lastText(a.id)
        if (text) {
          source = { key: task.key, text }
          break
        }
      }
    }
    if (!source || !source.text.trim()) return { shown: [], omitted: 0 }
    const kept = source.text.slice(0, RESULT_BLOCK_CHARS * 2)
    return { shown: [{ task: source.key, text: kept, omittedChars: source.text.length - kept.length }], omitted: 0 }
  }

  /** Mission scope: the reported result of each top-level task, one bounded block each, within a total budget. */
  private missionResults(allTasks: readonly Task[]): { shown: NonNullable<OrchestrationEvidence['results']>; omitted: number } {
    const shown: NonNullable<OrchestrationEvidence['results']> = []
    let used = 0
    let omitted = 0
    for (const t of allTasks) {
      if (t.parentTaskId !== null || t.kind === 'repair' || !t.resultSummary?.trim()) continue
      const text = t.resultSummary.slice(0, MISSION_RESULT_EACH * 2)
      const cost = Math.min(text.length, MISSION_RESULT_EACH)
      if (used + cost > MISSION_RESULT_TOTAL) {
        omitted++
        continue
      }
      used += cost
      shown.push({ task: t.key, text, omittedChars: t.resultSummary.length - text.length })
    }
    return { shown, omitted }
  }

  /** Messages sent by the task's agents and messages routed to them (directly, by role, or to repair children). */
  private messages(
    agentMessages: readonly MessageMeta[],
    taskIds: ReadonlySet<string> | null,
    mine: (taskId: string | null, agentId: string | null) => boolean,
    recipients: ReadonlyMap<string, string[]>,
    withBodies: boolean,
  ): Pick<OrchestrationEvidence, 'messages' | 'omittedMessages' | 'omittedReceived'> {
    const record = (m: MessageMeta, direction: 'sent' | 'received'): OrchestrationEvidence['messages'][number] => ({
      id: m.id,
      direction,
      type: m.type,
      from: m.fromLabel,
      to: m.toLabel,
      subject: m.subject,
      at: m.createdAt,
    })
    const newestFirst = (a: { at: string }, b: { at: string }): number => b.at.localeCompare(a.at)
    if (taskIds === null) {
      const all = agentMessages.map((m) => record(m, 'sent')).sort(newestFirst)
      return { messages: all.slice(0, MESSAGE_CAP), omittedMessages: Math.max(0, all.length - MESSAGE_CAP) }
    }
    const sent = agentMessages.filter((m) => mine(m.fromTaskId, m.fromAgentId)).map((m) => record(m, 'sent')).sort(newestFirst)
    const received = agentMessages
      .filter((m) => !mine(m.fromTaskId, m.fromAgentId))
      .filter((m) => this.isRecipient(m, taskIds, recipients))
      .map((m) => record(m, 'received'))
      .sort(newestFirst)
    const shownSent = sent.slice(0, TASK_MESSAGE_CAP)
    if (withBodies) {
      // A criterion may be about what was communicated: a bounded excerpt of each sent body, newest first, within a total budget.
      const excerpts = this.repos.messages.excerpts(shownSent.map((m) => m.id), BODY_EXCERPT)
      let used = 0
      for (const m of shownSent) {
        const body = excerpts.get(m.id)?.trim()
        if (!body || used + body.length > BODY_TOTAL) continue
        used += body.length
        m.body = body
      }
    }
    return {
      messages: [...shownSent, ...received.slice(0, TASK_MESSAGE_CAP)],
      omittedMessages: Math.max(0, sent.length - TASK_MESSAGE_CAP),
      omittedReceived: Math.max(0, received.length - TASK_MESSAGE_CAP),
    }
  }

  private isRecipient(m: MessageMeta, taskIds: ReadonlySet<string>, recipients: ReadonlyMap<string, string[]>): boolean {
    return (m.toTaskId !== null && taskIds.has(m.toTaskId)) || (recipients.get(m.id) ?? []).some((id) => taskIds.has(id))
  }

  /** Newest commits and merges (caller-supplied, or the newest events in SQL), with the true number left out. */
  private commits(runId: string, scope: readonly string[] | null, input: EvidenceInput): { shown: CommitRecord[]; omitted: number } {
    if (input.commits) {
      const supplied: CommitRecord[] = input.commits.map((c) => ({ ...c, at: c.at ?? '', kind: c.kind ?? 'created' }))
      return cap(supplied, LIST_CAP, (c) => c.at)
    }
    const types: EventType[] = ['git.commit.created', 'git.merged']
    const taskIds = scope ?? undefined
    const events = this.repos.events.listByTypes(runId, types, LIST_CAP, taskIds)
    const total = this.repos.events.countByTypes(runId, types, taskIds)
    const shown = events.map((e): CommitRecord =>
      e.type === 'git.commit.created'
        ? { ...(e.payload as { commit: string; branch: string; message: string }), at: e.createdAt, kind: 'created' }
        : {
            commit: (e.payload as { commit: string }).commit,
            branch: (e.payload as { branch: string }).branch,
            message: `merged into ${(e.payload as { into: string }).into}`,
            at: e.createdAt,
            kind: 'merged',
          },
    )
    return { shown, omitted: Math.max(0, total - shown.length) }
  }

  /** Result summaries of the tasks this one depends on, and the handoff-type messages addressed to it. */
  private handoffs(
    task: Task,
    agentMessages: readonly MessageMeta[],
    taskIds: ReadonlySet<string>,
    recipients: ReadonlyMap<string, string[]>,
  ): { shown: NonNullable<OrchestrationEvidence['handoffs']>; omitted: number } {
    const { repos } = this
    const deps = repos.dependencies.listForTask(task.id).map((d) => repos.tasks.get(d.dependsOnTaskId)).filter((t): t is Task => t !== null)
    const results = deps
      .filter((d) => d.resultSummary)
      .map((d) => ({ kind: 'dependency_result' as const, id: d.id, from: d.key, text: oneLine(d.resultSummary ?? '', 240) }))
    const depIds = new Set(deps.map((d) => d.id))
    const messages = agentMessages
      .filter((m) => m.type === 'handoff' && (m.fromTaskId === null || !taskIds.has(m.fromTaskId)))
      .filter((m) => (m.fromTaskId !== null && depIds.has(m.fromTaskId)) || this.isRecipient(m, taskIds, recipients))
      .map((m) => ({ kind: 'handoff_message' as const, id: m.id, from: m.fromLabel, text: oneLine(m.subject) }))
    const all = [...results, ...messages]
    return { shown: all.slice(0, LIST_CAP), omitted: Math.max(0, all.length - LIST_CAP) }
  }

  /**
   * Reviews as counts only. The arbiter's row carries what stands (accepted findings by severity) and what
   * was rejected; a raw reviewer row of an attempt an arbiter settled is marked, not described.
   * The reviews table has no arbitration column, so the arbiter output is read from its artifact.
   */
  private reviews(runId: string, scope: readonly string[] | null): { shown: NonNullable<OrchestrationEvidence['reviews']>; omitted: number } {
    const { repos } = this
    const rows: Review[] = attachArbitration(
      scope ? repos.reviews.listByTasks(scope) : repos.reviews.listByRun(runId),
      repos.artifacts.listByRunKind(runId, ARBITRATION_ARTIFACT),
    )
    const settled = new Set(rows.filter((r) => r.arbitration).map((r) => `${r.taskId}:${r.attempt}`))
    const page = cap(rows, REVIEW_CAP, (r) => r.createdAt)
    return {
      omitted: page.omitted,
      shown: page.shown.map((r) => {
        const standing = r.arbitration ? effectiveFindings(r) : []
        return {
          id: r.id,
          attempt: r.attempt,
          verdict: r.verdict,
          at: r.createdAt,
          raised: bySeverity(r.findings),
          raisedTotal: r.findings.length,
          arbitration: r.arbitration
            ? { standing: bySeverity(standing), standingTotal: standing.length, rejected: Math.max(0, r.findings.length - standing.length) }
            : null,
          arbitrated: !r.arbitration && settled.has(`${r.taskId}:${r.attempt}`),
        }
      }),
    }
  }

  /**
   * Revisions (after the approved plan) that added or changed the task or its repair children, or whose
   * proposal referenced them. Snapshots are not parsed unless SQL shows the revision mentions the task.
   */
  private revisions(
    runId: string,
    taskIds: ReadonlySet<string> | null,
    keyOf: ReadonlyMap<string, string>,
    proposalRows: readonly GraphProposal[],
  ): NonNullable<OrchestrationEvidence['revisions']> {
    const { repos } = this
    const meta = repos.graphRevisions.listMetaByRun(runId)
    if (meta.length < 2) return []
    const reasonOf = (r: { id: string; version: number; reason: string; createdAt: string }, relation: 'added' | 'changed' | 'referenced') => ({
      id: r.id,
      version: r.version,
      reason: oneLine(r.reason),
      at: r.createdAt,
      relation,
    })
    if (taskIds === null) return meta.filter((r) => r.version > 1).map((r) => reasonOf(r, 'changed'))
    const proposals = new Map<string, GraphProposal>(proposalRows.map((p) => [p.id, p]))
    const keys = new Set([...taskIds].map((id) => keyOf.get(id)).filter((k): k is string => k !== undefined))
    const mentioning = repos.graphRevisions.versionsMentioning(runId, [...taskIds])
    const snapshots = new Map<number, GraphRevision | null>()
    const snapshot = (version: number): GraphRevision | null => {
      if (!snapshots.has(version)) snapshots.set(version, repos.graphRevisions.getByVersion(runId, version))
      return snapshots.get(version) ?? null
    }
    const out: NonNullable<OrchestrationEvidence['revisions']> = []
    for (const rev of meta) {
      if (rev.version <= 1) continue
      const proposal = proposals.get(rev.proposalId ?? '')
      let relation: 'added' | 'changed' | 'referenced' | null = null
      if (mentioning.has(rev.version)) {
        const cur = snapshot(rev.version)
        const prev = snapshot(rev.version - 1)
        if (cur && prev) relation = this.snapshotRelation(cur, prev, taskIds)
      }
      if (!relation && proposal && this.references(proposal, taskIds, keys)) relation = 'referenced'
      if (relation) out.push(reasonOf(rev, relation))
    }
    return out
  }

  private snapshotRelation(rev: GraphRevision, prev: GraphRevision, taskIds: ReadonlySet<string>): 'added' | 'changed' | null {
    const before = new Map(prev.snapshot.tasks.map((t) => [t.id, t]))
    let changed = false
    for (const t of rev.snapshot.tasks) {
      if (!taskIds.has(t.id)) continue
      const old = before.get(t.id)
      if (!old) return 'added'
      if (old.priority !== t.priority || old.title !== t.title || old.role !== t.role || old.parentTaskId !== t.parentTaskId) changed = true
    }
    const deps = (r: GraphRevision): string =>
      r.snapshot.dependencies.filter((d) => taskIds.has(d.taskId)).map((d) => `${d.taskId}>${d.dependsOnTaskId}`).sort().join(',')
    return changed || deps(rev) !== deps(prev) ? 'changed' : null
  }

  private references(proposal: GraphProposal, taskIds: ReadonlySet<string>, keys: ReadonlySet<string>): boolean {
    const c = proposal.changes
    const named = [c.targetTask, c.dependsOn, ...c.tasks.flatMap((t) => [t.key, ...t.dependencies])]
    return named.some((k) => k !== null && keys.has(k)) || (proposal.taskId !== null && taskIds.has(proposal.taskId))
  }
}

/** Convenience for call sites: one builder per call, no state. */
export function buildTaskEvidence(repos: Repositories, runId: string, task: Task | null, input: EvidenceInput = {}): OrchestrationEvidence {
  return new TaskEvidenceBuilder(repos).build(runId, task, input)
}
