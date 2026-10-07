import type { AgentPurpose, Review, Run, Task, TaskError } from '@shared/domain'
import { errorMessage } from '@shared/result'
import type { RepositoryFact } from '@shared/v2'
import { composeContext, type ComposedContext } from '@main/modules/context/context-engine'
import { dependenciesOf } from '@main/modules/task-graph'
import { attachArbitration, effectiveFindings } from './arbitration'
import { factNotCurrent, graphContextFor, memoryNotCurrent } from './context-graph'
import type { Core } from './core'

const REVIEW_PURPOSES: readonly AgentPurpose[] = ['implement', 'diagnose']

/** Findings the task's latest review wants addressed: none unless that review requested changes. */
function priorReviewFor(core: Core, task: Task): { reviewId: string; findings: Review['findings'] } | null {
  const { repos } = core.deps
  const reviews = attachArbitration(repos.reviews.listByTask(task.id), repos.artifacts.listByTask(task.id))
  const latest = reviews.at(-1)
  if (!latest || latest.verdict !== 'changes_requested') return null
  return { reviewId: latest.id, findings: effectiveFindings(latest) }
}

/** Repository facts are an aid: a store failure costs the pack its facts, never the task its session. */
function factsOf(core: Core, run: Run): RepositoryFact[] {
  try {
    return core.deps.repos.facts.listByProject(run.projectId, { includeStale: true })
  } catch (e) {
    core.log(`repository facts unavailable for the context pack: ${errorMessage(e)}`)
    return []
  }
}

/**
 * Gather the sources of a task's context pack from durable state and compose it. Only what this task
 * can use is loaded: its dependencies, the run's decisions, the project's facts and memory, the messages
 * routed to it and its latest review. Messages are marked delivered, exactly as before.
 */
export function composeForTask(
  core: Core,
  run: Run,
  task: Task,
  purpose: AgentPurpose,
  cwd: string,
  previousError: TaskError | null,
): ComposedContext {
  const { repos } = core.deps
  const tasks = repos.tasks.listByRun(run.id)
  const upstreamIds = new Set(dependenciesOf(repos.dependencies.listByRun(run.id), task.id))
  const messages = core.messages.takeForTask(task.id)
  const memorySelected = core.memory.relevantFor(run, task)
  return composeContext({
    run,
    task,
    purpose,
    missionCriteria: run.plan?.acceptanceCriteria ?? [],
    dependencies: tasks.filter((t) => upstreamIds.has(t.id)),
    tasks,
    decisions: repos.decisions.listByRun(run.id),
    facts: factsOf(core, run),
    memorySelected,
    memoryExcluded: core.memory.unselectedFor(run, memorySelected),
    messages,
    repo: {
      worktreePath: cwd,
      branch: task.branch ?? run.integrationBranch ?? run.baseBranch ?? '',
      baseCommit: run.baseCommit ?? '',
      projectName: core.project(run).name,
      checks: run.config.checks,
    },
    priorReview: REVIEW_PURPOSES.includes(purpose) ? priorReviewFor(core, task) : null,
    graph: (shown) => graphContextFor(core, run, task, purpose, shown),
    memoryStatus: (entry) => memoryNotCurrent(core, entry.id),
    factStatus: (fact) => factNotCurrent(core, fact.id),
    extra: {
      attempt: task.attempt,
      userInstructions: messages.filter((m) => m.type === 'user_instruction').map((m) => m.body),
      ...(previousError
        ? {
            failure: {
              kind: 'checks' as const,
              summary: `The previous attempt failed: ${previousError.what}. Diagnose why before continuing.`,
              details: previousError.why ?? '',
            },
          }
        : {}),
    },
  })
}
