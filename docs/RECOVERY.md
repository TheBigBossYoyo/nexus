# Recovery

NEXUS keeps all orchestration state in SQLite and all work in Git worktrees on disk, so a stopped or
crashed application can be recovered. Recovery never silently resumes work: interrupted runs are paused
and you choose what to do. Code: `Orchestrator.recoverOnStartup`, `listRecoverable`, `recover`,
`reconcileWorktrees`, `restartOrphans`; `TaskPipeline.resumableSession`.

Since 0.7 (branch `nexus-0.7`, not released) NEXUS is three processes: the window, a persistent **runtime** process that
owns the database and the work, and worker processes that run the agent sessions (`ARCHITECTURE.md`, "Process
model (0.7)"). What a "restart" is depends on which process ended:

| What ended | What happens to the work |
|---|---|
| The window (closed, or crashed) | Nothing. The runtime and its work continue. Opening NEXUS again connects to the runtime and reads everything again. |
| One worker | Its lease is revoked and its session ends as `crashed`; the orchestrator's retry rules decide what happens to the task. The runtime and the other workers are not affected (`WORKERS.md`). |
| The runtime (Stop NEXUS, sign-out, or a crash) | The workers end themselves, because a worker never outlives its runtime. The next runtime start is the recovery described below. |
| The whole computer (power loss, Windows restart) | As for the runtime; the overnight rules in `OVERNIGHT_MODE.md` apply to an overnight run. |

**Closing the window does not stop anything.** To stop NEXUS choose "Stop NEXUS" (the tray icon, or Runtime
diagnostics in the Control Center; channel `runtime.stop`). It asks first when work is active.

## What survives a restart

| Survives | Where |
|---|---|
| Runs, plans, tasks, dependencies, criteria, attempts, repair cycles, leases | SQLite (`nexus.db`) |
| Agents, sessions (with Claude session ids), visible transcripts, tool events, usage | SQLite |
| Reviews, verifications, check results, decisions, messages, memory | SQLite |
| Event log (`run_events`) | SQLite |
| Pending plan and task approvals | SQLite (the run stays `awaiting_approval`) |
| Graph revisions and graph proposals (all statuses, with rejection reasons) | SQLite (`graph_revisions`, `graph_proposals`) |
| Pending graph approvals and the link to their proposal | SQLite (`approval_requests` kind `graph`, settings key `graph-approval:<approvalId>`); still answerable after a restart |
| Yield markers of tasks waiting for a new prerequisite | SQLite settings key `graph-yield:<taskId>` |
| Consensus planning candidates and critiques | SQLite (`planning_candidates`, `planning_critiques`) |
| Routing decisions, task outcomes, context packs, repository facts | SQLite |
| Task and integration worktrees and their commits | Disk, `worktrees\<run>\...`, plus branches in your repository |
| Claude session transcripts | Disk, written by the runtime under `~/.claude/projects` |

Since 0.7 these are stored as well, and read again after a restart of the runtime: the global queue, its order, the
limits and the dispatch pause, schedules and the record of each occurrence that fired (`schedule_firings`), the
scheduler's decisions, and the worker and lease history (`workers`, `worker_leases`, `worker_events`). Workers and
leases of an earlier start are marked stale, not resumed (see below).

Lost, because it only exists in memory: running `claude.exe` processes (in their worker processes) and their open turns, tool
approvals that were waiting on you, the merge lock, the set of "already announced" deferral events, and any
partially streamed text that was not yet a completed block. The in-memory count of graph proposals per task is
rebuilt from the stored proposals, so the per-task limit holds across a restart.

## Startup

`startRuntimeCore()` (`src/main/runtime/core.ts`) opens the database (running migrations), builds the worker
manager and the orchestrator and, before anything can dispatch, does these in this order:

1. `WorkerManager.recoverOnBoot()`: workers recorded as alive by an earlier start of the runtime are marked `STOPPED`
   and their active leases `EXPIRED`. Nothing is killed by process id (a worker ends itself when its runtime is gone,
   and a process id from an earlier start may belong to anything by now). The sessions they ran are not judged.
2. `Orchestrator.recoverOnStartup()`: the steps below.

The runtime then starts its local server and reports the phase `RECOVERING` with counts (interrupted runs, stale
workers, stale leases) while Arena campaigns, background jobs, programs and workspace missions recover, the control plane
reads its queue against the workloads (resuming missions when the limits say `resume`; the default is `hold`), and the
overnight supervisor recovers its run. The window that connects meanwhile shows `RECOVERING` and stays usable. When this
is done the phase is `READY` and, if anything was reconciled, an incident records the counts. The window is no longer
part of this: it is created, or not, independently.

For every non-terminal run (`listActive`):

1. Agents still marked active (`starting`, `working`, `waiting`, `blocked`, `stopping`) are stale. Their
   `active` sessions are set to `ended` with end reason `app_restart`; the agent becomes `stopped` with the
   error "Stale: NEXUS stopped while this agent was running"; `agent.stopped` is emitted.
2. If the run was `paused` or `awaiting_approval` it is left as it is.
3. Otherwise (planning, executing, testing, reviewing, verifying, repairing) it is set to `paused` with
   `resumeState` = the state it was in, `pauseReason: recovery`, and `run.paused` and
   `run.recovered { action: 'detected', staleAgents }` events are emitted.
4. Pending approvals of kind `tool` are expired (their agents are gone). Plan, task and graph approvals are kept.

Task states are not touched at this point. A task that was `running` stays `running` until the run is
resumed.

A clean stop of the runtime ("Stop NEXUS", `runtime.stop`, or a sign-out of Windows, which asks nothing) does this, in
order: a finalization of an overnight run that is in progress finishes first (at most 30 seconds); the control plane,
the engines and the quota controller stop so that nothing new starts; the orchestrator stops live sessions
(`SessionControl.stop('shutdown')`); the worker manager stops the workers (it asks, waits up to eight seconds, then ends
what is left with its process tree); the local server closes and the endpoint file is removed; the database is
checkpointed and closed. Shutdown also sets a closing flag so no scheduler pass launches new work while sessions are
being stopped. Runs are not paused on a stop; the next startup does it through the steps above. Sessions stopped this
way end with reason `shutdown`. An armed Windows shutdown timer of an overnight run is left alone on purpose: it
belongs to Windows.

If the runtime is ended without this (killed, crashed), none of it happens. The next start finds the same stored state
and handles it as described above: stale workers and leases, runs paused for recovery, expired tool approvals. The
workers end themselves when their runtime is gone.

Closing the window is not a stop. The window's process ends and the runtime keeps running with its tray icon; the
window asks only during an overnight mission (hide to the tray, cancel the mission, or return).

## Resume, inspect, cancel

`runs.recoverable` returns each recovery-paused run with its project name, number of stale agents, number
of active tasks (`assigned`, `running`, `review`, `verification`, `waiting`) and number of active
worktrees. `runs.recover { runId, action }`:

| Action | Effect |
|---|---|
| `resume` | `resumeRun` (which reconciles worktrees first) |
| `inspect` | The run stays paused; `pauseReason` becomes `user` so it is no longer flagged. You can read everything and resume or cancel later. |
| `cancel` | `cancelRun`: run and non-terminal tasks become `cancelled`, approvals expire. Worktrees and branches are left for you. |

`runs.resume` on a paused run does the same as `resume`: `resumeRun` runs the worktree reconciliation on every
resume, so a run that was only inspected first is reconciled too.

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
| `assigned` | implement stage (see below for session handling). |
| `running` | The state stays `running` through the checks and after a successful repair, so the stage is derived from the implementing agent: if its latest agent finished with a `completed` session (`TaskPipeline.resumeStage`), the work is done and the task restarts at checks, without a new attempt or agent. Otherwise implement, as for `assigned`. |
| `review` | review stage (checks results are read back from the last persisted checks record) |
| `verification` | verification stage |
| `waiting` | Its repair child is cancelled, and the pipeline restarts at checks |
| `assigned` or `running` with a prerequisite that is not completed | The task yielded to a prerequisite before its turn ended (or the process died first). It is not relaunched: it is marked as yielded and moved to `queued`, and starts again when its dependencies are completed. |
| `queued` with a yield marker | Starts as a resume: the integration branch is merged into its worktree and a fresh session (same attempt) is told what the prerequisites produced. See ORCHESTRATION.md, Yield and resume. |

Tasks in `ready` or `queued` are scheduled normally; `blocked` and `failed` tasks wait for you. A run recovered from
`planning` plans again (in consensus mode the earlier candidates and critique are replaced by the new round); one recovered from `awaiting_approval` re-creates the plan approval if it is
missing. Mission verification runs again if the run was finalizing.

## Session resume versus a fresh session with handoff

`resumableSession(taskId)` looks at the task's latest implementing or repairing agent (reviews and
verifications are excluded) and its latest session record.

- If that session has an SDK session id and ended for a resumable reason (`paused`, `quota`, `auth`,
  `app_restart`, `shutdown`), NEXUS resumes it with `resume: <session id>` and the prompt "Continue the
  task from where you stopped. Check `git status` and `git log` first to see what is already done." followed
  by any messages (user instructions included) that were not delivered while no session could take them. The
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
- A startup failure of the runtime (database cannot be opened, schema newer than the app) ends the runtime process with
  the error in `<data>/runtime/runtime.log`; the runtime has no window to show it in, and the window does not get a
  connection. A startup failure of the window itself shows an error dialog and exits.
- A runtime of another NEXUS version that is still running is asked to stop by a newer window, which then starts its
  own; its work is recovered by the steps above. A runtime that speaks another protocol version is not talked to
  (`INCOMPATIBLE`).

## Overnight runs (0.2.1)

An overnight run is recovered by its supervisor, not through the recovery dialog: `runs.recoverable` leaves
out runs with a live overnight record. What happens on the next start depends on how long NEXUS was away
and whether Windows restarted; the table is in [OVERNIGHT_MODE](OVERNIGHT_MODE.md), "Restart of NEXUS or
Windows". In short: a short absence resumes the run and leaves the Windows failsafe as it is; a long absence
or a restart of Windows ends the unattended session without a power action, asks Windows to drop any
pending shutdown, and leaves the run paused for a manual resume. A step interrupted by a crash (arming,
cancelling, scheduling the final timer, finalizing) is completed on the next start.
