import {
  TERMINAL_RUN_STATES,
  WRITING_ROLES,
  type ApprovalRequest,
  type Run,
  type RunState,
  type Task,
} from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { errorMessage } from '@shared/result'
import {
  GraphChangesSchema,
  GraphProposalInputSchema,
  ProposalTypeSchema,
  type GraphProposal,
  type GraphRevision,
} from '@shared/v2'
import {
  snapshotGraph,
  validateProposal,
  type GraphOperation,
  type ProposalValidation,
} from '@main/modules/task-graph'
import type { ApprovalService } from './approvals'
import type { Core } from './core'
import type { OrchestratorDeps } from './deps'
import { kindFor } from './task-kind'

/** At most this many proposals per agent; the rest are rejected. */
export const MAX_PROPOSALS_PER_AGENT = 5

const PRE_EXECUTION: readonly RunState[] = ['planning', 'awaiting_approval']
const PROPOSING: readonly RunState[] = ['executing', 'testing', 'reviewing', 'verifying', 'repairing']

/** Fields of a task a proposal adds; the rest take the defaults of an unstarted draft. */
export type InsertTaskSpec = Pick<
  Task,
  'key' | 'title' | 'description' | 'role' | 'kind' | 'suggestedFiles' | 'acceptanceCriteria' | 'complexity' | 'modelTierOverride'
> & { risk?: Task['risk'] }

/** What the graph service needs from the orchestrator, which stays the only writer of task rows. */
export interface GraphHost {
  setTaskState: Core['setTaskState']
  tryTaskState: Core['tryTaskState']
  /** Insert a draft task with its criteria rows and the task.created event. */
  insertTask(run: Run, spec: InsertTaskSpec): Task
  requestTick(runId: string): void
  /** Stop the pipeline working on the task (and on its repair child), without waiting for it. */
  stopTaskPipeline(taskId: string): void
}

export interface Proposer {
  agentId: string | null
  label: string
  /** The proposer's own task; null for agents without one and for repair attempts. */
  taskId: string | null
}

export interface ProposeResult {
  /** Null only when the input was too malformed to persist (no valid proposal type). */
  proposal: GraphProposal | null
  outcome: 'applied' | 'rejected' | 'awaiting_approval'
  /** Text for the proposing agent: exactly what happened and what to do next. */
  message: string
}

/** Written when a proposal makes the proposer's task wait; read when its turn ends and when it resumes. */
export interface YieldMarker {
  proposalId: string
  at: string
}

const yieldKey = (taskId: string): string => `graph-yield:${taskId}`
const approvalKey = (approvalId: string): string => `graph-approval:${approvalId}`

const issueText = (issues: readonly { path: PropertyKey[]; message: string }[]): string[] =>
  issues.map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`)

/** Apply validated proposals transactionally and keep the revision history of the run's graph. */
export class GraphService {
  private host: GraphHost | null = null
  /** Submissions per agent, malformed ones included (those leave no row to count). */
  private readonly submissions = new Map<string, number>()

  constructor(
    private readonly deps: OrchestratorDeps,
    private readonly approvals: ApprovalService,
  ) {}

  bind(host: GraphHost): void {
    this.host = host
  }

  private get h(): GraphHost {
    if (!this.host) throw new Error('GraphService is not bound to an orchestrator')
    return this.host
  }

  // ───────────────────────────── proposals ─────────────────────────────

  propose(run: Run, proposer: Proposer | null, rawInput: unknown): ProposeResult {
    const { repos, bus } = this.deps
    const current = repos.runs.require(run.id)
    const who = proposer ?? { agentId: null, label: 'System', taskId: null }

    const parsed = GraphProposalInputSchema.safeParse(rawInput)
    const input = parsed.success ? parsed.data : this.persistableShape(rawInput)
    const errors: string[] = parsed.success ? [] : issueText(parsed.error.issues)

    if (!PROPOSING.includes(current.state)) errors.push(`The run is ${current.state}; the graph can only change while it is executing.`)
    if (who.agentId !== null) {
      const rows = repos.graphProposals.listByRun(run.id).filter((p) => p.proposedByAgentId === who.agentId).length
      const used = Math.max(rows, this.submissions.get(who.agentId) ?? 0)
      this.submissions.set(who.agentId, used + 1)
      if (used >= MAX_PROPOSALS_PER_AGENT) {
        errors.push(`Rate limit: an agent may submit at most ${MAX_PROPOSALS_PER_AGENT} graph proposals and you have used them all. Finish your task with the plan as it is.`)
      }
    }

    if (!input) {
      return { proposal: null, outcome: 'rejected', message: this.rejectedMessage(errors) }
    }
    const proposal: GraphProposal = bus.transaction(() => {
      this.ensureBaseline(run.id)
      const row = repos.graphProposals.insert({
        id: newId(),
        runId: run.id,
        proposedByAgentId: who.agentId,
        proposedBy: who.label,
        taskId: who.taskId,
        type: input.type,
        reason: input.reason,
        evidence: input.evidence,
        changes: input.changes,
        status: 'proposed',
        rejectionReason: null,
        revisionId: null,
        createdAt: nowIso(),
        resolvedAt: null,
      })
      bus.emit({
        runId: run.id,
        taskId: who.taskId,
        agentId: who.agentId,
        type: 'graph.proposed',
        payload: { proposalId: row.id, type: row.type, proposedBy: row.proposedBy },
      })
      return row
    })
    if (errors.length > 0) return this.reject(proposal, errors)

    const validation = this.validate(current, proposal)
    if (!validation.ok) return this.reject(proposal, validation.errors)

    if (validation.requiresApproval) {
      const approval = bus.transaction(() => {
        repos.graphProposals.update(proposal.id, { status: 'awaiting_approval' })
        const created = this.approvals.create({
          runId: run.id,
          taskId: proposal.taskId,
          agentId: proposal.proposedByAgentId,
          kind: 'graph',
          action: validation.summary,
          reason: proposal.reason,
          command: this.renderOperations(validation, repos.tasks.listByRun(run.id)),
          requestedBy: proposal.proposedBy,
          risk: 'medium',
        })
        repos.settings.setValue(approvalKey(created.id), proposal.id)
        return created
      })
      return {
        proposal: repos.graphProposals.require(proposal.id),
        outcome: 'awaiting_approval',
        message: `Awaiting user approval (${validation.approvalReason ?? 'this change needs approval'}; approval request ${approval.id}). The graph is unchanged until the user approves. Continue with your own task as it stands; do not wait for the answer.`,
      }
    }
    return this.applyProposal(current, proposal, validation, who.taskId !== null)
  }

  /** Resolution of a 'graph' approval: re-validate against the graph as it is now, then apply or reject. */
  onApprovalResolved(approval: ApprovalRequest): void {
    const { repos } = this.deps
    const proposalId = repos.settings.getValue<string>(approvalKey(approval.id))
    const proposal = proposalId ? repos.graphProposals.get(proposalId) : null
    if (!proposal || proposal.status !== 'awaiting_approval') return
    repos.settings.deleteValue(approvalKey(approval.id))
    if (approval.status !== 'approved') {
      this.reject(proposal, [`Denied by the user${approval.note ? `: ${approval.note}` : '.'}`])
      return
    }
    const run = repos.runs.require(proposal.runId)
    if (TERMINAL_RUN_STATES.includes(run.state)) {
      this.reject(proposal, [`The run is ${run.state}; the approved change was not applied.`])
      return
    }
    const validation = this.validate(run, proposal)
    if (!validation.ok) {
      this.reject(proposal, [`The graph changed while this proposal awaited approval and it is no longer valid: ${validation.errors.join(' ')}`])
      return
    }
    this.applyProposal(run, proposal, validation, false)
  }

  /** The run ended (or its approvals expired): proposals still waiting for a decision can never apply. */
  expireAwaiting(runId: string, why: string): void {
    for (const proposal of this.deps.repos.graphProposals.listByStatus(runId, 'awaiting_approval')) {
      this.reject(proposal, [why])
    }
  }

  private validate(run: Run, proposal: GraphProposal): ProposalValidation {
    const { repos } = this.deps
    const validation = validateProposal({
      tasks: repos.tasks.listByRun(run.id),
      dependencies: repos.dependencies.listByRun(run.id),
      proposal: { type: proposal.type, changes: proposal.changes, taskId: proposal.taskId },
    })
    if (!validation.ok || run.mode === 'build') return validation
    // AUDIT and ASK runs are read-only: no proposal may introduce a task that writes.
    const errors = validation.operations.flatMap((op) =>
      op.op === 'add_task' && WRITING_ROLES.includes(op.task.role)
        ? [`Task '${op.task.key}': ${run.mode.toUpperCase()} runs are read-only; role ${op.task.role} is not allowed.`]
        : [],
    )
    return errors.length > 0 ? { ok: false, errors } : validation
  }

  private persistableShape(raw: unknown): { type: GraphProposal['type']; reason: string; evidence: string; changes: GraphProposal['changes'] } | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    const type = ProposalTypeSchema.safeParse(record['type'])
    if (!type.success) return null
    const changes = GraphChangesSchema.safeParse(record['changes'])
    const text = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v.slice(0, 4000) : '(not provided)')
    return {
      type: type.data,
      reason: text(record['reason']),
      evidence: text(record['evidence']),
      changes: changes.success ? changes.data : GraphChangesSchema.parse({}),
    }
  }

  private rejectedMessage(errors: readonly string[]): string {
    return `Rejected, the task graph is unchanged: ${errors.join(' ')} Fix the proposal and submit it again, or continue your task without it. Do not work around this rejection.`
  }

  private reject(proposal: GraphProposal, errors: readonly string[]): ProposeResult {
    const { repos, bus } = this.deps
    const reason = errors.join('\n')
    const updated = bus.transaction(() => {
      const row = repos.graphProposals.update(proposal.id, { status: 'rejected', rejectionReason: reason, resolvedAt: nowIso() })
      bus.emit({
        runId: proposal.runId,
        taskId: proposal.taskId,
        agentId: proposal.proposedByAgentId,
        type: 'graph.rejected',
        payload: { proposalId: proposal.id, errors: [...errors] },
      })
      return row
    })
    return { proposal: updated, outcome: 'rejected', message: this.rejectedMessage(errors) }
  }

  // ───────────────────────────── applying ─────────────────────────────

  /**
   * Execute the operations mechanically in ONE transaction together with the revision row. `inTurn` is
   * true when the proposer's agent is still inside the tool call that submitted this: its own task is
   * then not stopped (the agent ends its turn itself); in every other case a cancelled task's agent is.
   */
  private applyProposal(run: Run, proposal: GraphProposal, validation: Extract<ProposalValidation, { ok: true }>, inTurn: boolean): ProposeResult {
    const { repos, bus } = this.deps
    const stop: string[] = []
    let revision: GraphRevision
    try {
      revision = bus.transaction(() => {
        const idByKey = new Map<string, string>()
        for (const op of validation.operations) this.execute(run, proposal, op, idByKey, stop)
        return this.writeRevision(run.id, `${proposal.type}: ${validation.summary}. ${proposal.reason}`, proposal.id)
      })
    } catch (e) {
      return this.reject(proposal, [`The change could not be applied and was rolled back: ${errorMessage(e)}`])
    }
    for (const taskId of stop) {
      if (inTurn && taskId === proposal.taskId) continue
      this.h.stopTaskPipeline(taskId)
    }
    this.h.requestTick(run.id)

    const own = proposal.taskId
    const yields = own !== null && validation.operations.some((o) => o.op === 'yield_task' && o.taskId === own)
    const ownGone = own !== null && validation.operations.some((o) => o.op === 'cancel_task' && o.taskId === own)
    const waitingOn = own !== null && yields ? this.unmetPrerequisites(repos.tasks.require(own)).map((t) => t.key) : []
    let message = `Applied as plan v${revision.version}: ${validation.summary}.`
    if (yields) {
      message += ` Your task now waits for ${waitingOn.join(', ')}. Finish your turn NOW with a short summary of what you have done so far; you will be resumed after the prerequisite is merged. Do not continue working on this task.`
    } else if (ownGone) {
      message += ' Your task has been replaced and is cancelled. Finish your turn now with a short summary; do not continue working on it.'
    }
    return { proposal: repos.graphProposals.require(proposal.id), outcome: 'applied', message }
  }

  private execute(run: Run, proposal: GraphProposal, op: GraphOperation, idByKey: Map<string, string>, stop: string[]): void {
    const { repos, bus } = this.deps
    const core = this.h
    switch (op.op) {
      case 'add_task': {
        const spec = op.task
        const row = this.h.insertTask(run, {
          key: spec.key,
          title: spec.title,
          description: spec.description,
          role: spec.role,
          kind: kindFor(run.mode, { role: spec.role, dependencies: spec.dependencies }),
          suggestedFiles: spec.suggestedFiles,
          acceptanceCriteria: spec.acceptanceCriteria,
          complexity: spec.complexity,
          risk: spec.risk,
          modelTierOverride: null,
        })
        idByKey.set(spec.key, row.id)
        for (const dep of op.dependsOnTaskIds) repos.dependencies.add(row.id, dep)
        for (const key of op.dependsOnNewKeys) repos.dependencies.add(row.id, this.created(idByKey, key))
        // Tasks added before the plan is approved stay drafts and are released with the rest of it.
        if (!PRE_EXECUTION.includes(run.state)) {
          core.setTaskState(row.id, 'ready')
          bus.emit({ runId: run.id, taskId: row.id, type: 'task.ready', payload: {} })
        }
        return
      }
      case 'add_dependency_on_new':
        repos.dependencies.add(op.taskId, this.created(idByKey, op.newKey))
        return
      case 'add_dependency':
        repos.dependencies.add(op.taskId, op.dependsOnTaskId)
        return
      case 'remove_dependency':
        repos.dependencies.remove(op.taskId, op.dependsOnTaskId)
        return
      case 'set_priority':
        repos.tasks.update(op.taskId, { priority: op.priority })
        bus.emit({ runId: run.id, taskId: op.taskId, type: 'task.updated', payload: { fields: ['priority'] } })
        return
      case 'cancel_task': {
        const reason = `graph proposal by ${proposal.proposedBy}`
        if (!core.tryTaskState(op.taskId, 'cancelled', {}, reason)) return
        bus.emit({ runId: run.id, taskId: op.taskId, type: 'task.cancelled', payload: {} })
        // Repair attempts belong to the cancelled task and die with it.
        for (const child of repos.tasks.listByParent(op.taskId)) {
          if (core.tryTaskState(child.id, 'cancelled', {}, reason)) {
            bus.emit({ runId: run.id, taskId: child.id, type: 'task.cancelled', payload: {} })
          }
        }
        stop.push(op.taskId)
        return
      }
      case 'yield_task': {
        const marker: YieldMarker = { proposalId: proposal.id, at: nowIso() }
        repos.settings.setValue(yieldKey(op.taskId), marker)
        return
      }
    }
  }

  private created(idByKey: ReadonlyMap<string, string>, key: string): string {
    const id = idByKey.get(key)
    if (!id) throw new Error(`Operation order error: task '${key}' was not created before it was referenced`)
    return id
  }

  // ───────────────────────────── revisions ─────────────────────────────

  /** Version 1: the approved plan (or the graph as it was when the history began). No-op when one exists. */
  ensureBaseline(runId: string, reason = 'Approved plan'): GraphRevision | null {
    if (this.deps.repos.graphRevisions.latest(runId)) return null
    return this.writeRevision(runId, reason, null)
  }

  /** Record the graph as it is now as the next version. Call inside the transaction that changed it. */
  writeRevision(runId: string, reason: string, proposalId: string | null): GraphRevision {
    const { repos, bus } = this.deps
    return bus.transaction(() => {
      const revision = repos.graphRevisions.insert({
        id: newId(),
        runId,
        version: repos.graphRevisions.nextVersion(runId),
        reason: reason.slice(0, 2000),
        proposalId,
        snapshot: snapshotGraph(repos.tasks.listByRun(runId), repos.dependencies.listByRun(runId)),
        createdAt: nowIso(),
      })
      if (proposalId) {
        repos.graphProposals.update(proposalId, { status: 'applied', revisionId: revision.id, rejectionReason: null, resolvedAt: nowIso() })
      }
      bus.emit({
        runId,
        type: 'graph.revised',
        payload: { proposalId, revisionId: revision.id, version: revision.version, summary: reason.slice(0, 300) },
      })
      return revision
    })
  }

  /** A change the user made to the graph (add, cancel, priority): history stays complete. */
  recordIntervention(runId: string, reason: string): GraphRevision {
    return this.writeRevision(runId, reason, null)
  }

  // ───────────────────────────── yielding ─────────────────────────────

  /** Prerequisites of the task that have not completed. A running task with any has been told to wait. */
  unmetPrerequisites(task: Task): Task[] {
    const { repos } = this.deps
    return repos.dependencies
      .listForTask(task.id)
      .map((d) => repos.tasks.get(d.dependsOnTaskId))
      .filter((t): t is Task => t !== null && t.state !== 'completed')
  }

  yieldMarker(taskId: string): YieldMarker | null {
    return this.deps.repos.settings.getValue<YieldMarker>(yieldKey(taskId))
  }

  /** The task is about to wait for new prerequisites; remember it so its next start is a resume. */
  markYielded(taskId: string): void {
    if (!this.yieldMarker(taskId)) this.deps.repos.settings.setValue(yieldKey(taskId), { proposalId: '', at: nowIso() } satisfies YieldMarker)
  }

  clearYield(taskId: string): void {
    this.deps.repos.settings.deleteValue(yieldKey(taskId))
  }

  // ───────────────────────────── rendering ─────────────────────────────

  /** Compact text for an approval request: what the operations will do, in order. */
  private renderOperations(validation: Extract<ProposalValidation, { ok: true }>, tasks: readonly Task[]): string {
    const key = (id: string): string => tasks.find((t) => t.id === id)?.key ?? id
    const lines: string[] = []
    if (validation.approvalReason) lines.push(`Approval needed: ${validation.approvalReason}`)
    for (const op of validation.operations) {
      switch (op.op) {
        case 'add_task': {
          const deps = [...op.dependsOnTaskIds.map(key), ...op.dependsOnNewKeys]
          lines.push(`+ task ${op.task.key} [${op.task.role}] ${op.task.title}${deps.length > 0 ? ` (after ${deps.join(', ')})` : ''}`)
          break
        }
        case 'cancel_task':
          lines.push(`- cancel ${key(op.taskId)}`)
          break
        case 'add_dependency':
          lines.push(`+ ${key(op.taskId)} depends on ${key(op.dependsOnTaskId)}`)
          break
        case 'add_dependency_on_new':
          lines.push(`+ ${key(op.taskId)} depends on ${op.newKey}`)
          break
        case 'remove_dependency':
          lines.push(`- ${key(op.taskId)} no longer depends on ${key(op.dependsOnTaskId)}`)
          break
        case 'set_priority':
          lines.push(`~ ${key(op.taskId)} priority ${op.priority}`)
          break
        case 'yield_task':
          lines.push(`~ ${key(op.taskId)} waits for its new prerequisites`)
          break
      }
    }
    return lines.join('\n').slice(0, 4000)
  }
}
