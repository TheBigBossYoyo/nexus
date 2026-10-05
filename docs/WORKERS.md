# Workers

Part of the 0.7 feature set on the `nexus-0.7` branch, which is not released (`V0_7_RELEASE_REPORT.md`). This page
describes the worker manager as it is implemented, and what it does not do. The design is in `V0_7_DESIGN.md`
section 5.

Source: `src/shared/workers.ts` (states, transitions, records), `src/main/modules/workers/` (`manager.ts`,
`protocol.ts`, `hosted-runtime.ts`, `probe-script.ts`), `src/main/worker.ts` (the worker process),
`src/main/modules/persistence/migrations/010-workers.ts` and `repositories/workers.ts` (storage),
`src/main/runtime/core.ts` (where the manager is wired in).

## What a worker is

A worker is a process of its own that runs **one** agent session at a time on behalf of the runtime process. It is
the NEXUS executable run as Node (`ELECTRON_RUN_AS_NODE`) on `out/main/worker.js`, started with `child_process.fork`
by the runtime, so a packaged app needs no second binary. The three process roles of 0.7 are described in
`ARCHITECTURE.md`; a worker is the third. Under the worker is the provider process as before: `claude.exe` started by
the Agent SDK, or one `codex exec` per turn.

A worker opens no database, listens on nothing and holds no credentials of its own. The runtime hands it the session
specification as data (`WireSessionSpec`: prompt, role, working directory, tool list, model and so on). The
callbacks of the specification (the authorizer, the approval request, the NEXUS tools) stay in the runtime.

Which sessions run in workers:

- Real provider sessions (Claude, Codex) always run in workers.
- With the scripted agent runtime (`NEXUS_FAKE_RUNTIME=1`, unpackaged builds only) sessions run inside the runtime
  process, because the scripted runtime's simulated account is shared by all sessions. `NEXUS_FAKE_WORKERS=1`
  puts scripted sessions into workers; `NEXUS_FAKE_WORKERS_SCRIPT=probe` picks the probe script
  (`core.ts` `useWorkers`, `workerConfig`).
- Questions about the account, the models and the plan windows are answered by the runtime itself; they start no
  session and hold no work (`hosted-runtime.ts`).

The runtime keeps at most `maxAgents + 1` worker processes (`core.ts`: one per agent session the queue may run, and
one more for probes and reasoning sessions). A session beyond the limit waits for a worker.

## States and transitions

States: `STARTING`, `IDLE`, `ASSIGNED`, `RUNNING`, `DRAINING`, `STOPPING`, `STOPPED`, `FAILED`, `RECOVERING`.
The table is `WORKER_TRANSITIONS` in `src/shared/workers.ts`; the manager refuses a transition outside it and logs
the refusal.

| From | May go to |
|---|---|
| `STARTING` | `IDLE`, `FAILED`, `STOPPING`, `STOPPED`, `RECOVERING` |
| `IDLE` | `ASSIGNED`, `DRAINING`, `STOPPING`, `STOPPED`, `FAILED`, `RECOVERING` |
| `ASSIGNED` | `RUNNING`, `IDLE`, `STOPPING`, `STOPPED`, `FAILED`, `RECOVERING` |
| `RUNNING` | `IDLE`, `DRAINING`, `STOPPING`, `STOPPED`, `FAILED`, `RECOVERING` |
| `DRAINING` | `STOPPING`, `STOPPED`, `FAILED`, `RECOVERING` |
| `STOPPING` | `STOPPED`, `FAILED` |
| `RECOVERING` | `STOPPED`, `FAILED` |
| `STOPPED`, `FAILED` | nothing: an ended worker never comes back |

The usual path is `STARTING` (the process was forked) to `IDLE` (it reported `ready` and which providers it can run)
to `ASSIGNED` (a lease was granted) to `RUNNING` (its first event arrived) and back to `IDLE` when the session
ends. An idle worker that is asked to end goes through `DRAINING` to `STOPPING`. A worker found from an earlier
start of the runtime is marked `RECOVERING` and then `STOPPED` (see "Restart of the runtime").

Every transition is written to `worker_events` and the worker's row in `workers` is saved.

## Leases

An assignment of one agent session to one worker is a row in `worker_leases` with an expiry. States: `ACTIVE`,
`RELEASED`, `EXPIRED`, `REVOKED`.

Two partial unique indexes make the rules a property of the database and not only of the code path
(`010-workers.ts`):

- `idx_worker_leases_active_agent` on `agent_id` where `state = 'ACTIVE'`: an agent session has at most one active
  lease, so it cannot be given to two workers.
- `idx_worker_leases_active_worker` on `worker_id` where `state = 'ACTIVE'`: a worker holds at most one active lease.

If granting a lease fails (the indexes refuse it), the session ends as `crashed` with the reason. The lease is
released when the session's final event arrives, before anyone can react to the end, so a session started again
at once (a rotation) does not find its own old lease in the way.

A worker speaks only for the lease it holds: an event, a call or a result that names another lease is ignored.

## Heartbeats and timeouts

The defaults are `DEFAULT_WORKER_TIMINGS` in `manager.ts`:

| Setting | Default | Meaning |
|---|---|---|
| `heartbeatMs` | 2000 | How often a worker says that it is alive |
| `heartbeatTimeoutMs` | 20,000 | A worker that has said nothing for this long (idle, assigned or running) is taken for lost and ended |
| `leaseTtlMs` | 30,000 | How long a lease lasts beyond its last renewal |
| `idleTtlMs` | 60,000 | An idle worker is asked to stop after this long, when no session waits for a worker |
| `maxAssignments` | 25 | A worker is asked to stop and replaced after this many assignments |
| `startTimeoutMs` | 45,000 | A worker that has not reported ready after this long failed to start |
| `stopTimeoutMs` | 15,000 | How long a session may take to obey `stop` before its worker is ended |
| `tickMs` | 1000 | Interval of the manager's check (`tick()`) |

Any message from a worker counts as being heard. The lease is renewed by heartbeats, but at most once per third of
its lifetime (every 10 seconds with the defaults), so a heartbeat every 2 seconds does not write to the database
every 2 seconds. A heartbeat that finds its lease no longer active ends the worker (`Its lease had ended while it
still worked.`).

`tick()` runs every `tickMs`. It ends workers that never became ready or went silent, asks idle workers to stop,
expires every active lease whose time has passed (also when its worker is gone, so no stale lease survives), starts
workers for waiting sessions, and every ten minutes prunes old history (the newest 500 ended workers, their events,
and the newest 2,000 non-active leases are kept).

A test can lower the heartbeat limit with `NEXUS_WORKER_HEARTBEAT_TIMEOUT_MS`; the variable is read in unpackaged
builds only.

## What happens when a worker dies, hangs or is told to stop

**It dies** (the process exits or is killed from outside). The exit is noticed by the manager. The lease is revoked,
the worker becomes `FAILED` (or `STOPPED` when it was already being stopped), and the session ends with
`session.ended` reason `crashed` and the error "Worker lost: ...". The exit of a process is never read as the
completion of its work. What happens to the task is decided by the orchestrator's existing rules from what is in the
worktree, as for any crashed session: the task is retried by the existing retry rules. A waiting session gets
another worker.

**It hangs** (the process is alive and says nothing). After `heartbeatTimeoutMs` the manager ends the worker with its
process tree, expires the lease and ends the session as `crashed`.

**Its lease runs out** while the worker still holds it: the worker is ended in the same way.

**It never reports ready.** After `startTimeoutMs` the worker is failed and its session, if any, ends as `crashed`
with "It did not report ready in time."

**It is told to stop.** The session is asked to stop (`stop` command, answered by the worker). If it does not obey
within `stopTimeoutMs`, or the worker cannot answer, the worker is ended with its process tree and the session ends
as `stopped`, because cancelling must end what NEXUS started. A session that has not been given a worker yet is
removed from the queue of waiting sessions and ends as `stopped`.

**The runtime stops.** `shutdown()` ends waiting sessions as `stopped`, revokes the leases of running ones, sends
`shutdown` to every worker, waits up to eight seconds, then ends what is left with its process tree.

**A worker is asked to end while idle** (idle too long, or too many assignments): it is moved through `DRAINING` to
`STOPPING`, sent `shutdown`, and ended with its process tree if it is still there after ten seconds.

## A worker decides nothing

The session specification crosses the process boundary as data. Every tool call is sent back to the runtime
(`call` with `authorize`), which runs the policy engine and answers; the same holds for approval requests and for
the NEXUS tools the agent calls (`send_message`, `report_blocker`, `record_decision`, `propose_memory`,
`propose_graph_change`). The worker side is `toSpec` in `worker.ts`:

- A decision that cannot be obtained is a refusal. If the runtime does not answer, the tool call is denied
  ("The runtime did not answer: ...") and an approval request is answered `false`.
- The runtime checks that a call names the lease the worker holds before it runs anything.

The messages between runtime and worker are in `workers/protocol.ts`. The channel exists only between the two
processes (Node's fork channel); no socket is opened for it.

## A worker never outlives its runtime

When the process channel closes (the runtime exited or crashed), the worker stops its sessions and exits
(`process.on('disconnect')` in `worker.ts`; it waits at most five seconds for the provider runtimes to shut down).
When the runtime process is ended with its tree, as the end-to-end helper `killRuntime` does, the workers go with
it. After a restart of the runtime nothing is therefore killed by process id.

## Restart of the runtime

`WorkerManager.recoverOnBoot()` runs before anything can start a session. Workers recorded as alive by an earlier
start of the runtime (a different `boot_id`) are marked `RECOVERING` and then `STOPPED` with the error "The runtime
restarted; this worker belonged to its earlier start.", and their active leases are expired. Nothing is killed: a
process id from an earlier start may by now belong to anything. The sessions those workers ran are not judged;
the orchestrator's recovery pauses the runs with reason `recovery` and reads the worktrees when they are resumed
(`RECOVERY.md`). The counts of stale workers and leases are part of the runtime's `RECOVERING` report and of the
incident the runtime records.

When the runtime runs sessions itself (scripted runtime, no workers) the same rows are closed by the runtime at
start.

## Process trees and their limit

A worker is ended with `taskkill /pid <pid> /T /F` on its own pid, which the manager holds as a child handle, and
then `SIGKILL` if the process is still there (`forkLauncher` and `killProcessTree`). The provider process and the
shells it started are children of the worker and go with it. NEXUS kills no process it did not start.

The limit: `taskkill /T` follows the parent and child relation of the process tree. A child that detaches itself from
the tree (a process started so that it is no longer a descendant, or one that outlives its parent and is
re-parented) is not tracked and is not ended. NEXUS 0.7 uses no Windows job object; there is no code for one. Job
objects are the 0.8 direction (`WINDOWS_EXECUTION_ISOLATION.md`, `V0_8_PROPOSAL.md`).

## The worker view

The Control Center header shows how many worker processes exist and how many hold a session (or says that sessions run
inside the runtime). "Runtime diagnostics" lists the workers (worker id, pid, state, the assignment's agent and
provider, session id, last heartbeat, how long it has run, worktree, number of assignments), the recent leases (state,
agent, worker, granted, ends, reason) and the recent worker events. The channel is `runtime.workers`
(`WorkersOverview`: workers, leases, limits, counts, whether workers are enabled, events). The health component
"workers" is `DEGRADED` for five minutes after a worker failed in this start of the runtime and says that the
sessions were taken back.

## What does not exist

- A session lost with its worker is not continued by another worker mid-turn. The session ends as `crashed`; the
  orchestrator decides from the worktree what happens to the task (a new session, a new attempt).
- Child processes that detach from a worker's process tree are not tracked.
- There is no per-worker resource limit (memory, CPU, handles) and no Windows job object. A worker runs with the
  rights of the signed-in user, as does everything else.
- Workers are not a sandbox. Code that NEXUS's policy allows an agent to run runs as the user.
- The scripted runtime runs its sessions inside the runtime unless `NEXUS_FAKE_WORKERS=1`.

## Tests

- `tests/unit/workers/manager.test.ts`: the manager with scripted worker processes and a manual clock (see
  `TESTING.md` for the list).
- `tests/integration/workers/worker-process.test.ts`: a real worker process (see `TESTING.md`).
- `tests/integration/runtime/runtime-process.test.ts`: a mission in worker processes and a worker killed in the
  middle of a mission, on a real runtime process.
- `tests/stress/control-plane-runtime-stress.test.ts`: seeded histories of workers, leases, schedules and restarts of
  the runtime.
- `tests/e2e/v7.spec.ts`: worker rows in the built app.

Measured results are in `V0_7_RELEASE_REPORT.md`.
