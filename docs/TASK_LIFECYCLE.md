# Task, agent and run lifecycle

Three state machines in `src/main/modules/state/machines.ts` govern persisted state. Every change goes
through `Core.setTaskState` / `Core.setRunState` (or `AgentRunner.setState` for agents), which
call `assertTransition`, write the row and emit the event in one transaction. An illegal transition throws
`NexusError('invalid_transition')`. `tryTaskState` returns null instead of throwing.

## Task state machine

Task states: `draft`, `ready`, `blocked`, `queued`, `assigned`, `running`, `waiting`, `review`,
`verification`, `failed`, `completed`, `cancelled`.

| From | Allowed next states |
|---|---|
| `draft` | ready, blocked, failed, cancelled |
| `ready` | queued, assigned, blocked, failed, cancelled |
| `queued` | assigned, ready, blocked, failed, cancelled |
| `assigned` | running, queued, blocked, failed, cancelled |
| `running` | waiting, review, completed, queued, blocked, failed, cancelled |
| `waiting` | running, review, blocked, failed, cancelled |
| `review` | verification, completed, running, waiting, blocked, failed, cancelled |
| `verification` | completed, running, waiting, blocked, failed, cancelled |
| `blocked` | ready, failed, cancelled |
| `failed` | ready (the only exit; `failed` is retryable, so not final) |
| `completed` | none |
| `cancelled` | none |

`isFinalState('task', s)` is true for `completed` and `cancelled`. `TERMINAL_TASK_STATES` also includes
`failed`, which is what scheduling and "run finished" checks use.

What the orchestrator actually does with them:

```mermaid
stateDiagram-v2
    [*] --> draft: materialize plan
    draft --> ready: startExecution
    ready --> assigned: scheduler tick
    assigned --> running: implement stage starts
    running --> review: checks passed
    running --> waiting: repair child running
    waiting --> running: repair succeeded
    review --> verification: review approved (or empty diff)
    verification --> completed: verified and merged
    running --> completed: read-only task finished
    running --> blocked: agent called report_blocker
    running --> failed: agent failure / repairs exhausted
    failed --> ready: retry (automatic or user)
    blocked --> ready: blocker resolved / retry
    draft --> blocked: upstream failed
    ready --> blocked: upstream failed
    ready --> cancelled: user / run cancelled
    running --> cancelled: user / run cancelled
    completed --> [*]
    cancelled --> [*]
```

`queued` is never entered by the orchestrator (it is accepted by the scheduler and the table).
`review` and `verification` can also fall back to `running` or `waiting` in the table, and the pipeline
uses `waiting` when a repair is started from those stages.

## Pipeline stages

`TaskPipeline.execute(runId, taskId, startStage, control)` drives one task. Stage type:
`'implement' | 'checks' | 'review' | 'verification'` (plus `'repair'` and `'merge'` reported through
`setStage` for run-phase derivation). The task state is the durable stage marker.

| Stage | Task state | What runs | Persisted |
|---|---|---|---|
| implement | `running` | One agent (role from the plan; worker or debugger writes, others read). Attempt counter incremented unless a session is resumed; lease set. | `agents`, `agent_sessions`, `agent_output`, `tool_events`, `usage_snapshots`; `tasks.resultSummary`; `artifacts` (kind `report`) for non-implementing purposes |
| checks | `running` | `commitLeftovers` commits anything the agent left uncommitted so the reviewed diff equals what is merged; then the project's check commands in the worktree in the order typecheck, lint, build, test, each with a timeout (`checkTimeoutMinutes`, default 15) and 48 KiB of output. | `verification_results` (kind `checks`, no agent, `commands`, `failures`) |
| review | `review` | Skipped if the diff against the merge base is empty. Otherwise a read-only `reviewer` (or `security_reviewer` when the task's risk is `high`) gets requirements, criteria, diff and check output, never the implementer's reasoning. Any `critical` or `high` finding means `changes_requested`. | `reviews` (verdict, summary, findings), `review.*` events, `review_finding` messages to the task |
| verification | `verification` | A read-only `verifier` judges each acceptance criterion with evidence. It has final authority: one failed criterion or reported failure fails the stage. | `verification_results` (kind `verifier`, criteria, failures); `acceptance_criteria` rows updated to `passed` or `failed` with evidence |
| merge | `verification` | `git merge --no-ff` of the task branch into the integration worktree, under a per-run lock. | `worktrees.state = merged`, `git.merged` or `git.conflict` event |
| complete | `completed` | `task.completed`; verifier-approved memory is promoted when auto-approve is on; the worktree is removed only if `git.removeWorktreesOnSuccess` is set. | |

The loop: `implement -> checks -> review -> verification -> merge`. A failed checks, review or
verification stage, or a merge conflict, goes to `repair` (child debugger task) and then back to `checks`.
The repair bound and escalation are in ORCHESTRATION.md. Review and verification agents that cannot return
valid structured output after two tries raise a pipeline error that fails the task (retryable by hand).

Non-writing tasks skip everything after implement. A task with a `blocker` from the agent becomes
`blocked` instead.

## Agent state machine

Agent states: `idle`, `starting`, `working`, `waiting`, `blocked`, `stopping`, `stopped`, `failed`.

| From | Allowed next states |
|---|---|
| `idle` | starting, stopped, failed |
| `starting` | working, stopping, failed |
| `working` | waiting, blocked, stopping, failed |
| `waiting` | working, blocked, stopping, failed |
| `blocked` | working, waiting, stopping, failed |
| `stopping` | stopped, failed |
| `stopped` | failed |
| `failed` | none |

`AgentRunner` inserts an agent as `starting`, moves it to `working` on `session.started`, toggles
`waiting` and `working` around tool approvals, and finishes it as `stopping` then `stopped`, or `failed`
(outcome other than success or stopped). `idle` and `blocked` are in the table but not entered by the runner.
Each agent row stores role, purpose, label, model reported by the SDK, activity, metrics and error. An
agent is one unit of work and can span several SDK sessions (resume, rotation); each is an
`agent_sessions` row with state `active`, `ended`, `rotated` or `failed`.

```mermaid
stateDiagram-v2
    [*] --> starting
    starting --> working: session.started
    working --> waiting: tool approval requested
    waiting --> working: approval resolved
    working --> stopping: finished or stopped
    stopping --> stopped
    working --> failed: crash / error outcome
    stopped --> [*]
    failed --> [*]
```

## Run state machine

Run states: `planning`, `awaiting_approval`, `executing`, `testing`, `reviewing`, `verifying`,
`repairing`, `paused`, `failed`, `completed`, `cancelled`. The five active phases are `executing`,
`testing`, `reviewing`, `verifying`, `repairing`.

| From | Allowed next states |
|---|---|
| `planning` | awaiting_approval, executing, paused, failed, cancelled |
| `awaiting_approval` | executing, planning, paused, failed, cancelled |
| `executing` | testing, reviewing, verifying, repairing, completed, paused, failed, cancelled |
| `testing` | executing, reviewing, verifying, repairing, paused, failed, cancelled |
| `reviewing` | executing, testing, verifying, repairing, paused, failed, cancelled |
| `verifying` | executing, testing, reviewing, repairing, completed, paused, failed, cancelled |
| `repairing` | executing, testing, reviewing, verifying, paused, failed, cancelled |
| `paused` | planning, awaiting_approval, the five active phases, failed, cancelled |
| `failed`, `completed`, `cancelled` | none |

`completed` is reachable only from `executing` or `verifying`. A paused run records `resumeState` and
`pauseReason` (`user`, `quota` or `recovery`); `resumeTarget(run)` returns the one legal state to resume
into and throws if the run is not paused or has no valid `resumeState`. `canPauseRun(state)` is true for
every state that can move to `paused`.

```mermaid
stateDiagram-v2
    [*] --> planning
    planning --> awaiting_approval: plan accepted, approval required
    planning --> executing: plan accepted, no approval / ASK
    awaiting_approval --> executing: plan approved
    awaiting_approval --> planning: replan
    executing --> reviewing: phase derived from tasks
    reviewing --> verifying
    verifying --> repairing: mission-fix task
    repairing --> executing
    executing --> completed: mission verification passed
    verifying --> completed
    executing --> paused: user / quota / recovery / stuck
    paused --> executing: resume (to resumeState)
    planning --> failed: planner gave no valid plan
    awaiting_approval --> cancelled: plan denied
    executing --> cancelled: user
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
```

## Persisted records

All tables are created by `src/main/modules/persistence/migrations/001-initial.ts`; the schema is
versioned in `schema_migrations`, migrations are append-only, and a database from a newer app version is
refused.

| Table | Contents |
|---|---|
| `projects` | Root path, profile (JSON), `respectProjectClaudeConfig` |
| `runs` | Mode, preset, state, resume state and pause reason, prompt, plan (JSON), base branch and commit, integration branch, `RunConfig` snapshot, error, timestamps |
| `tasks`, `task_dependencies` | Key, role, kind, state, priority, attempt, repair cycles, parent task, tier override, branch, worktree, lease, result summary, structured error |
| `agents`, `agent_sessions` | One agent per unit of work; SDK session ids, end reasons, handoffs |
| `agent_output` | Visible transcript items with a gapless per-agent sequence; no hidden reasoning |
| `tool_events` | Every tool call with input, status (`started`, `completed`, `failed`, `denied`), output preview |
| `run_events` | The durable event log with a global sequence number |
| `agent_messages`, `message_recipients` | Inter-agent and user messages and their delivery |
| `worktrees` | Path, branch, base commit, state (`active`, `merged`, `removed`, `orphaned`) |
| `reviews`, `verification_results`, `acceptance_criteria`, `decisions` | Gate outputs and recorded decisions |
| `memory`, `memory_fts` | Memory entries (status `proposed`, `approved`, `rejected`) and the FTS5 index |
| `approval_requests` | Kind (`plan`, `tool`, `task`; `git` and `merge` are defined but unused), action, exact command, risk, status |
| `artifacts` | Task reports (`report`) and worktree install logs (`setup-log`) |
| `usage_snapshots` | Per agent token and cost figures as reported by the SDK |
| `settings` | Key-value settings, validated and deep-merged over defaults on read |

The database is opened in WAL mode with foreign keys on. The event bus persists an event before notifying
subscribers and holds notifications until the surrounding transaction commits, so the UI never sees an
event that does not exist in the database.
