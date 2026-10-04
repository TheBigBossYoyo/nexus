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

`plan()` makes up to `MAX_PLAN_ATTEMPTS` = 3 attempts. With `planningMode: 'consensus'` it first runs the consensus flow (see Consensus planning) and falls back to this loop when no candidate is valid. Each attempt builds the prompt with
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
| Quota (`quota` outcome from an agent) | `pauseRun(runId, 'quota', ...)`; the interrupted tasks keep their state and session ids; no attempt is consumed. `agent.rate_limited` events record the SDK's `resetsAt`. Since 0.3 the usage controller closes the dispatch gate, waits, probes and resumes the run through `resumeRun`; a quota pause can still be resumed by hand. See [QUOTA_RECOVERY](QUOTA_RECOVERY.md). |
| Authentication required | Paused with reason `user`. |
| Duration limit | Paused with reason `user`. |
| Stuck (failed or blocked tasks, nothing runnable) | Paused with reason `user` and an `Intervention required` message. |
| Startup after the app was closed mid-run | Paused with reason `recovery` (see RECOVERY.md). |

`resumeRun` waits for in-flight work to settle, reconciles worktrees (aborts a merge a crash left in progress,
marks vanished worktrees `orphaned`; done on every resume, including after recovery `inspect`), restores
`resumeState` (`resumeTarget`), clears the pause, and then: `planning` re-plans, `awaiting_approval` re-creates the plan approval if none is
pending, anything else requests a tick (which restarts orphaned pipelines).

## Strategies (v0.3)

A strategy is configuration of this engine. There is no second scheduler. `strategy/strategies.ts` holds
five pure objects (`STRATEGY_REGISTRY`). `ADAPTIVE` is not one of them: it resolves to one of the five.

### Resolution in `createRun`

`CreateRunInput.strategy` is optional. When it is absent, or the mode is read-only (`ask`, `audit`), no
strategy is applied and the run behaves as in 0.2.1. Otherwise `Orchestrator.applyStrategy` runs after the
run row exists and after `prepare` (so Overnight's failsafe is armed first) and before any agent starts:

1. With a policy service (`deps.strategies.decideForRun`): the task is profiled and a `task_profiles` row is
   stored. `ADAPTIVE` calls the decision engine and stores a `policy_decisions` row; the plan then uses the
   chosen strategy and `decision.workerCount` as its agent limit. A concrete strategy is configured as asked.
   See [ADAPTIVE_POLICY](ADAPTIVE_POLICY.md).
2. Without a policy service (a process that has none, such as older scenario tests): a concrete strategy is
   configured directly and `ADAPTIVE` becomes `BUILD`.
3. The result is written to `runs.config.strategy` (`RunStrategyInfo`: `requested`, `resolved`,
   `speculativeCandidates`, `policyDecisionId`, `policySnapshotId`, `taskProfileId`, `arenaTrialId`). The
   decision is fixed for the run.
4. `planOverrides(plan)` supplies `maxParallelAgents`, `planningMode` and `reviewMode`. The caller's explicit
   `overrides` are applied after them and win.
5. `SWARM` also sets the run mode to `swarm`. Every other strategy keeps the mode the caller chose.
6. Events: `policy.decided` (ADAPTIVE only) and `strategy.selected` (`requested`, `resolved`, reason).

### What each strategy sets

| Strategy | Planning | Review mode | Parallel agents | Candidates | Single-worker tier |
|---|---|---|---|---|---|
| `SINGLE` | none | `auto` | 1 | 0 | `balanced` in ECO, else `strongest` |
| `BUILD` | single planner | `auto` | `presetMaxAgents(preset)` | 0 | not used |
| `SWARM` | single planner, swarm guidance | `auto` | `presetMaxAgents('eco')` in ECO, else `presetMaxAgents('maximum')` | 0 | not used |
| `CONSENSUS` | consensus (three planners, critic, synthesizer) | `dual` | `presetMaxAgents(preset)` | 0 | not used |
| `SPECULATIVE` | none | `auto` | N, the candidate count | N: 2 by default, 2 to 3 (`MAX_SPECULATIVE_CANDIDATES`) | as `SINGLE` |

### Single-task path (SINGLE and SPECULATIVE)

When `plan.planning === 'none'`, `createRun` runs no planner session. It builds a plan with one task and
materializes it:

| Field | Value |
|---|---|
| Task key, role | `implement`, `worker` |
| Title | the mission prompt with whitespace collapsed, cut to 120 characters |
| Description | the full prompt |
| Criteria | `CreateRunInput.acceptanceCriteria` when given, else one criterion quoting the first 300 characters of the prompt |
| Complexity, risk | from the task profile when there is one, else `medium` |
| Dependencies, approval | none, `requiresApproval: false` |
| Plan-level criteria | empty: there is no separate mission-level criterion; the task's own checks, review and verification judge it |
| Model tier | `modelTierOverride: 'strongest'` when `singleWorkerTier` is `strongest` |

Then the repository facts are refreshed and `startExecution` runs without a plan approval.

### Arena cap rule

In an Arena trial (`arenaTrialId` set) a caller's `overrides.maxParallelAgents` is a cap: the run uses
`min(plan.maxParallelAgents, cap)`. Otherwise the override would replace every strategy's own parallelism and
erase the difference the Arena measures. Outside the Arena an explicit override replaces the strategy's value.

## Speculative implement stage (v0.3)

For a run whose `speculativeCandidates` is at least 2, the implement stage of the mission's own worker task
(no parent task, first attempt) runs 2 or 3 candidate sessions in separate worktrees from the same commit, and
a deterministic tournament picks one. The winner continues through the normal checks, review, verification
and merge. Code: `orchestrator/speculation.ts` (`SpeculativeStage`), `strategy/tournament.ts`. Rules, edge
cases and records are in [SPECULATIVE_EXECUTION](SPECULATIVE_EXECUTION.md).

## Dispatch gate (v0.3)

`Orchestrator.setDispatchGate(gate)` installs a `DispatchGate` (`canDispatch()`, `limit(normal)`, optional
`onChange(listener)`). The usage service implements it; see [QUOTA_RECOVERY](QUOTA_RECOVERY.md). Without a
gate the orchestrator behaves as in 0.2.1.

While `canDispatch()` is false, a scheduler tick does this:

| Part of the tick | Behaviour |
|---|---|
| Duration limit, expired leases, dependency-failure cascade | Still run |
| `restartOrphans` | Skipped |
| `selectRunnable` | Called with `paused: true`: no task starts. Deferral announcements still happen |
| Finalization, mission verification, "stuck" detection | Skipped. The mission verifier is a session, and nothing is declared stuck because the gate is closed |
| Planning | No planner session starts; the run is paused with reason `quota` |
| Tasks already running | Not stopped by the gate. Their sessions end through their own outcomes (a limited session ends as `quota`) |
| Checks and merges in flight | Finish: they are local and deterministic |

When the gate is open, the limit passed to `selectRunnable` is `gate.limit(run.config.maxParallelAgents)`,
which a ramp after a resume lowers. When the gate reopens (`onChange`), every active run is ticked.

## Human interventions

All emit `user.intervention` events with an `action`.

| Action (IPC) | Effect |
|---|---|
| Approve or deny a plan, task, or tool request (`approvals.resolve`) | Plan: start or cancel. Task: grants `approvalGranted` or cancels the task. Tool: the waiting agent call proceeds or is denied. Graph: the held proposal is validated again and applied, or rejected. |
| `runs.replan` | Only from `awaiting_approval`; see Run lifecycle. |
| `runs.pause`, `runs.resume`, `runs.cancel` | Cancel moves the run and every non-terminal task to `cancelled`, expires pending approvals and stops sessions. Worktrees stay until `runs.cleanup`. |
| `agents.stop` | Stops the agent's pipeline control; the task becomes `failed` ("Agent stopped by user"). |
| `tasks.retry` | `failed` or `blocked` to `ready`, resets attempts and repair cycles. |
| `tasks.cancel` | Cancels the task and its repair children. On a repair child it also stops the debugger and fails the parent ("Repair cancelled by user"). |
| `tasks.setPriority` (-100 to 100) | Ranking input for the scheduler. |
| `tasks.add` | Adds a task `user-task-<n>` with dependencies (cycle-checked); like `tasks.cancel` and `tasks.setPriority` it writes a graph revision with no proposal. Writing roles are refused in AUDIT. It is `ready` immediately unless the run is still planning or awaiting approval. |
| `tasks.instruct` | Sends a `user_instruction` message: delivered live to the session doing the work (implementer or debugger, never a reviewer, verifier or planner session), otherwise included in the next prompt (context pack, resume prompt or repair prompt) and only then marked delivered. |
| `tasks.resolveBlocker` | Only for `blocked` tasks: optional instruction, then `ready`. |
| `criteria.update` | Edits a criterion text and resets it to `pending`. |
| `runs.recover` | `resume`, `inspect` or `cancel` for a run found paused after a restart. |
| `runs.cleanup` | Removes the worktrees of a finished run (never dirty-forced); branches are kept. |

## Inter-agent messages and memory

Agents call the in-process `nexus` MCP tools (AGENT_RUNTIME.md). An agent may only send the types in `AGENT_MESSAGE_TYPES` (`user_instruction` and `review_finding` are written by NEXUS and the user; an agent that claims one gets an `information` message). `MessageService` persists each message
and routes it: to an explicit task, to every open task of a role, or by default to the sender's direct
dependants. A running recipient gets it as a follow-up user message; otherwise it is included in the
recipient's next context pack. `propose_memory` creates a project memory entry with status `proposed`;
it only reaches other agents' context after approval, by the user or, if
`memory.autoApproveVerifierMemory` is on, when the proposing task passes verification. Retrieval is
FTS5 keyword search limited to `memory.maxEntriesPerContext` (default 8).

## Graph proposals (v0.2)

The task graph can change while a run executes. Agents never edit it: they submit a proposal through the
in-process tool `mcp__nexus__propose_graph_change` (AGENT_RUNTIME.md) and deterministic code decides
(`task-graph/proposals.ts` validates, `orchestrator/graph-service.ts` applies).

Who can propose: a session with a task whose role is `worker`, `debugger`, `architect` or `researcher` and whose
purpose is `implement`, `diagnose` or `research` (`canProposeGraphChange`). Planners, reviewers, verifiers, the
critic, the synthesizer and the arbiter never get the tool. A repair attempt (a task with a parent) proposes
without a task of its own: it cannot yield and has no "own task" rights. The run must be in `executing`, `testing`,
`reviewing`, `verifying` or `repairing`; otherwise the proposal is rejected.

### Types

| Type | `changes` fields used | Effect |
|---|---|---|
| `ADD_TASK` | `tasks`; optional `blocksProposer` | Adds the tasks. With `blocksProposer` the proposer's task depends on all of them and yields. |
| `SPLIT_TASK` | `targetTask`, `tasks` (at least 2) | Replaces a task with subtasks that inherit its prerequisites; the original is cancelled. |
| `CANCEL_TASK` | `targetTask` | Cancels a task (and its repair children). |
| `ADD_DEPENDENCY` | `targetTask`, `dependsOn` | `targetTask` waits for `dependsOn`. |
| `REMOVE_DEPENDENCY` | `targetTask`, `dependsOn` | Drops that edge. |
| `REPRIORITIZE` | `targetTask`, `priority` (-100 to 100) | Sets the task's priority. |
| `REPLAN` | `tasks` | Cancels every not-started task that is not listed and adds the listed tasks whose keys are new. A listed key that names a not-started task keeps that task unchanged. |

A proposal also carries `reason` (at most 4000 characters) and `evidence` (at most 8000), both required.

### Validation rules (`validateProposal`)

All errors are collected and returned to the agent; nothing is applied unless there are none.

- Added task keys are lowercase kebab-case, at most 64 characters, unique in the run (terminal tasks keep their
  keys) and unique within the proposal; a task may not depend on itself.
- Referenced tasks exist. A task that is failed or cancelled never satisfies a dependency, so nothing may be
  made to depend on one.
- Completed, failed and cancelled tasks are immutable. Repair children (tasks with a parent) cannot be targeted or
  depended on.
- Every added task whose role writes (`worker`, `debugger`) needs at least one acceptance criterion.
- A split must carry every acceptance criterion of the original (compared case-insensitively with whitespace
  collapsed) into some subtask.
- A split replaces a task that has not started (`draft`, `ready`, `blocked`, `queued`) or the proposer's own task
  (from `assigned`, `running` or `waiting`). Dependants of the original are rewired to depend on every
  subtask; a dependant that is already in progress makes the split invalid.
- Cancelling a task requires that no other open task still depends on it (a cancelled task never releases a
  dependant); cancel the dependants in the same proposal or rewire them.
- A started task (`assigned`, `running`, `waiting`, `review`, `verification`) can gain a prerequisite only when it is
  the proposer's own task and it is in `assigned`, `running` or `waiting`; it then yields unless the prerequisite is
  already completed. A started task can never lose a prerequisite.
- The resulting graph must be acyclic (simulated before applying); the error names the cycle.
- At most 8 added tasks per proposal (`DEFAULT_MAX_NEW_TASKS`).
- In ASK and AUDIT runs a proposal may not add a task with a writing role. Every other mode may.

### Approval policy

A valid proposal applies at once unless one of these holds. It then becomes an approval request of kind `graph`
(risk `medium`, the exact operations in the `command` field) and the proposal is `awaiting_approval`:

| Condition | Reason shown |
|---|---|
| Type is `REPLAN` | REPLAN replaces the open plan |
| It cancels a task other than the proposer's own (any type except `REPLAN`) | names the cancelled tasks |
| `ADD_DEPENDENCY`, `REMOVE_DEPENDENCY` or `REPRIORITIZE` on a task that is not the proposer's own | names the tasks |
| It adds more than 3 tasks (`APPROVAL_NEW_TASK_THRESHOLD`) | adds N tasks |
| It adds tasks and the run already applied 20 proposals, or the added tasks would bring the total added by proposals above 25 | run-wide limit |

A graph approval belongs to the run, not to the proposing session. It stays answerable after the proposer's turn
has ended and after an application restart. It is closed only when the run completes, fails or is cancelled, or
the request expires: the proposal is then rejected with a reason and its settings key (`graph-approval:<approvalId>`)
is deleted. When you approve, the proposal is validated again against the graph as it is at that moment and applied,
or rejected if it is no longer valid; a denial rejects it with your note. The proposing agent is told to carry on
with its own task and not to wait; it is not notified of the later decision.

### Limits

| Limit | Value | Constant |
|---|---|---|
| Proposals per proposing task (the agent id for an agent without a task) | 5, rejected and malformed ones included | `MAX_PROPOSALS_PER_AGENT` |
| New tasks per proposal | 8 | `DEFAULT_MAX_NEW_TASKS` |
| New tasks that force approval | more than 3 | `APPROVAL_NEW_TASK_THRESHOLD` |
| Applied proposals per run before a task-adding proposal needs approval | 20 | `MAX_APPLIED_PROPOSALS_PER_RUN` |
| Tasks added by proposals per run before approval is needed | 25 (counted from the tasks that applied proposals list) | `MAX_PROPOSED_TASKS_PER_RUN` |

The per-task allowance is keyed on the task so that retries, resumes and repair sessions do not reset it. User and
system proposals have no allowance. An approved proposal applies regardless of the run-wide limits.

### Applying a proposal

Each applied proposal runs its operations in one database transaction together with a new `graph_revisions` row
and the proposal's `applied` status; a failure rolls everything back and rejects the proposal. Operations:
`add_task` (a `draft` task that is set `ready` immediately, with the kind the planner rule gives its role),
`add_dependency`, `remove_dependency`, `set_priority`, `cancel_task` (the task and its repair children become
`cancelled`; the pipeline working on it is stopped, except the proposer's own task while its agent is still inside
the tool call, which ends its turn itself) and `yield_task`. Events: `graph.proposed`, `graph.rejected`,
`graph.revised`. The scheduler needs no change: `selectRunnable` works from current rows.

### Yield and resume

A task that gains a prerequisite while running gets a yield marker (settings key `graph-yield:<taskId>`) and its agent is
told to finish its turn with a summary. When the turn ends, `TaskPipeline.yieldIfWaiting` commits any leftovers in the
worktree, keeps the worktree, and moves the task `running -> queued` without consuming an attempt. The scheduler starts
it again once every dependency is `completed`, which means the prerequisite has been verified and merged into the
integration branch. The restart (`prepareResume`) first merges the integration branch into the task's worktree (commit
message `Sync <key> with <integration branch>`, under the merge lock), then starts a fresh session whose prompt names the
prerequisites, their result summaries and the task's previous summary. A conflicting sync merge is aborted and the agent
is told which command to run. A marker with nothing left to wait for (the prerequisite finished before the turn ended)
takes the same path. The marker is cleared when the task starts again or finishes. The pipeline also re-checks at the top
of every checks/review/verification loop, so a graph change approved after the agent's turn can still make the task yield.

### Revisions

`graph_revisions` holds a full snapshot (tasks with key, role, kind, state, priority, parent; dependency edges) per
version. Version 1 is written when execution starts (`startExecution`), or lazily by the first change if the history has
not begun. Each applied proposal adds a version. User changes (`tasks.add`, `tasks.cancel`, `tasks.setPriority`) also
write a version with no proposal, so the history is complete. `diffSnapshots` compares two versions by task key; the
Plan inspector shows the differences.

## Consensus planning (v0.2)

`RunConfig.planningMode` is `single` (default; absent in runs created before 0.2) or `consensus`. In `plan()`:

1. Three planner sessions (role `planner`, purpose `plan`) run concurrently with the same planner prompt plus one lens
   each: `Planner A (risk-first)`, `Planner B (parallelism-first)`, `Planner C (minimal-change)` (`PLANNER_LENSES`). They
   never see each other's output. Each result goes through the same `validatePlanOutput` as a single plan; every candidate
   is stored in `planning_candidates` with its validity, errors, duration, model and reported cost. Event:
   `planning.candidate`.
2. The critic (role `reviewer`, purpose `critique`, read-only, structured output `PlanCritiqueOutputSchema`) runs only when
   at least two candidates are valid. It gets one retry. Its critique is stored (`planning_critiques`, event
   `planning.critique`) and names a preferred candidate. If the critic fails, the synthesis still runs, without a critique.
3. The synthesizer (role `planner`, purpose `synthesize`) gets the valid candidates, the critique, the project profile and
   up to 10 repository facts, and returns a `MissionPlan`. An invalid synthesis is fed back with its errors, up to
   `MAX_PLAN_ATTEMPTS` (3) attempts (`plan.invalid`).
4. The accepted plan is materialized and approved exactly like a single plan (`requirePlanApproval`).

Fallbacks:

| Situation | Result |
|---|---|
| No valid candidate | The single-planner loop runs, starting with all candidate errors as the previous errors. |
| Exactly one valid candidate | Used directly; no critic, no synthesizer. |
| Critic fails | Synthesis runs without a critique. |
| Synthesis never becomes valid | The preferred candidate is used (the critic's choice if its label matches, else the first valid one). |
| Pause, cancel, stop, quota or authentication failure during planning | Nothing is decided; resuming plans again. The candidate and critique rows of the previous round are replaced by each new round (also on `replan`). |

`planning.synthesized` (candidate counts) is emitted when a plan is chosen. The planner and critic sessions go through the
normal agent runner, so routing, usage, pause and quota behave as for the single planner. `recommendPlanningMode` (IPC
`planning.recommend`) scores prompt length, number of deliverables, scope keywords and repository file count and suggests
`consensus` at a score of 3 or more; it only informs the composer.

## Model routing (v0.2)

Every agent session goes through `ModelRoutingService.route`, which calls the pure `routeModel`. Rules run in this order and
each appends a human-readable reason:

| # | Rule | Effect |
|---|---|---|
| 1 | Role policy (`RunConfig.modelPolicy[role]`, already adjusted by the preset) | Starting tier (`fast`, `balanced`, `strongest`); this is the recorded `requestedPolicy`. |
| 2 | Task risk `high` or complexity `large`, and the role writes (`worker`, `debugger`) | Raise to `strongest`. |
| 3 | Attempt 2 or later | Raise one step. |
| 4 | Repair cycle 1 or later after a `high` or `critical` finding | Raise to `strongest` (exempt from the ECO cap). |
| 5 | The task's stored tier override (set by retry escalation or by `repairTier`) | Raise to that tier (exempt from the ECO cap). |
| 6 | Measured performance: the aggregate for (role, the model of the current tier, task category) has at least 5 samples and a first-pass rate below 50% | Raise one step. |
| 7 | Resolve the tier through `settings.models.tiers` | If no model is configured for the tier the session uses the runtime default and the policy is recorded as `INHERIT`. |

The ECO preset holds every role except `planner` and `verifier` at `balanced` (or at the tier its policy already asked
for, if higher) for rules 2, 3 and 6. Rules only raise; a rule that changes nothing still records why. Only sessions that
do task work (`implement`, `diagnose`, `research`, `audit`, `synthesis`, `ask`) use the task's attempt, tier override and
category; planning and gate sessions use the role policy and the risk and size of the task they judge. From the second
repair cycle on, the escalation tier is stored on the repair task, so it survives a restart. Each agent gets exactly one
`routing_decisions` row (requested policy, resolved policy, tier, model, reasons) and a `routing.decided` event.

## Outcome recording (v0.2)

When a top-level task of kind `implement` or `repair` ends `completed` or `failed` (including a final failure after
retries), `recordTaskOutcome` upserts one `task_outcomes` row keyed by `outcome-<taskId>`, so a later retry updates the
same row. It never throws. The row records the implementing agent's model and tier (from its routing decision), category
(task kind), complexity, risk, attempts, review rejections, repair count, failed checks, user interventions, elapsed time
(start to finish) and tokens where the SDK reported them. `firstPassVerified` is true only for a completed task on
attempt 1 with no repair child, no review that requested changes and no failed verifier run. In a dual review the
arbiter's row supersedes the reviewers' rows for that attempt, so a decision counts once.

`aggregatePerformance` groups outcomes by (role, model, category) and reports sample counts and rates. A group is
`sufficient` at `MIN_ROUTING_SAMPLES` = 5 samples. The Performance view marks smaller groups as insufficient rather than
hiding them, and routing ignores them (rule 6). Outcomes without a model (the agent never started) are skipped.

## Dual review and arbitration (v0.2)

`RunConfig.reviewMode` is `standard`, `dual` or `auto` (the default when absent). `dual`, or `auto` for a task whose risk
is `high`, uses the dual flow; otherwise the single-reviewer flow of v0.1 runs (`security_reviewer` for a high-risk task in
`standard` mode, `reviewer` otherwise). Dual flow (`reviewDual`), per review attempt:

1. A `reviewer` (lens: correctness) and a `security_reviewer` (lens: security, concurrency, failure modes) run
   concurrently on the same inputs. Each review is persisted as its own row. A reviewer that cannot produce valid output
   after the gate's retry raises a pipeline error, as a single review does.
2. `dedupeFindings` merges findings about the same spot: the same file with line ranges that overlap or are within 3
   lines, or, when neither has line information, the same file (or both without one), the same category and a title token
   similarity (Jaccard) of at least 0.6. A merged finding keeps the highest severity and confidence and the longer
   evidence. Output is ordered by severity.
3. If no merged finding is `critical` or `high`, the task is approved and there is no arbiter.
4. Otherwise the arbiter (role `reviewer`, purpose `arbitrate`, read-only) receives every merged finding by index with the
   diff and decides each one: accepted or rejected, with a reason. Its decisions are stored as a review row (whose
   `findings` are the merged list) plus an artifact of kind `arbitration` whose title is that review's id and whose content
   is the arbiter output. `review.arbitrated` and `review.completed` are emitted.
5. Only accepted `critical` or `high` findings request changes. They are sent to the task as `review_finding` messages and
   feed the repair prompt.

Fail-safe (`applyArbitration`): when the arbiter returns no valid decision (after the gate's retry), the ruling is empty and
each finding is judged by rule. A finding with no decision is accepted only when it is `critical` or `high` with `high`
confidence; otherwise it is dropped with the reason "no arbiter decision". A silent arbiter therefore can neither erase a
confident serious finding nor let uncertain ones block a task. If an index is decided twice the first decision wins;
out-of-range indexes are ignored.

## Orchestration evidence for verifiers (v0.2)

A verifier cannot see messages, decisions or graph proposals in the repository, so `gatherEvidence` reads them from the
database and the verifier prompts (per-task verifier, mission verifier, repair prompt) get an "Orchestration evidence"
section (`renderOrchestrationEvidence`):

- Messages the task's agents sent (repair children included) and messages routed to the task. For the mission verifier:
  every message of the run, newest first, capped at 60 with the omitted count. Messages of type `user_instruction` and
  `review_finding` are not included (NEXUS or the user wrote them, not an agent).
- Decisions the task's agents recorded (id, time, title) and graph proposals they made (id, type, status, time, title).
- Each record is one line, `- record <kind> <id>: ...`. Every agent-written field is flattened to one line (control
  characters and all whitespace become a space) and cut to 120 characters. At most 25 records per group and 5000
  characters in total. Decision bodies and proposal reasons are never shown.

Authoritative: the existence of a record and its sender, recipient, type and time (written by NEXUS). Not authoritative: the
quoted text (subjects, titles), which the agents wrote and which proves nothing about the code. The section says so, and
criteria about code and files must still be verified in the repository. The per-task reviewer gets only the subjects of the
messages the task's agents sent, never bodies or reasoning.

## Repository intelligence and context packs (v0.2)

`refreshProjectFacts` analyses the project (`intelligence/`) and reconciles `repository_facts`. It runs when a project is
opened or re-profiled, when a run is created (before planning; a failure is logged and never blocks the run; event
`intelligence.refreshed`), and on request (`intelligence.refresh`). Facts that analysis owns (sources `manifest`,
`static_analysis`, `git`) are rewritten and marked stale when no longer produced. Facts from agents, verifiers or the user
are never overwritten and are marked stale when the fingerprint of their supporting files changes. When a task passes
verification, the decisions its agents recorded become `decision` facts with source `agent`, confidence `medium`, and a
statement that starts with "Agent-recorded decision (not independently verified)".

`composeContext` builds each task session's context from the task, criteria, completed dependency results, decisions
(run-level, of dependencies, or by architect tasks), repository facts (up to 8, chosen by shared paths and modules, then
commands, then term overlap; stale facts never), relevant approved memory, undelivered messages and, for `implement` and
`diagnose` sessions, the significant findings of the latest review. The pack records one entry per candidate with
`included` and a reason, at most 30 excluded entries per pack; repair and resume prompts are recorded as packs too. The pack
is stored with the agent (`context_packs`, `context_pack_entries`, event `context.composed`) and shown in the task
inspector's Context tab.
