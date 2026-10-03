# Recovery

NEXUS keeps all orchestration state in SQLite and all work in Git worktrees on disk, so a closed or
crashed application can be recovered. Recovery never silently resumes work: interrupted runs are paused
and you choose what to do. Code: `Orchestrator.recoverOnStartup`, `listRecoverable`, `recover`,
`reconcileWorktrees`, `restartOrphans`; `TaskPipeline.resumableSession`.

## What survives a restart

| Survives | Where |
|---|---|
| Runs, plans, tasks, dependencies, criteria, attempts, repair cycles, leases | SQLite (`nexus.db`) |
| Agents, sessions (with Claude session ids), visible transcripts, tool events, usage | SQLite |
| Reviews, verifications, check results, decisions, messages, memory | SQLite |
| Event log (`run_events`) | SQLite |
| Pending plan and task approvals | SQLite (the run stays `awaiting_approval`) |
| Task and integration worktrees and their commits | Disk, `worktrees\<run>\...`, plus branches in your repository |
| Claude session transcripts | Disk, written by the runtime under `~/.claude/projects` |

Lost, because it only exists in memory: running `claude.exe` processes and their open turns, tool
approvals that were waiting on you, the merge lock, the set of "already announced" deferral events, and any
partially streamed text that was not yet a completed block.

## Startup

`bootstrap()` opens the database (running migrations), builds the orchestrator and calls
`recoverOnStartup()` before the window is created.

For every non-terminal run (`listActive`):

1. Agents still marked active (`starting`, `working`, `waiting`, `blocked`, `stopping`) are stale. Their
   `active` sessions are set to `ended` with end reason `app_restart`; the agent becomes `stopped` with the
   error "Stale: NEXUS stopped while this agent was running"; `agent.stopped` is emitted.
2. If the run was `paused` or `awaiting_approval` it is left as it is.
3. Otherwise (planning, executing, testing, reviewing, verifying, repairing) it is set to `paused` with
   `resumeState` = the state it was in, `pauseReason: recovery`, and `run.paused` and
   `run.recovered { action: 'detected', staleAgents }` events are emitted.
4. Pending approvals of kind `tool` are expired (their agents are gone). Plan and task approvals are kept.

Task states are not touched at this point. A task that was `running` stays `running` until the run is
resumed.

A normal quit (`before-quit`) stops live sessions first (`SessionControl.stop('shutdown')`, then
`runtime.shutdown()`), then closes the database. Shutdown also sets a closing flag so no scheduler pass launches new work while sessions are being stopped. Runs are not paused on quit; the next startup does it
through the steps above. Sessions stopped this way end with reason `shutdown`.

## Resume, inspect, cancel

`runs.recoverable` returns each recovery-paused run with its project name, number of stale agents, number
of active tasks (`assigned`, `running`, `review`, `verification`, `waiting`) and number of active
worktrees. `runs.recover { runId, action }`:

| Action | Effect |
|---|---|
| `resume` | `reconcileWorktrees`, then `resumeRun` |
| `inspect` | The run stays paused; `pauseReason` becomes `user` so it is no longer flagged. You can read everything and resume or cancel later. |
| `cancel` | `cancelRun`: run and non-terminal tasks become `cancelled`, approvals expire. Worktrees and branches are left for you. |

`runs.resume` on a paused run does the same as `resume` without the worktree reconciliation step.

### Worktree reconciliation

`reconcileWorktrees` looks at the run's `active` worktree records:

- If the directory exists and a merge was interrupted (`MERGE_HEAD` present) it runs `git merge --abort`,
  because a half-finished merge would block every later merge.
- If the directory is gone, the record is marked `orphaned`, `git.worktree.removed` is emitted, and
  `git worktree prune` is run in the project repository.

A writing task whose worktree is gone gets a new worktree when it restarts (`ensureWorktree`); because the
old branch still exists, the new branch gets a random suffix. Work that existed only in the lost directory
is lost, but commits stay in the repository's branch.

Not handled: if the integration worktree directory is deleted, the code tries to re-create it with
`git worktree add -b nexus/<run>/integration ...`, which fails because that branch already exists, so
tasks fail with a Git error. The branch and everything merged into it are still in your repository: cancel
the run and merge or inspect the branch with Git.

Unregistered or unknown worktrees are not scanned or cleaned by the application; the helpers for that
(`findOrphans`, `cleanupOrphans` in `WorktreeManager`) are not wired in.

### What resuming restarts

`resumeRun` restores the run to `resumeState` and requests a tick. The tick calls `restartOrphans`, which
relaunches a pipeline for each task without an active pipeline, by task state:

| Task state | Restarts at |
|---|---|
| `assigned`, `running` | implement stage (see below for session handling). The `running` state does not record whether the task was in implement or checks, so a task stopped during its checks begins again at implement, starts a new attempt and re-runs checks afterwards. |
| `review` | review stage (checks results are read back from the last persisted checks record) |
| `verification` | verification stage |
| `waiting` | Its repair child is cancelled, and the pipeline restarts at checks |

Tasks in `ready` are scheduled normally; `blocked` and `failed` tasks wait for you. A run recovered from
`planning` plans again; one recovered from `awaiting_approval` re-creates the plan approval if it is
missing. Mission verification runs again if the run was finalizing.

## Session resume versus a fresh session with handoff

`resumableSession(taskId)` looks at the task's latest implementing or repairing agent (reviews and
verifications are excluded) and its latest session record.

- If that session has an SDK session id and ended for a resumable reason (`paused`, `quota`, `auth`,
  `app_restart`, `shutdown`), NEXUS resumes it with `resume: <session id>` and the prompt "Continue the
  task from where you stopped. Check `git status` and `git log` first to see what is already done." The
  attempt number is not incremented. The worktree and the Claude transcript are what make this possible;
  if the runtime can no longer resume the session, the agent ends in an error and the ordinary retry path
  (below) takes over.
- Otherwise (the session ended with `completed`, `error`, `crashed`, `max_turns`, `user_stop`,
  `cancelled`, or never reported an id) a fresh session starts with a newly built context pack: task,
  criteria, dependency results, decisions, memory, undelivered messages, repository state, and a summary
  of the previous failure. It consumes a new attempt.
- Separately, within one attempt, a session that runs out of turns is rotated with a structured handoff
  (AGENT_RUNTIME.md). That is not a recovery path; it only keeps long tasks inside the context window.

After quota, authentication, user pause or user stop the pipeline stops without failing the task. Quota
never resumes by itself: when your limit resets, resume the run.

## Other recovery behaviour

- A task pipeline that throws marks only that task `failed`; the run keeps going and eventually pauses for
  intervention if nothing else can run.
- Leases of tasks without a live pipeline are released on the next tick (`task.lease_expired`).
- Run-level background work (planning, finalization) that throws fails the run unless it is paused or
  finished; it never crashes the application.
- A startup failure (database cannot be opened, schema newer than the app) shows an error dialog and exits.
