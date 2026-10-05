# Control Plane

The 0.7 feature set puts one queue and one division of capacity above every kind of workload NEXUS runs, inside a
runtime process that outlives the window. This document describes what is implemented on the `nexus-0.7` branch
and, as plainly, what is not. 0.7 is not released: see `V0_7_RELEASE_REPORT.md`. The design text is
`V0_7_DESIGN.md`; the process model is in `ARCHITECTURE.md`.

Source: `src/shared/control-plane.ts` (the model and the pure decisions), `src/main/modules/control-plane/`
(`service.ts`, `adapters.ts`, `notifier.ts`), `src/main/runtime/core.ts` (where it is wired), `src/main/modules/ipc/v7-handlers.ts`
and `v7-security-handlers.ts`, `src/renderer/src/views/control/`.

## Where it runs

The control plane runs in the **runtime process** (`nexus-runtime`), not in the window. Closing the window ends the
window's process only; the queue, the schedules, the engines and the agent sessions go on. The runtime is started by
the window when none answers, keeps its own tray icon, and stops when you choose "Stop NEXUS" or by itself after
two minutes with nothing to do (see "The runtime process" below). The window is a client: everything it shows is
read from the runtime again after a reconnect.

## What exists

### The global queue

Everything that uses agents is a work item in one queue:

| Type | What it stands for | How it gets on the queue |
|---|---|---|
| `mission` | A run started from the composer | Adopted automatically while it works |
| `program` | A program | Put on the queue from the Control Center or by a schedule, or adopted when started from its page |
| `arena` | An Arena campaign | By a schedule or `control.enqueue`, or adopted when started from its page |
| `workspace_mission` | A cross-repository mission | By a schedule or `control.enqueue`, or adopted when started from its page |
| `scheduled_audit` | A read-only background analysis | By a schedule or `control.enqueue` |
| `background_job` | The same adapter as `scheduled_audit` | Nothing creates one in 0.7 (see "What does not exist") |

An item has a priority (`P0` most urgent to `P3`), a position that is stored (the order you set survives a
restart), and a state: `QUEUED`, `READY`, `RUNNING`, `PAUSED`, `QUOTA_WAIT`, `BLOCKED`, `SCHEDULED`, `FINALIZING`,
`COMPLETED`, `FAILED`, `CANCELLED`. `FINALIZING` is in the model; no adapter reports it (see "What does not exist").

The control plane keeps no second truth about a workload. On every pass (every two seconds, and when the usage
state changes) it reads each open item's workload through an adapter and sets the item's state from what the
workload's own engine says. Starting, pausing, resuming and cancelling go through the same engines as the
pages do.

A workload that was started from its own page instead of the queue is adopted as a `RUNNING` item on the next
pass, so the capacity below covers everything however it was started (missions, programs, Arena campaigns and
workspace missions; see "What does not exist" for background jobs).

### Capacity

Two limits apply across all workloads: agent sessions at once (default 6) and workloads at once (default 4).
`allocate()` in `src/shared/control-plane.ts` divides the capacity; it is a pure function. The full description is in
`GLOBAL_SCHEDULER.md`.

- Sessions that are running are never stopped. Capacity is what is free beside them.
- Free capacity goes to items in service order: priority, then the earlier deadline, then your order, then age. A
  queued `P0` item is therefore served before a running `P2` item gets another session. The lower-priority work
  keeps what it runs and gets nothing new until the higher priority has what it asked for.
- **Aging.** A waiting item is served one priority higher for every `agingMinutes` (default 30) it has waited without
  starting, so a stream of urgent work delays lower-priority work but cannot keep it out for good. With the default,
  a `P3` item is served as `P0` after 90 minutes. `0` switches aging off. It changes the order only; the item keeps
  its own priority.
- **Dispatch pause.** You can pause dispatch (the tray, or the Control Center): what runs keeps running, nothing new
  starts and no more capacity is granted. The setting is stored, so it survives a restart of the runtime.
- A queued item starts only when at least one session can be granted to it and a workload slot is free.
- While Claude is unavailable (the usage gate is closed) nothing starts and nothing more is granted. Items
  whose workload waits for the limit show `QUOTA_WAIT`. After the reset the next pass grants and starts again.

The grant reaches the orchestrator through its dispatch gate: for each run, `limit(normal, runId)` is the
smaller of the run's own limit, the usage ramp, and what the run's work item was granted less what the item's
other runs use. A run that no item owns yet keeps its own limit until it is adopted. A run that has no capacity and
runs no session of its own waits behind a closed gate instead of being judged stuck.

Agent sessions run in worker processes (see `WORKERS.md`). The runtime keeps at most `maxAgents + 1` workers.

### Decisions are recorded

When the answer for an item changes (started with n sessions, may hold n, or waiting because ...), one row goes to
`scheduler_decisions` (`ADMIT`, `GRANT` or `WAIT`, with the sentence). The Control Center's inspector shows the
newest 25 for the item. A row is written when the answer differs from the last one this runtime process recorded, so
a restart of the runtime records the first answer of each open item again.

### Schedules

A schedule fires daily at a time, weekly on a day at a time, or once, in the computer's local time, and puts
its work on the queue: continue a program, run an Arena campaign, continue a workspace mission, or run a
background analysis. Schedules are stored in the database and are fired by the runtime's pass whether or not a
window is open.

- **An occurrence fires once.** It is claimed in `schedule_firings` (primary key: schedule and occurrence) in the same
  database transaction that queues the work and moves the schedule to its next time. After a crash at any point an
  occurrence has fired once or not at all, never twice. The firing record keeps the item it queued and the result.
- A schedule that was due while no runtime was running fires once when a runtime is running again, not once per
  missed time.
- A schedule whose work is already on the queue queues nothing and says so in "Last time".
- A schedule that cannot queue its work records why, writes an incident and keeps its next time. It does not retry in
  a loop.
- A one-time schedule switches itself off after it fired.

Schedules fire only while a runtime process runs. The runtime stays running without a window while at least one
schedule is switched on, but nothing starts it at Windows sign-in (see "What does not exist").

### Runtime health

Nine components report a level (`HEALTHY`, `DEGRADED`, `RECOVERING`, `BLOCKED`) and a sentence of evidence:
`database` (a query is run), `scheduler` (whether its passes run), `workers` (the worker manager), `providers`,
`git`, `usage`, `power_supervisor`, `ipc` (windows connected over the local pipe) and `schedules` (overdue
schedules). The runtime is as healthy as its worst component. A check that throws is `DEGRADED` with the error; a
failed pass of the scheduler is `DEGRADED` until the next pass succeeds. The `git` line is a statement, not a
probe, in 0.7; the `ipc` line states what is connected, it does not test the pipe.

### The runtime process

`runtime.status` reports the runtime's identity (version, protocol, pid, boot id), its phase (`RECOVERING`, `READY`,
`STOPPING`), how many windows and tool clients are connected, whether dispatch is paused, whether the endpoint
file's access list could be narrowed, and why it stays alive (a window is connected, an overnight run is active, a
run is working, work is on the queue, a schedule is switched on, or it is recovering).

With none of those reasons for two minutes, the runtime stops by itself. Choosing "Stop NEXUS" (tray, or Runtime
diagnostics, channel `runtime.stop`) stops it after asking when work is active. `RECOVERY.md` and
`OVERNIGHT_MODE.md` describe what closing, stopping and restarting mean for work in progress.

### Restart and recovery

The queue, its order, the limits, the dispatch pause and the schedules are in the database. When a runtime starts:

1. Before anything can dispatch: workers and leases of the earlier start are marked stale (nothing is killed by
   process id), runs that were active are paused with reason `recovery` and not judged, and tool approvals nobody
   waits for are expired.
2. The runtime reports phase `RECOVERING` with counts (interrupted runs, stale workers, stale leases) while the
   engines recover in the background: Arena campaigns, background jobs, programs, workspace missions. The window shows
   the phase and stays usable.
3. The control plane then records an incident ("NEXUS started; N open work items read from the queue") and reads
   every open item against its workload. Programs, workspace missions and Arena campaigns continue by their own
   recovery rules. A plain mission is paused by the orchestrator; it is resumed by the control plane only when
   "Resume missions after NEXUS restarts" is on (`resumeOnBoot: resume`; the default is `hold`), and never when you
   had held it.
4. The overnight supervisor recovers its run and checks its Windows failsafe.
5. The phase becomes `READY`, and, when anything had to be reconciled, an incident records the counts.

### Notifications

Native notifications are shown by the runtime process (there is no window to show them). The kinds that are wired:

| Kind | When |
|---|---|
| `work_item_failed` | A work item failed |
| `program_blocked`, `workload_blocked` | A program, or another workload, became blocked |
| `quota_paused`, `quota_resumed` | A wait for the Claude usage limit began, and ended |
| `schedule_started` | A schedule queued work |
| `milestone_completed` | A program milestone completed; milestones that were complete before this start of the runtime are not announced |
| `arena_regression` | An Arena campaign completed and found at least one regression |
| `overnight_completed` | An overnight run ended (its report was written), however it ended |
| `security_high` | The execution policy refused a tool call (decision `DENY`); the text points to the security decisions in the Control Center. The name is the model's: it is raised for every refusal, not by a severity |

Two notifications of one kind about one subject within ten minutes are one, and at most four notifications of any kind
are shown in a quarter of an hour. Nothing is shown with the scripted runtime. A notification is shown only by the
Electron host of the runtime; the plain Node host used in tests shows none.

### The runtime tray

The tray icon belongs to the runtime and exists while the runtime does, whether or not a window is open. It shows
how many workloads run and wait, how many agents are active, and a warning when work is blocked or the runtime's
health is degraded or blocked (icon states `IDLE`, `RUNNING`, `PAUSED`, `ATTENTION`, `RECOVERING`). The menu has Open
NEXUS, Open Control Center, Pause or Resume dispatch, and "Stop NEXUS..." (asks first). During an overnight mission
the tray shows that mission, as since 0.2, with the runtime's entries below. Double-clicking opens the window. Automated
runs with `NEXUS_WINDOW_OFFSCREEN=1` show no tray icon.

### Control Center

The Control Center page shows the health badge and the nine components, the capacity line and the limits (agents,
workloads, aging, resume after a restart), the dispatch state with a button to pause or resume it, the number of
worker processes, the active items with their sessions and grant, the waiting items in the order they will start with
the reason each waits, the schedules, the recently finished items and the recent incidents. You can change an item's
priority, move it up or down among its priority, hold and release it, cancel it, put a program on the queue, and
create, switch off and delete schedules.

- **Inspector.** Selecting an item opens a drawer with its state, why it waits or why it failed, its facts, the
  scheduler decisions recorded for it and the incidents about it.
- **Security decisions.** A card, "Why was this blocked?": the newest decisions of the execution policy (refusals,
  approval requests and allowed-with-audit commands), described in `SECURITY.md`.
- **Runtime diagnostics.** The runtime's identity and status, the worker table, recent leases and recent worker
  events (`WORKERS.md`), and "Stop NEXUS runtime...", which asks first.
- **Connection.** While the window cannot reach the runtime, the page is marked stale and cannot be operated, a banner
  says what is happening (`STARTING RUNTIME`, `CONNECTING`, `RECOVERING`, `DISCONNECTED`, `INCOMPATIBLE`) and offers
  a retry; when the runtime is back the window reads everything again.

### IPC

`control.overview`, `control.enqueue`, `control.setPriority`, `control.move`, `control.pause`, `control.resume`,
`control.cancel`, `control.setLimits`, `control.createSchedule`, `control.setScheduleEnabled`,
`control.removeSchedule`, `control.decisions`; `runtime.status`, `runtime.workers`, `runtime.tray`,
`runtime.setDispatchPaused`, `runtime.stop`; `security.decisions` (read-only, paged); and `desktop.connection` and
`desktop.reconnect`, which are answered by the window's own process because they must work when the runtime does
not. Every input is a strict schema: an item or schedule id and values from closed sets. No channel takes a
command, a path or text that is executed. The channels travel to the runtime over the authenticated local pipe
(`ARCHITECTURE.md`).

## What does not exist

Each item below was checked against the source.

- **Missions cannot be queued before they exist.** A mission is created in the composer and adopted once it runs.
  `EnqueueInputSchema` has no `mission` variant (`control-plane.ts`), and the mission adapter's `start` refuses an item
  with no run (`adapters.ts`).
- **No preemption of running sessions.** A higher priority gets the next free capacity; it does not stop sessions
  of lower-priority work. `allocate` never grants an item less than it already runs (`control-plane.ts`).
- **Provider capacity is not modelled.** The limits are two numbers (`maxAgents`, `maxActiveItems`); there is no
  per-provider cap. A session of another provider counts against `maxAgents` like a Claude session.
- **Work of another provider does not continue during a Claude usage wait.** The usage gate closes dispatch for every
  run and `allocate` grants and starts nothing while it is closed (`core.ts` dispatch gate, `service.ts`).
- **A run paused for the usage limit is paused as a whole.** The queue gates sessions only, but a quota pause is a
  pause of the run (`pauseRun(runId, 'quota')`), so that run's own verification and integration steps wait with it.
- **`FINALIZING` is never reported.** It is in the state model, but no workload adapter returns the `finalizing`
  phase (`adapters.ts`), so no item is shown as `FINALIZING`.
- **Home was not redesigned into the Control Center.** The Control Center is its own page; the Home view is unchanged
  from 0.6.
- **Nothing starts the runtime at Windows sign-in.** There is no startup entry, scheduled task or service. A schedule
  fires only while a runtime is running. The runtime keeps running without a window while a schedule is switched on,
  but not across a reboot or a sign-out: until NEXUS is opened once, nothing fires. A schedule that was due
  meanwhile fires once when the runtime starts.
- **Children that detach from a worker's process tree are not tracked.** A worker is ended with `taskkill /T /F`;
  there are no job objects (`WORKERS.md`).
- **The scripted runtime runs its sessions inside the runtime process** unless `NEXUS_FAKE_WORKERS=1`. The UI tests
  therefore exercise worker processes only in the tests that set it.
- **Background jobs started from their own page are not adopted.** The queue adopts missions, programs, campaigns and
  workspace missions; a background job started directly uses agent capacity that is not counted. The `background_job`
  item type has an adapter but nothing creates such an item.
- **The Control Center queues programs only.** Campaigns, workspace missions and audits are queued through
  `control.enqueue` or a schedule created through `control.createSchedule`.
- **Decision records and schedule firing records are not pruned.** `SchedulerDecisionStore.prune` and
  `ScheduleFiringStore.prune` exist, and nothing calls them (the worker history is pruned by the manager).
- **The `security_high` notification is not a severity.** It is raised for each refused tool call, restrained by the
  notification rules above.

## Tests

- `tests/integration/control-plane/control-plane.test.ts`: the queue order, the capacity example (6 agents,
  three workloads, the rest queued), priority without preemption, usage waits, workload slots, 10,000 seeded
  queues against the allocation invariants, state mapping, schedule times including a missed schedule, health,
  notification restraint; the service with scripted workloads (two kinds of workload at once, priority, quota
  wait and reset, hold, release, reorder and cancel, failures recorded once, adoption, schedules across a
  restart, queue persistence across a restart, resume after boot by limit, health degradation and recovery);
  migration 009; the channel schemas.
- `tests/integration/control-plane/scheduler-07.test.ts`: aging, dispatch pause, decision records, idempotent
  schedule firings, the schedules health component (see `TESTING.md`).
- `tests/integration/runtime/runtime-process.test.ts`: the control plane on a real runtime process: a program and an
  Arena campaign through the queue, a worker killed mid-mission, the runtime killed mid-mission, a schedule across a
  restart (see `TESTING.md`).
- `tests/stress/control-plane-stress.test.ts` and `tests/stress/control-plane-runtime-stress.test.ts`: seeded histories
  of the control plane, and of workers, leases, schedules and restarts of the runtime.
- `tests/unit/runtime/notifier-tray.test.ts`: the notifier and the runtime tray model.
- `tests/unit/renderer/control-model.test.ts`, `runtime-model.test.ts`, `connection-model.test.ts`: the sentences and
  the enabled actions of the Control Center, the runtime diagnostics and the connection banner.
- `tests/e2e/v7.spec.ts`: the Control Center on the built app with the scripted runtime (see `TESTING.md`).
