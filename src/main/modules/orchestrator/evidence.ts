import type { Message, Task } from '@shared/domain'
import type { EventType } from '@shared/events'
import type { GraphProposal, GraphRevision } from '@shared/v2'
import { oneLine, type OrchestrationEvidence } from '@main/modules/context/render'
import type { Repositories } from '@main/modules/persistence'
import { ARBITRATION_ARTIFACT, attachArbitration } from './arbitration'

/**
 * The canonical TaskEvidenceBuilder: the ONLY place that assembles orchestration evidence for the
 * reviewer, verifier, repair (debugger) and mission-verifier prompts. Reviewers and verifiers see only
 * the repository, so everything NEXUS knows about a task that the repository cannot show is read here
 * from durable state and handed over as records.
 *
 * Authority: ids, senders, recipients, types, states, exit codes and times are NEXUS facts. Every text an
 * agent wrote (subjects, titles, summaries, commit messages, reasons) is flattened to one bounded line
 * here and rendered as quoted, agent-written text by `renderOrchestrationEvidence`; it is never presented
 * as proof. Every list is capped and reports how many items were left out.
 */

/** Longest list of message records per direction. */
export const MESSAGE_CAP = 60
/** Cap for every other list. */
export const LIST_CAP = 15
const FILE_CAP = 30
const FINDING_CAP = 6

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

export class TaskEvidenceBuilder {
  constructor(private readonly repos: Repositories) {}

  /** `task === null` means the whole run (the mission verifier). */
  build(runId: string, task: Task | null, input: EvidenceInput = {}): OrchestrationEvidence {
    const { repos } = this
    const allTasks = repos.tasks.listByRun(runId)
    const keyOf = new Map(allTasks.map((t) => [t.id, t.key]))
    const children = task ? repos.tasks.listByParent(task.id) : allTasks.filter((t) => t.kind === 'repair')
    const taskIds = task ? new Set([task.id, ...children.map((t) => t.id)]) : null
    const scope: string[] = taskIds ? [...taskIds] : []
    const agentIds = new Set(
      repos.agents
        .listByRun(runId)
        .filter((a) => taskIds === null || (a.taskId !== null && taskIds.has(a.taskId)))
        .map((a) => a.id),
    )
    const mine = (taskId: string | null, agentId: string | null): boolean =>
      taskIds === null ? true : (taskId !== null && taskIds.has(taskId)) || (agentId !== null && agentIds.has(agentId))
    const inScope = (taskId: string | null): boolean => (taskIds === null ? true : taskId !== null && taskIds.has(taskId))
    const omitted: Omitted = {}
    const note = <K extends keyof Omitted>(key: K, n: number): void => {
      if (n > 0) omitted[key] = n
    }

    const agentMessages = repos.messages.listByRun(runId).filter((m) => m.type !== 'review_finding' && m.type !== 'user_instruction')
    const messages = this.messages(agentMessages, taskIds, mine)

    const decisions = cap(
      repos.decisions.listByRun(runId).filter((d) => mine(d.taskId, d.agentId)),
      LIST_CAP * 2,
      (d) => d.createdAt,
    )
    note('decisions', decisions.omitted)
    const proposals = cap(
      repos.graphProposals.listByRun(runId).filter((p) => mine(p.taskId, p.proposedByAgentId)),
      LIST_CAP * 2,
      (p) => p.createdAt,
    )
    note('proposals', proposals.omitted)

    const runArtifacts = repos.artifacts.listByRun(runId)
    const artifacts = cap(
      runArtifacts.filter((a) => a.kind !== ARBITRATION_ARTIFACT && inScope(a.taskId)),
      LIST_CAP,
      (a) => a.createdAt,
    )
    note('artifacts', artifacts.omitted)

    const files = cap(input.changedFiles ?? [], FILE_CAP)
    note('changedFiles', files.omitted)

    const supplied: CommitRecord[] | undefined = input.commits?.map((c) => ({ ...c, at: c.at ?? '', kind: c.kind ?? 'created' }))
    const commits = cap(supplied ?? this.commits(runId, scope, task === null), LIST_CAP, (c) => c.at)
    note('commits', commits.omitted)

    const checkRows = (task ? scope.flatMap((id) => repos.verifications.listByTask(id)) : repos.verifications.listByRun(runId)).filter((v) => v.kind === 'checks')
    // The latest run is the one that matters; older attempts are history the repair prompt already carries.
    const checks = cap(checkRows, 2, (v) => v.createdAt)
    note('checks', checks.omitted)

    const handoffs = task ? this.handoffs(task, agentMessages, taskIds!) : { shown: [], omitted: 0 }
    note('handoffs', handoffs.omitted)

    // The reviews table has no arbitration column: the arbiter output is stored as an artifact and attached here.
    const reviewRows = attachArbitration(task ? scope.flatMap((id) => repos.reviews.listByTask(id)) : repos.reviews.listByRun(runId), runArtifacts)
    const reviews = cap(reviewRows, 6, (r) => r.createdAt)
    note('reviews', reviews.omitted)

    const repairs = cap(children, LIST_CAP, (t) => t.createdAt)
    note('repairs', repairs.omitted)
    const repairCycles = task ? task.repairCycles : allTasks.reduce((n, t) => n + t.repairCycles, 0)

    const revisions = cap(this.revisions(runId, taskIds, keyOf), LIST_CAP, (r) => r.at)
    note('revisions', revisions.omitted)

    const packs = cap(
      task ? scope.flatMap((id) => repos.contextPacks.listByTask(id)) : repos.contextPacks.listByRun(runId),
      LIST_CAP,
      (p) => p.createdAt,
    )
    note('contextPacks', packs.omitted)

    return {
      ...messages,
      decisions: decisions.shown.map((d) => ({ id: d.id, title: oneLine(d.title), at: d.createdAt })),
      proposals: proposals.shown.map((p) => ({
        id: p.id,
        type: p.type,
        status: p.status,
        title: oneLine(p.changes.tasks.length > 0 ? p.changes.tasks.map((t) => t.title).join('; ') : (p.changes.targetTask ?? '(none)')),
        at: p.createdAt,
      })),
      artifacts: artifacts.shown.map((a) => ({ id: a.id, kind: oneLine(a.kind, 40), title: oneLine(a.title), task: a.taskId ? (keyOf.get(a.taskId) ?? '?') : '(run)' })),
      changedFiles: files.shown.map((f) => ({ status: f.status, path: f.path, additions: f.additions, deletions: f.deletions })),
      commits: commits.shown.map((c) => ({ commit: c.commit, branch: c.branch, message: oneLine(c.message), at: c.at, kind: c.kind })),
      checks: checks.shown.map((v) => ({
        id: v.id,
        attempt: v.attempt,
        passed: v.passed,
        at: v.createdAt,
        commands: v.commands.slice(0, 8).map((c) => ({ name: c.name, command: c.command, exitCode: c.exitCode, timedOut: c.timedOut })),
      })),
      handoffs: handoffs.shown,
      reviews: reviews.shown.map((r) => {
        const decided = r.arbitration?.decisions ?? []
        return {
          id: r.id,
          attempt: r.attempt,
          verdict: r.verdict,
          at: r.createdAt,
          findings: r.findings.slice(0, FINDING_CAP).map((f) => ({ severity: f.severity, title: oneLine(f.title, 80) })),
          omittedFindings: Math.max(0, r.findings.length - FINDING_CAP),
          arbitration: r.arbitration ? { accepted: decided.filter((d) => d.accepted).length, rejected: decided.filter((d) => !d.accepted).length } : null,
        }
      }),
      repairs: repairs.shown.map((t) => ({ key: t.key, state: t.state, trigger: oneLine(t.title, 120), at: t.createdAt })),
      repairCycles,
      revisions: revisions.shown,
      contextPacks: packs.shown.map((p) => ({ id: p.id, purpose: p.purpose, at: p.createdAt })),
      omitted,
    }
  }

  /** Messages sent by the task's agents and messages routed to them (directly, by role, or to repair children). */
  private messages(
    agentMessages: readonly Message[],
    taskIds: ReadonlySet<string> | null,
    mine: (taskId: string | null, agentId: string | null) => boolean,
  ): Pick<OrchestrationEvidence, 'messages' | 'omittedMessages' | 'omittedReceived'> {
    const record = (m: Message, direction: 'sent' | 'received'): OrchestrationEvidence['messages'][number] => ({
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
      .filter((m) => this.isRecipient(m, taskIds))
      .map((m) => record(m, 'received'))
      .sort(newestFirst)
    return {
      messages: [...sent.slice(0, MESSAGE_CAP), ...received.slice(0, MESSAGE_CAP)],
      omittedMessages: Math.max(0, sent.length - MESSAGE_CAP),
      omittedReceived: Math.max(0, received.length - MESSAGE_CAP),
    }
  }

  private isRecipient(m: Message, taskIds: ReadonlySet<string>): boolean {
    return (m.toTaskId !== null && taskIds.has(m.toTaskId)) || this.repos.messages.listRecipients(m.id).some((r) => taskIds.has(r.taskId))
  }

  private commits(runId: string, scope: readonly string[], whole: boolean): CommitRecord[] {
    const types: EventType[] = ['git.commit.created', 'git.merged']
    const events = this.repos.events.listByTypes(runId, types, 200, whole ? undefined : scope)
    return events.flatMap((e): CommitRecord[] =>
      e.type === 'git.commit.created'
        ? [{ ...(e.payload as { commit: string; branch: string; message: string }), at: e.createdAt, kind: 'created' as const } satisfies CommitRecord]
        : [{ commit: (e.payload as { commit: string }).commit, branch: (e.payload as { branch: string }).branch, message: `merged into ${(e.payload as { into: string }).into}`, at: e.createdAt, kind: 'merged' as const }],
    )
  }

  /** Result summaries of the tasks this one depends on, and the handoff-type messages addressed to it. */
  private handoffs(
    task: Task,
    agentMessages: readonly Message[],
    taskIds: ReadonlySet<string>,
  ): { shown: NonNullable<OrchestrationEvidence['handoffs']>; omitted: number } {
    const { repos } = this
    const deps = repos.dependencies.listForTask(task.id).map((d) => repos.tasks.get(d.dependsOnTaskId)).filter((t): t is Task => t !== null)
    const results = deps
      .filter((d) => d.resultSummary)
      .map((d) => ({ kind: 'dependency_result' as const, id: d.id, from: d.key, text: oneLine(d.resultSummary ?? '', 240) }))
    const depIds = new Set(deps.map((d) => d.id))
    const messages = agentMessages
      .filter((m) => m.type === 'handoff' && (m.fromTaskId === null || !taskIds.has(m.fromTaskId)))
      .filter((m) => (m.fromTaskId !== null && depIds.has(m.fromTaskId)) || this.isRecipient(m, taskIds))
      .map((m) => ({ kind: 'handoff_message' as const, id: m.id, from: m.fromLabel, text: oneLine(m.subject) }))
    const all = [...results, ...messages]
    return { shown: all.slice(0, LIST_CAP), omitted: Math.max(0, all.length - LIST_CAP) }
  }

  /** Revisions (after the approved plan) that added or changed the task or its repair children, or whose proposal referenced them. */
  private revisions(
    runId: string,
    taskIds: ReadonlySet<string> | null,
    keyOf: ReadonlyMap<string, string>,
  ): NonNullable<OrchestrationEvidence['revisions']> {
    const { repos } = this
    const ordered = [...repos.graphRevisions.listByRun(runId)].sort((a, b) => a.version - b.version)
    if (ordered.length < 2) return []
    const proposals = new Map<string, GraphProposal>(repos.graphProposals.listByRun(runId).map((p) => [p.id, p]))
    const keys = taskIds ? new Set([...taskIds].map((id) => keyOf.get(id)).filter((k): k is string => k !== undefined)) : null
    const out: NonNullable<OrchestrationEvidence['revisions']> = []
    for (let i = 1; i < ordered.length; i++) {
      const rev = ordered[i]!
      const relation = this.relation(rev, ordered[i - 1]!, proposals.get(rev.proposalId ?? ''), taskIds, keys)
      if (relation) out.push({ id: rev.id, version: rev.version, reason: oneLine(rev.reason), at: rev.createdAt, relation })
    }
    return out
  }

  private relation(
    rev: GraphRevision,
    prev: GraphRevision,
    proposal: GraphProposal | undefined,
    taskIds: ReadonlySet<string> | null,
    keys: ReadonlySet<string> | null,
  ): 'added' | 'changed' | 'referenced' | null {
    if (taskIds === null) return 'changed'
    const before = new Map(prev.snapshot.tasks.map((t) => [t.id, t]))
    let changed = false
    for (const t of rev.snapshot.tasks) {
      if (!taskIds.has(t.id)) continue
      const old = before.get(t.id)
      if (!old) return 'added'
      if (old.priority !== t.priority || old.title !== t.title || old.role !== t.role || old.parentTaskId !== t.parentTaskId) changed = true
    }
    const deps = (r: GraphRevision): string => r.snapshot.dependencies.filter((d) => taskIds.has(d.taskId)).map((d) => `${d.taskId}>${d.dependsOnTaskId}`).sort().join(',')
    if (changed || deps(rev) !== deps(prev)) return 'changed'
    const c = proposal?.changes
    if (c && keys && ([c.targetTask, c.dependsOn, ...c.tasks.flatMap((t) => [t.key, ...t.dependencies])].some((k) => k !== null && keys.has(k)) || (proposal?.taskId !== null && taskIds.has(proposal?.taskId ?? '')))) {
      return 'referenced'
    }
    return null
  }
}

/** Convenience for call sites: one builder per call, no state. */
export function buildTaskEvidence(repos: Repositories, runId: string, task: Task | null, input: EvidenceInput = {}): OrchestrationEvidence {
  return new TaskEvidenceBuilder(repos).build(runId, task, input)
}
