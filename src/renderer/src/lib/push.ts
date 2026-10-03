import type { QueryClient } from '@tanstack/react-query'
import type { AgentOutput, AgentOutputKind } from '@shared/domain'
import type { PushMessage, RunEvent } from '@shared/events'
import { api } from './bridge'
import { qk } from './queries'
import { useLiveStore } from '../store/live'

type Key = readonly unknown[]

const OUTPUT_KINDS: readonly AgentOutputKind[] = ['text', 'system', 'user', 'error']

function toOutputKind(kind: string): AgentOutputKind {
  return (OUTPUT_KINDS as readonly string[]).includes(kind) ? (kind as AgentOutputKind) : 'system'
}

/** Which cached queries a durable event makes stale. Pure; unit-tested. */
export function keysForEvent(event: RunEvent): Key[] {
  const { runId, taskId, agentId } = event
  const keys: Key[] = [qk.eventsRoot(runId)]
  const family = event.type.split('.')[0]
  switch (family) {
    case 'run':
      keys.push(qk.run(runId), qk.runsList(), qk.runSummary(runId), qk.approvals())
      if (event.type === 'run.recovered') keys.push(qk.recoverable())
      break
    case 'plan':
      keys.push(qk.run(runId))
      break
    case 'task':
      keys.push(qk.run(runId), qk.runSummary(runId))
      if (taskId) keys.push(qk.taskDiff(taskId))
      break
    case 'agent':
      keys.push(qk.run(runId))
      if (agentId) {
        keys.push(qk.agent(agentId))
        if (event.type.startsWith('agent.tool.')) keys.push(qk.agentTools(agentId))
      }
      if (event.type === 'agent.usage') keys.push(qk.runSummary(runId))
      break
    case 'git':
      keys.push(qk.run(runId), qk.runDiff(runId), qk.runSummary(runId))
      if (taskId) keys.push(qk.taskDiff(taskId))
      break
    case 'checks':
    case 'verification':
      keys.push(qk.verifications(runId), qk.runSummary(runId), qk.run(runId))
      if (taskId) keys.push(qk.taskVerifications(taskId))
      break
    case 'review':
      keys.push(qk.reviews(runId), qk.runSummary(runId))
      if (taskId) keys.push(qk.taskReviews(taskId))
      break
    case 'approval':
      keys.push(qk.approvals(), qk.run(runId))
      break
    case 'message':
      keys.push(qk.messagesRoot(runId))
      break
    case 'memory':
      keys.push(qk.memoryRoot())
      break
    case 'decision':
      keys.push(qk.decisions(runId))
      break
    default:
      // criterion.*, user.* and anything added later: refresh the run itself.
      keys.push(qk.run(runId), qk.runsList())
  }
  return keys
}

export interface PushHandler {
  handle(message: PushMessage): void
  dispose(): void
}

export interface PushOptions {
  /** Window in which invalidations are merged. */
  debounceMs?: number
  live?: Pick<ReturnType<typeof useLiveStore.getState>, 'append' | 'clear'>
}

export function createPushHandler(qc: QueryClient, options: PushOptions = {}): PushHandler {
  const debounceMs = options.debounceMs ?? 150
  const live = options.live ?? useLiveStore.getState()
  const pending = new Map<string, Key>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    timer = null
    const keys = [...pending.values()]
    pending.clear()
    for (const queryKey of keys) void qc.invalidateQueries({ queryKey })
  }

  const schedule = (keys: Key[]) => {
    for (const k of keys) pending.set(JSON.stringify(k), k)
    // A fixed window (not reset per message) so a continuous stream still flushes.
    timer ??= setTimeout(flush, debounceMs)
  }

  return {
    handle(message) {
      switch (message.kind) {
        case 'event':
          schedule(keysForEvent(message.event))
          break
        case 'agent.output': {
          const item: AgentOutput = {
            id: `${message.agentId}:${message.seq}`,
            agentId: message.agentId,
            seq: message.seq,
            kind: toOutputKind(message.outputKind),
            content: message.content,
            // The push carries no timestamp; this is the time the renderer received it.
            createdAt: new Date().toISOString(),
          }
          qc.setQueriesData<AgentOutput[]>({ queryKey: qk.agentOutputRoot(message.agentId) }, (old) => {
            if (!old) return old
            if (old.some((o) => o.seq === item.seq)) return old
            return [...old, item].sort((a, b) => a.seq - b.seq)
          })
          live.clear(message.agentId)
          break
        }
        case 'agent.delta':
          live.append(message.agentId, message.text)
          break
        case 'auth.changed':
          schedule([qk.auth(), qk.models()])
          break
        default:
          // Unknown push kinds from a newer main process are ignored.
          break
      }
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
    },
  }
}

/** Subscribe once at app start. Returns the teardown. */
export function startPush(qc: QueryClient): () => void {
  const handler = createPushHandler(qc)
  const unsubscribe = api.onPush((m) => handler.handle(m))
  return () => {
    unsubscribe()
    handler.dispose()
  }
}
