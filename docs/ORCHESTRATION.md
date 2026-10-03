# Orchestration

How a run is driven. All of this is deterministic code in `src/main/modules/orchestrator/`
(`orchestrator.ts`, `pipeline.ts`, `agent-runner.ts`, `core.ts`) and the pure modules `scheduler/`,
`task-graph/` and `state/`. State lives in SQLite; agents hold no orchestration state.

## Run lifecycle

```
createRun
  ASK:   one researcher task -> startExecution (no planner, no approval)
  other: planning -> [awaiting_approval] -> executing <-> testing/reviewing/verifying/repairing
                                                |
                                       finalize (all tasks terminal)
                                                |
                                  mission verification -> completed | repairing (mission-fix task)
```

| Step | What happens (function) |
|---|---|
| Create | `Orchestrator.createRun` loads the project and settings, requires a Git repo with a commit unless the mode is ASK or AUDIT, records `baseBranch` and `baseCommit` (the project's current `HEAD`), builds a `RunConfig` with `buildRunConfig` (preset, settings, the project's detected check commands, overrides), inserts the run in `planning` and emits `run.created`. |
| Plan | `plan()` runs a `planner` agent (read-only, cwd = project root) with a JSON-schema output. See below. |
| Approval | If `config.requirePlanApproval` (default true) the run becomes `awaiting_approval` and an approval of kind `plan` is created. Approving starts execution; denying it cancels the run; `replan(runId, feedback)` deletes the draft tasks and criteria and plans again with the previous plan and your feedback. |
| Execute | `startExecution` moves every `draft` task to `ready`, sets the run to `executing` and requests a scheduler tick. |
| Tick loop | `requestTick` / `tick` (see Scheduler tick). Ticks of one run never overlap; a request during a tick sets a flag and the loop runs again. |
| Finalize | When every task is terminal and nothing is running, `finalize` runs (see Mission verification loop). |
| End | `completed`, `failed` (planning failure or unexpected background error) or `cancelled`. A run with failed tasks is not failed: it is paused for intervention. |

`run.state_changed` is emitted for every transition through `Core.setRunState`, which validates against
the state machine and writes the row and the event in one transaction.

### Run phases

While active the run state doubles as a phase indicator. `updatePhase` sets it from
`deriveRunPhase(tasks)` (`repairing` if any repair task is in flight; `verifying` or `reviewing` when
those are at least as common as implementation work; otherwise `executing`) and sets `testing` when
every running pipeline is in its checks stage. The phase is informational. Scheduling does not depend on it.

## Planner, plan validation and repair

`plan()` makes up to `MAX_PLAN_ATTEMPTS` = 3 attempts. Each attempt builds the prompt with
`buildPlannerPrompt` (request, mode guidance, limits, project profile, relevant approved memory, and on
later attempts the previous validation errors, plus feedback and the previous plan when replanning) and
runs the planner with `outputSchema = missionPlanJsonSchema`.

A result is accepted only if all of these pass (`validatePlanOutput`):

1. The structured output parses with `MissionPlanSchema` (zod).
2. `validatePlan` (`task-graph/plan-validation.ts`) reports no errors: duplicate task ids, unknown
   dependencies, self-dependency, repeated dependency, cycles, no mission-level acceptance criterion,
   or a `worker`/`debugger` task without an acceptance criterion.
3. In AUDIT mode no task has a writing role.

Failures are emitted as `plan.invalid` and the error list is given back to the planner on the next
attempt. After three failed attempts the run is failed with the collected errors. A quota outcome pauses
the run with reason `quota`; an auth outcome pauses it with reason `user`.

An accepted plan is materialized in one transaction: task rows in `draft` (kind from `kindFor`: worker
is `implement`, debugger `repair`, architect `design`, reviewers and verifier `audit`, planner and
researcher `research`; AUDIT uses `audit`/`synthesis`), dependency rows, and acceptance criteria
(per task and mission level). Then `plan.proposed` is emitted.

## Scheduler tick

`tick(runId)` in order:

1. Do nothing unless the run is `executing`, `testing`, `reviewing`, `verifying` or `repairing`.
2. If the run's active time exceeds `maxDurationMinutes`, pause the run (reason `user`). Active time excludes
   paused intervals (user, quota and recovery pauses): it is kept per run in the settings key/value table
   (`run-active:<runId>`, accumulated on every pause, restarted on every resume, and after a restart counted
   only up to the run's last event). A pause caused by the limit starts a fresh window, so Resume continues.
3. Clear expired leases of tasks that have no active pipeline (`findExpiredLeases`, event
   `task.lease_expired`).
4. `restartOrphans`: relaunch pipelines for tasks left in `assigned`, `running`, `review`,
   `verification` or `waiting` with no active pipeline (after a pause or restart). See RECOVERY.md.
5. `dependencyFailureCascade`: any `draft`, `ready` or `queued` task with a failed or cancelled task
   anywhere upstream is moved to `blocked` with a `dependency:` reason.
6. `selectRunnable` (pure) decides which tasks start. Each is set to `assigned` and `launch`ed as a
   `TaskPipeline` for stage `implement`.
7. `updatePhase`.
8. If nothing is running and no run-level work is pending: when every task is terminal, start
   `finalize`; otherwise, unless a task is only waiting for an approval, pause the run with
   `Intervention required: tasks <keys> are failed or blocked` (or `no task can make progress`).

A tick is requested after run creation, after every pipeline ends, after approvals and user
interventions, and after background work ends. There is no timer-based polling.

### Readiness rules (`scheduler/select-runnable.ts`)

Candidates are tasks in `ready` or `queued` that are not already active. They are ranked by priority
(descending), then number of transitive dependants (descending), then `createdAt`, then id. For each
candidate, in order, the first matching rule defers it:

| Rule | Defer reason |
|---|---|
| Run paused (not used by the orchestrator, which only calls it for active runs) | `run_paused` |
| Unexpired lease held | `leased` |
| Any dependency not `completed` | `waiting_on_dependencies` |
| `requiresApproval` and not `approvalGranted` | `awaiting_approval` (the tick creates a `task` approval once; a still-pending one from before a restart counts, so none is duplicated) |
| Already started `maxParallelAgents - active` tasks this pass | `no_free_slot` |
| Writing role and conflicts with a running or just-selected writer | `serialized_file_overlap` or `serialized_not_parallelizable` |

A deferred task never blocks lower-ranked tasks that fit. Active read-only tasks count against the slot limit.

### File-overlap serialization

Only writing roles (`worker`, `debugger`) are checked, against the writers already running and those
selected in the same pass. Overlap is computed from the planner's `suggestedFiles` with
`findOverlappingFiles`: paths are normalized (slashes, lowercase), a plain entry covers a file or a
directory subtree, `dir/**` covers the subtree, `dir/*` covers direct children, `**` covers everything,
and a task with no suggested files never overlaps by files. File overlap is reported first; otherwise a
task with `parallelizable: false` (or running next to such a task) is serialized behind any running
writer. The first deferral of each pair emits `task.serialized`.

Serialization is based on predictions. If two tasks touch the same file anyway, the conflict surfaces at
merge time and goes through the repair path.

## Pipeline per task

`TaskPipeline.execute` (details and persisted records in TASK_LIFECYCLE.md):

- Writing roles get a worktree (`ensureWorktree`), run `implement`, then loop `checks -> review ->
  verification -> merge`. Failures of checks, review, verification or merging go to `repair`, then back
  to `checks`.
- Non-writing roles (researcher, architect, reviewer roles used as planned tasks, verifier) run in the
  integration worktree if one exists, otherwise in the project root, and complete as soon as the agent
  finishes. There is no review, verification or merge for them; their final text becomes
  `resultSummary` and a `report` artifact, and is passed to dependants.

### Leases

When `implement` starts the task gets `leaseOwner` and `leaseExpiresAt = now + leaseMinutes`
(default 30). Agent activity renews it at most every 30 seconds. The lease is cleared when the pipeline
ends or the task reaches a terminal state. A live lease keeps `selectRunnable` from starting the task a
second time. A lease that expires while an in-process pipeline is still active is ignored: nothing kills
a running agent because of its lease. Expiry only matters for tasks whose pipeline is gone.

### Retries and escalation

Applies to a failed implement stage (`handleAgentFailure`), using `nextAttemptPlan`
(`scheduler/lifecycle.ts`) with `maxRetriesPerTask` (default 2) and `failures = task.attempt`:

| Failures (checked in this order) | Result |
|---|---|
| more than `maxRetries` | Give up: the task stays `failed` and `task.failed` is emitted with `retryable: false`. |
| 1 | Retry, same tier. |
| 2 or more | Retry, one tier stronger than the tier in use (fast to balanced to strongest; stays at strongest). |

Failure kinds: `max_turns` is `timeout`, `crashed` is `crash`, other errors are `agent_error`. A retry
sets `failed` then `ready` in one transaction (`task.retry`, and `task.escalated` when the tier
changes), and the next attempt receives the previous error in its context pack. Quota and auth outcomes
are not failures: the run pauses and the task keeps its state. A user stop marks the task `failed`
(retryable by hand) without retry. Gate (review/verifier) failures to produce valid output are not
retried through this path.

A failed task eventually causes `blocked` dependants and an intervention pause; `retryTask` returns the
task, and dependants blocked only by a dependency failure, to `ready`.

## Repair loop

`TaskPipeline.repair(run, parent, worktree, control, failure)`:

- Bound: if `parent.repairCycles >= config.maxIterations` (default 3, range 1 to 50) the parent task
  fails with `<kind> still failing after N repair cycle(s)`.
- Otherwise the parent goes to `waiting` with `repairCycles + 1`, and a child task is inserted already
  `running`: role `debugger`, kind `repair`, key `<parent>-fix<n>` (`n` is one more than the highest suffix among the
  parent's existing repair children, so keys stay unique across retries), `parentTaskId` set. From the second
  repair on, the child uses the `strongest` tier (`task.escalated`).
- The debugger runs in the parent's worktree with `buildRepairPrompt` (failure kind, summary, details,
  review findings or verification failures, check output).
- If the child succeeds without a blocker it is `completed`, the parent returns to `running`, and the
  pipeline restarts at `checks`. If it fails or reports a blocker, both child and parent are `failed`.
  If it was halted by a pause or quota the pipeline just stops.
- Repair children are attempts, kept as history. `retryTask` cancels open ones and rejects a retry of a repair child
  itself. A failed or cancelled repair child whose parent is not `failed` is ignored when deciding whether the
  run is finished, stuck or failed (`isSupersededRepair`). Cancelling a repair child stops its debugger, cancels
  that repair cycle and fails the parent with "Repair cancelled by user" (retryable).
- Pending user instructions for the parent are appended to the repair prompt.
- Checks may modify the task worktree. Before review everything the agent did is already committed, so what
  is dirty then came from the checks and is discarded (`WorktreeManager.resetClean`): the reviewed diff is
  exactly what is merged.
- Failure kinds that enter repair: failed checks, a review with `critical` or `high` findings, a failed
  verification, and a merge conflict with the integration branch (the debugger is told to run
  `git merge <integration branch>` in its worktree, resolve and commit).

The same `repairCycles` budget is shared by all four failure kinds for one task.

## Mission verification loop

`finalize(runId)` runs when all tasks are terminal:

1. If any task is `failed`: pause the run for intervention (`Intervention required: tasks ... failed`).
2. If all tasks are `cancelled`: the run is `cancelled`. (Superseded repair attempts are not counted in 1 and 2.)
3. Otherwise set the run to `verifying`. If the run has an integration worktree, run the check
   commands there (`runChecks`, attempt number = number of `mission-fix-*` tasks + 1), restore the integration
   worktree to its committed state (the checks may have left files behind) and compute the diff `baseCommit..HEAD`.
4. If checks passed and the plan has mission-level criteria, run one `verifier` agent
   (`buildMissionVerifierPrompt`) on the integration worktree. Its criteria update the
   `acceptance_criteria` rows. With no mission-level criteria the verifier is skipped and checks alone decide.
5. On failure: if `cycle > maxIterations` pause the run for intervention. Otherwise insert a
   `debugger` task `mission-fix-<cycle>` (kind `repair`, suggested files from the failures, acceptance
   criteria from the failed criteria, `strongest` tier from cycle 2), mark it `ready`, set the run to
   `repairing` and tick. That task goes through the normal pipeline, then `finalize` runs again.
6. On success the run becomes `completed` with `N/M tasks completed and verified.`

Runs without an integration worktree (ASK, AUDIT, or a plan with no writing tasks) complete without
this step. If the verifier cannot produce valid output the run is paused, not failed.

## Pause, quota and intervention

| Cause | Result |
|---|---|
| `pauseRun` by the user | Run `paused`, `pauseReason: user`, `resumeState` = state before. All agent sessions are stopped (`SessionControl.stop('paused')`) and the call waits for pipelines to unwind. |
| Quota (`quota` outcome from an agent) | `pauseRun(runId, 'quota', ...)`; the interrupted tasks keep their state and session ids. `agent.rate_limited` events record the SDK's `resetsAt`. Resuming is manual. |
| Authentication required | Paused with reason `user`. |
| Duration limit | Paused with reason `user`. |
| Stuck (failed or blocked tasks, nothing runnable) | Paused with reason `user` and an `Intervention required` message. |
| Startup after the app was closed mid-run | Paused with reason `recovery` (see RECOVERY.md). |

`resumeRun` waits for in-flight work to settle, reconciles worktrees (aborts a merge a crash left in progress,
marks vanished worktrees `orphaned`; done on every resume, including after recovery `inspect`), restores
`resumeState` (`resumeTarget`), clears the pause, and then: `planning` re-plans, `awaiting_approval` re-creates the plan approval if none is
pending, anything else requests a tick (which restarts orphaned pipelines).

## Human interventions

All emit `user.intervention` events with an `action`.

| Action (IPC) | Effect |
|---|---|
| Approve or deny a plan, task, or tool request (`approvals.resolve`) | Plan: start or cancel. Task: grants `approvalGranted` or cancels the task. Tool: the waiting agent call proceeds or is denied. |
| `runs.replan` | Only from `awaiting_approval`; see Run lifecycle. |
| `runs.pause`, `runs.resume`, `runs.cancel` | Cancel moves the run and every non-terminal task to `cancelled`, expires pending approvals and stops sessions. Worktrees stay until `runs.cleanup`. |
| `agents.stop` | Stops the agent's pipeline control; the task becomes `failed` ("Agent stopped by user"). |
| `tasks.retry` | `failed` or `blocked` to `ready`, resets attempts and repair cycles. |
| `tasks.cancel` | Cancels the task and its repair children. On a repair child it also stops the debugger and fails the parent ("Repair cancelled by user"). |
| `tasks.setPriority` (-100 to 100) | Ranking input for the scheduler. |
| `tasks.add` | Adds a task `user-task-<n>` with dependencies (cycle-checked). Writing roles are refused in AUDIT. It is `ready` immediately unless the run is still planning or awaiting approval. |
| `tasks.instruct` | Sends a `user_instruction` message: delivered live to the session doing the work (implementer or debugger, never a reviewer, verifier or planner session), otherwise included in the next prompt (context pack, resume prompt or repair prompt) and only then marked delivered. |
| `tasks.resolveBlocker` | Only for `blocked` tasks: optional instruction, then `ready`. |
| `criteria.update` | Edits a criterion text and resets it to `pending`. |
| `runs.recover` | `resume`, `inspect` or `cancel` for a run found paused after a restart. |
| `runs.cleanup` | Removes the worktrees of a finished run (never dirty-forced); branches are kept. |

## Inter-agent messages and memory

Agents call the in-process `nexus` MCP tools (AGENT_RUNTIME.md). `MessageService` persists each message
and routes it: to an explicit task, to every open task of a role, or by default to the sender's direct
dependants. A running recipient gets it as a follow-up user message; otherwise it is included in the
recipient's next context pack. `propose_memory` creates a project memory entry with status `proposed`;
it only reaches other agents' context after approval, by the user or, if
`memory.autoApproveVerifierMemory` is on, when the proposing task passes verification. Retrieval is
FTS5 keyword search limited to `memory.maxEntriesPerContext` (default 8).
