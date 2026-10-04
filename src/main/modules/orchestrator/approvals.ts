import type { ApprovalRequest } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { NexusError } from '@shared/result'
import type { OrchestratorDeps } from './deps'

export type NewApproval = Pick<
  ApprovalRequest,
  'runId' | 'taskId' | 'agentId' | 'kind' | 'action' | 'reason' | 'command' | 'requestedBy' | 'risk'
>

type ResolvedListener = (approval: ApprovalRequest) => void

/**
 * Approval requests are durable rows; the promise waiters are in-memory. After a restart no agent
 * is waiting any more, so leftover pending rows are expired during recovery.
 */
export class ApprovalService {
  private readonly waiters = new Map<string, (approved: boolean) => void>()
  private readonly listeners = new Set<ResolvedListener>()
  private readonly expiredListeners = new Set<ResolvedListener>()

  constructor(private readonly deps: Pick<OrchestratorDeps, 'repos' | 'bus'>) {}

  create(input: NewApproval): ApprovalRequest {
    const { repos, bus } = this.deps
    return bus.transaction(() => {
      const approval = repos.approvals.insert({
        ...input,
        id: newId(),
        status: 'pending',
        note: null,
        createdAt: nowIso(),
        resolvedAt: null,
      })
      bus.emit({
        runId: input.runId,
        taskId: input.taskId,
        agentId: input.agentId,
        type: 'approval.requested',
        payload: { approvalId: approval.id, action: approval.action, risk: approval.risk },
      })
      return approval
    })
  }

  /** Create a request and wait for the user's decision. */
  requestDecision(input: NewApproval): Promise<boolean> {
    const approval = this.create(input)
    return new Promise<boolean>((resolve) => this.waiters.set(approval.id, resolve))
  }

  resolve(approvalId: string, approve: boolean, note: string | null = null): ApprovalRequest {
    const { repos, bus } = this.deps
    const current = repos.approvals.require(approvalId)
    if (current.status !== 'pending') {
      throw new NexusError('invalid_state', `Approval is already ${current.status}`)
    }
    const updated = bus.transaction(() => {
      const row = repos.approvals.update(approvalId, {
        status: approve ? 'approved' : 'denied',
        note,
        resolvedAt: nowIso(),
      })
      const base = { runId: row.runId, taskId: row.taskId, agentId: row.agentId }
      if (approve) bus.emit({ ...base, type: 'approval.granted', payload: { approvalId } })
      else bus.emit({ ...base, type: 'approval.denied', payload: { approvalId, note } })
      return row
    })
    this.settle(approvalId, approve)
    for (const listener of this.listeners) listener(updated)
    return updated
  }

  /** Expire pending requests (run cancelled, agent stopped, or app restarted). Waiters get a denial. */
  expire(filter: { runId?: string; agentId?: string; kind?: ApprovalRequest['kind'] } = {}): number {
    const { repos, bus } = this.deps
    const pending = repos.approvals
      .listPending(filter.runId)
      .filter((a) => filter.agentId === undefined || a.agentId === filter.agentId)
      .filter((a) => filter.kind === undefined || a.kind === filter.kind)
    for (const approval of pending) {
      const expired = bus.transaction(() => {
        const row = repos.approvals.update(approval.id, { status: 'expired', resolvedAt: nowIso() })
        bus.emit({
          runId: approval.runId,
          taskId: approval.taskId,
          agentId: approval.agentId,
          type: 'approval.resolved',
          payload: { approvalId: approval.id, status: 'expired' },
        })
        return row
      })
      this.settle(approval.id, false)
      for (const listener of this.expiredListeners) listener(expired)
    }
    return pending.length
  }

  /** Called for every request that expires (not for ones the user answered), so owners can clean up. */
  onExpired(listener: ResolvedListener): () => void {
    this.expiredListeners.add(listener)
    return () => this.expiredListeners.delete(listener)
  }

  onResolved(listener: ResolvedListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private settle(approvalId: string, approved: boolean): void {
    const waiter = this.waiters.get(approvalId)
    if (waiter) {
      this.waiters.delete(approvalId)
      waiter(approved)
    }
  }
}
