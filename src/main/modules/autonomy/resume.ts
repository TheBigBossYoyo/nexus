import { existsSync } from 'node:fs'
import { AUTONOMY_CAPABILITIES, BOUNDARY_RESUME_ACTION, quotedAction, type BoundaryRequest } from '@shared/autonomy'
import { TERMINAL_RUN_STATES, type Run, type Task } from '@shared/domain'
import { newId } from '@shared/ids'
import type { Repositories } from '@main/modules/persistence'

/**
 * 0.8: what happens to waiting work when the user answers a boundary request. Until now the answer changed
 * what the next attempt would be told, and the user had to start that attempt by hand. Here the answer does it:
 * the task that stopped at the boundary is put back in the queue, and a mission that was paused only because
 * of it goes on. Nothing is replayed: the task runs again from the worktree as it is, with a fresh session,
 * and whatever it asks for is decided again by the capability broker against the grant as it stands then.
 *
 * Granted: the task is told (on its own record) that the action may now be carried out.
 * Denied: the task is told that it will not be, and to finish what does not depend on it. The broker answers
 * the same request with a refusal for the rest of the mission and does not ask again.
 *
 * What is checked before anything is restarted: the mission still exists and has not ended; the project is
 * still enrolled; for a grant, that it was not taken back in the meantime; that the mission, if paused, was
 * paused for intervention and not by the user's own hand, by a quota, or for recovery. A check that does not
 * hold leaves everything as it is and says why. The user is not asked anything by this.
 */

export interface BoundaryResumeDeps {
  repos: Repositories
  orchestrator: { retryTask(taskId: string): Promise<Task>; resumeRun(runId: string): Promise<Run> }
  enrolled: (projectId: string) => boolean
  /** A line for the autonomy audit: what was restarted, or why nothing was. */
  record: (request: BoundaryRequest, action: string, reason: string) => void
  logger?: (line: string) => void
}

export interface BoundaryResumeOutcome {
  /** Tasks put back in the queue. */
  retried: string[]
  /** Whether a paused mission was resumed. */
  resumed: boolean
  /** Why nothing, or not everything, was restarted. Empty when all of it was. */
  notes: string[]
}

const WAITING: readonly Task['state'][] = ['blocked', 'failed']

/** How many times boundary decisions may restart one task. A task that went on asking is the user's to start again, not NEXUS's. */
export const MAX_BOUNDARY_RESTARTS_PER_TASK = 3

/** The tasks of the mission that stopped at this request: the one that asked (or the task it repairs), and any that names this request's id in what it reported. The label of a capability is not an id: a task that mentions it is not thereby waiting on this question. */
function waitingOn(repos: Repositories, request: BoundaryRequest): Task[] {
  if (request.runId === null) return []
  const tasks = repos.tasks.listByRun(request.runId)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const picked = new Map<string, Task>()
  const take = (task: Task | undefined): void => {
    if (task === undefined) return
    // A repair attempt is not restarted on its own: the task it repairs is.
    const root = task.parentTaskId !== null ? (byId.get(task.parentTaskId) ?? task) : task
    if (WAITING.includes(root.state)) picked.set(root.id, root)
  }
  if (request.taskId !== null) take(byId.get(request.taskId))
  for (const task of tasks) {
    if (!WAITING.includes(task.state)) continue
    const said = `${task.blockedReason ?? ''}\n${task.error ? JSON.stringify(task.error) : ''}`
    if (said.includes(request.id)) take(task)
  }
  return [...picked.values()]
}

export class BoundaryResumer {
  constructor(private readonly deps: BoundaryResumeDeps) {}

  /** Called once the user decided a request. Never throws: what could not be restarted is in the outcome and in the audit. */
  async decided(request: BoundaryRequest): Promise<BoundaryResumeOutcome> {
    const { repos } = this.deps
    const outcome: BoundaryResumeOutcome = { retried: [], resumed: false, notes: [] }
    const stop = (note: string): BoundaryResumeOutcome => {
      outcome.notes.push(note)
      this.deps.record(request, BOUNDARY_RESUME_ACTION, note)
      return outcome
    }
    if (request.state !== 'GRANTED' && request.state !== 'DENIED') return outcome
    if (request.runId === null) return outcome
    const run = repos.runs.get(request.runId)
    if (run === null || TERMINAL_RUN_STATES.includes(run.state)) return stop('The mission has ended; nothing is restarted.')
    if (!this.deps.enrolled(request.projectId)) return stop('The project is no longer enrolled; nothing is restarted.')
    if (request.state === 'GRANTED') {
      const grant = request.grantId ? repos.capabilityGrants.get(request.grantId) : null
      if (grant === null || grant.revokedAt !== null) return stop('The grant was taken back before the work could go on; nothing is restarted.')
    }
    const tasks = waitingOn(repos, request)
    if (tasks.length === 0) return outcome

    const label = AUTONOMY_CAPABILITIES[request.capability].label
    const granted = request.state === 'GRANTED'
    for (const task of tasks) {
      const restarts = repos.artifacts.listByTask(task.id).filter((a) => a.kind === 'boundary-decision').length
      if (restarts >= MAX_BOUNDARY_RESTARTS_PER_TASK) {
        outcome.notes.push(`${task.key} was restarted ${MAX_BOUNDARY_RESTARTS_PER_TASK} times by boundary decisions already; start it yourself if it should go on.`)
        continue
      }
      // On the task's record, where its next session and whoever checks it find it.
      try {
        repos.artifacts.insert({
          id: newId(),
          runId: run.id,
          taskId: task.id,
          agentId: null,
          kind: 'boundary-decision',
          title: granted ? `The user allowed: ${label}` : `The user denied: ${label}`,
          content: granted
            ? `Boundary request ${request.id} was answered: allowed (${request.decidedScope === 'ONCE' ? 'once, for exactly this action' : request.decidedScope === 'MISSION' ? 'for this mission' : 'for this project'}).\n${quotedAction(request.action)}\nIt may now be carried out. NEXUS started this task again by itself; carry on from the worktree as it is.`
            : `Boundary request ${request.id} was answered: denied.\n${quotedAction(request.action)}\nIt will not be done in this mission and is not to be attempted again or reached another way. Finish what does not depend on it, and say plainly in the result that this part was not done because the user declined it.`,
          createdAt: new Date().toISOString(),
        })
      } catch {
        // The record is for the reader; the restart does not depend on it.
      }
      // A worktree that is gone gets made again by the orchestrator when the task starts; noted, not a reason to stop.
      const worktree = task.worktreeId ? repos.worktrees.get(task.worktreeId) : null
      if (worktree && !existsSync(worktree.path)) outcome.notes.push(`The worktree of ${task.key} was gone; the task starts in a new one.`)
      try {
        await this.deps.orchestrator.retryTask(task.id)
        outcome.retried.push(task.id)
      } catch (e) {
        outcome.notes.push(`${task.key} could not be started again: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (outcome.retried.length > 0) {
      const now = repos.runs.get(run.id)
      if (now !== null && now.state === 'paused') {
        const paused = repos.events.latestOfType(run.id, 'run.paused')
        const cause = paused?.payload.cause ?? (paused?.payload.reason === 'user' && paused.payload.detail ? 'intervention' : (paused?.payload.reason ?? 'user'))
        if (cause !== 'intervention') outcome.notes.push(`The mission is paused (${cause}), not for this request: it is left paused, and the task runs when it is resumed.`)
        else {
          const stillWaiting = repos.tasks.listByRun(run.id).filter((t) => WAITING.includes(t.state) && t.parentTaskId === null)
          if (stillWaiting.length > 0) outcome.notes.push(`Other tasks of the mission still need attention (${stillWaiting.map((t) => t.key).join(', ')}): it stays paused.`)
          else {
            try {
              await this.deps.orchestrator.resumeRun(run.id)
              outcome.resumed = true
            } catch (e) {
              outcome.notes.push(`The mission could not be resumed: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        }
      }
    }
    const what = `${granted ? 'Allowed' : 'Denied'}: ${outcome.retried.length} task${outcome.retried.length === 1 ? '' : 's'} started again${outcome.resumed ? ', mission resumed' : ''}${outcome.notes.length > 0 ? `. ${outcome.notes.join(' ')}` : '.'}`
    this.deps.record(request, BOUNDARY_RESUME_ACTION, what)
    this.deps.logger?.(`autonomy: request ${request.id} ${request.state.toLowerCase()}: ${what}`)
    return outcome
  }
}
