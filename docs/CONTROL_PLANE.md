# Control Plane

The 0.7 feature set puts one queue and one division of capacity above every kind of workload NEXUS runs. This
document describes what is implemented on the `nexus-0.7` branch and, as plainly, what is not. 0.7 is not
released: see `V0_7_RELEASE_REPORT.md`.

Source: `src/shared/control-plane.ts` (the model and the pure decisions), `src/main/modules/control-plane/`
(`service.ts`, `adapters.ts`), `src/main/modules/ipc/v7-handlers.ts`, `src/renderer/src/views/control/`.

## What exists

### The global queue

Everything that uses agents is a work item in one queue:

| Type | What it stands for | How it gets on the queue |
|---|---|---|
| `mission` | A run started from the composer | Adopted automatically while it works |
| `program` | A program | Put on the queue from the Control Center or by a schedule, or adopted when started from its page |
| `arena` | An Arena campaign | By a schedule or `control.enqueue`, or adopted when started from its page |
| `workspace_mission` | A cross-repository mission | By a schedule or `control.enqueue`, or adopted when started from its page |
| `scheduled_audit`, `background_job` | A read-only background analysis | By a schedule or `control.enqueue` |

An item has a priority (`P0` most urgent to `P3`), a position that is stored (the order you set survives a
restart), and a state: `QUEUED`, `READY`, `RUNNING`, `PAUSED`, `QUOTA_WAIT`, `BLOCKED`, `SCHEDULED`,
`COMPLETED`, `FAILED`, `CANCELLED`.

The control plane keeps no second truth about a workload. On every pass (every two seconds, and when the usage
state changes) it reads each open item's workload through an adapter and sets the item's state from what the
workload's own engine says. Starting, pausing, resuming and cancelling go through the same engines as the
pages do.

A workload that was started from its own page instead of the queue is adopted as a `RUNNING` item on the next
pass, so the capacity below covers everything however it was started.

### Capacity

Two limits apply across all workloads: agent sessions at once (default 6) and workloads at once (default 4).
`allocate()` in `src/shared/control-plane.ts` divides the capacity; it is a pure function.

- Sessions that are running are never stopped. Capacity is what is free beside them.
- Free capacity goes to items in queue order: priority, then the earlier deadline, then your order. A queued
  `P0` item is therefore served before a running `P2` item gets another session. This is how a higher priority
  takes dispatch capacity: the lower-priority work keeps what it runs and gets nothing new until the higher
  priority has what it asked for.
- A queued item starts only when at least one session can be granted to it and a workload slot is free.
- While Claude is unavailable (the usage gate is closed) nothing starts and nothing more is granted. Items
  whose workload waits for the limit show `QUOTA_WAIT`. After the reset the next pass grants and starts again.

The grant reaches the orchestrator through its dispatch gate: for each run, `limit(normal, runId)` is the
smaller of the run's own limit, the usage ramp, and what the run's work item was granted less what the item's
other runs use. A run that no item owns yet keeps its own limit until it is adopted.

### Schedules

A schedule fires daily at a time, weekly on a day at a time, or once, in the computer's local time, and puts
its work on the queue: continue a program, run an Arena campaign, continue a workspace mission, or run a
background analysis. Schedules are stored in the database.

- A schedule that was due while NEXUS was not running fires once when NEXUS is back, not once per missed time.
- A schedule whose work is already on the queue queues nothing and says so in "Last time".
- A schedule that cannot queue its work records why and keeps its next time. It does not retry in a loop.
- A one-time schedule switches itself off after it fired.

Schedules run only while NEXUS runs (see "What does not exist").

### Runtime health

Eight components report a level (`HEALTHY`, `DEGRADED`, `RECOVERING`, `BLOCKED`) and a sentence: database,
scheduler, agent sessions, providers, Git, usage, the overnight supervisor, and the window connection. The
runtime is as healthy as its worst component. A check that throws is `DEGRADED` with the error; a failed pass of
the scheduler is `DEGRADED` until the next pass succeeds. The Git and window-connection lines are statements,
not probes, in 0.7.

### Restart

The queue, its order, the limits and the schedules are in the database. After a restart the control plane
records an incident ("NEXUS started; N open work items read from the queue") and reads every open item against
its workload. Programs, workspace missions and Arena campaigns continue by their own recovery rules, as before
0.7. A plain mission is paused by the orchestrator at startup; it is resumed by the control plane only when
"Resume missions after NEXUS restarts" is on, and never when you had held it.

### Notifications

Native notifications are shown for: a work item that failed, a program that is blocked, a wait for the Claude
usage limit and its end, and a schedule that started work. Two notifications of one kind about one subject
within ten minutes are one, and at most four notifications of any kind are shown in a quarter of an hour.
Nothing is shown with the scripted runtime.

### Control Center

The Control Center page shows the health badge and the eight components, the capacity line and the limits, the
active items with their sessions and grant, the waiting items in the order they will start with the reason each
waits, the schedules, the recently finished items and the recent incidents. You can change an item's priority,
move it up or down among its priority, hold and release it, cancel it, put a program on the queue, and create,
switch off and delete schedules.

### IPC

`control.overview`, `control.enqueue`, `control.setPriority`, `control.move`, `control.pause`,
`control.resume`, `control.cancel`, `control.setLimits`, `control.createSchedule`,
`control.setScheduleEnabled`, `control.removeSchedule`. Every input is a strict schema: an item or schedule id
and values from closed sets. No channel takes a command, a path or text that is executed.

## What does not exist

These are requirements of 0.7 that are not implemented. Each one alone keeps 0.7 from a release.

- **No separate runtime process.** The control plane, the engines, the database and the agent sessions live in
  the Electron main process. Closing the window hides NEXUS to the tray while work is active, as since 0.2, and
  work continues; quitting NEXUS stops it. There is no daemon or user-level service, nothing starts with
  Windows, and schedules do not fire while NEXUS is not running.
- **No client and runtime boundary of its own.** The window talks to the main process over Electron IPC, as in
  every earlier version. There is no local socket or pipe, so nothing listens on the network; there is also no
  reconnecting client, no protocol version and no authentication between a client and a runtime, because there
  is no second process.
- **No worker manager.** Agent sessions run inside the main process through the provider runtimes. There are no
  worker processes, no heartbeats or leases of workers, and no recovery of a crashed worker beyond what the
  orchestrator already does for a crashed session.
- **Missions cannot be queued before they exist.** A mission is created in the composer and adopted once it
  runs. The queue cannot hold a mission that has not started.
- **No preemption of running sessions.** A higher priority gets the next free capacity; it does not stop
  sessions of lower-priority work.
- **Provider capacity is not modelled.** The capacity is one number of agent sessions. Sessions of another
  provider count against it like Claude sessions, and work for another provider does not continue during a
  Claude usage wait.
- **Home was not redesigned.** The Control Center is its own page; Home is as in 0.6.
- **Notifications for milestone completion, Arena regressions, overnight completion and high security findings**
  are not sent by the control plane.
- **The Control Center queues programs only.** Campaigns, workspace missions and audits are queued through
  `control.enqueue` or a schedule created through `control.createSchedule`.

## Tests

- `tests/integration/control-plane/control-plane.test.ts`: the queue order, the capacity example (6 agents,
  three workloads, the rest queued), priority without preemption, usage waits, workload slots, 10,000 seeded
  queues against the allocation invariants, state mapping, schedule times including a missed schedule, health,
  notification restraint; the service with scripted workloads (two kinds of workload at once, priority, quota
  wait and reset, hold, release, reorder and cancel, failures recorded once, adoption, schedules across a
  restart, queue persistence across a restart, resume after boot by limit, health degradation and recovery);
  migration 009; the channel schemas.
- `tests/unit/renderer/control-model.test.ts`: the sentences and the enabled actions of the Control Center.
- `tests/e2e/v7.spec.ts`: the Control Center on the built app with the scripted runtime: health, an adopted
  mission whose sessions never exceed the limit, a program started from the queue, limits, a schedule from the
  form, and the queue, limits and schedule after a restart.
