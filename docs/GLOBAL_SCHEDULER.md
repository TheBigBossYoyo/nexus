# Global Scheduler

Part of NEXUS 0.7.0 (`V0_7_RELEASE_REPORT.md`). The
whole control plane is described in `CONTROL_PLANE.md`; this page is about the one decision the scheduler makes,
the order in which it makes it, and what it records.

## The decision

`allocate(input)` in `src/shared/control-plane.ts` is a pure function. Its input is the open work items, the number
of agent sessions each one runs now, the limits (agent sessions at once, workloads at once, aging minutes), whether
Claude is available, whether dispatch is paused, and the present time (for aging). It returns:

- `allowance`: for each live item, how many sessions it may hold now;
- `admit`: the queued items to start now, in order;
- `waiting`: for each queued item that is not started, the reason shown to the user;
- `free`: the capacity left.

It runs inside the **runtime process**, in the control plane's pass (every two seconds, and when the usage state
changes). It does not depend on a window: the scheduler runs whenever a runtime process runs.

## Service order

Free capacity is handed out in service order (`serviceOrder`):

1. the effective priority (the item's priority raised by aging, below), `P0` first;
2. the earlier deadline (an item without a deadline after one with);
3. the position the user set;
4. age: the item created earlier;
5. the item id, so that equal items are ordered the same way every time.

The function is deterministic: the same items and the same time give the same order and the same answer.

## Aging

A waiting item is served one priority higher for every `agingMinutes` it has waited without starting (default 30,
settable from 0 to 1,440; 0 switches aging off). `effectivePriority` counts whole periods since the item was
created, and never goes above `P0`.

Aging applies only to an item that has never started and is `QUEUED` or `READY`. A running item, a paused item and an
item that already started keep their own priority. The waiting time counts from the item's creation, not from a
later change of its priority.

Worked numbers with the default of 30 minutes, for an item of priority `P3` created at time 0:

| Waited | Served as |
|---|---|
| 0 to 29 minutes | `P3` |
| 30 minutes | `P2` |
| 60 minutes | `P1` |
| 90 minutes or more | `P0` |

A `P1` item is served as `P0` after 30 minutes. Aging is a change of order only: the item still shows its own
priority, and aging never lets an item take a session from running work (rule 2 below). It means that a steady
stream of urgent items delays a `P3` item but cannot keep it out for ever: once it has aged to the priority of the
newcomers, the tie is broken by deadline, then position, then age. In the seeded test (one agent, a fresh `P1` item
every ten minutes) the `P3` item starts between 60 and 120 minutes after it was queued; without aging it never does.

Limits stored before aging existed are read with the default of 30.

## The rules

1. Service order is as above.
2. Running sessions are never taken away. The free capacity is the limit less everything that runs.
3. Free capacity is handed out in service order, to running and queued items alike, in one pass. A queued `P0` item
   is served before a running `P2` item gets another session.
4. A queued item starts only when at least one session can be granted to it and a workload slot is free.
5. An item the user holds is neither granted nor started.
6. While Claude is unavailable nothing starts and nothing more is granted.
7. While dispatch is paused nothing starts and nothing more is granted. What runs keeps running.

Worked example, with 6 agents: a program asking for 3 at `P1`, a workspace mission asking for 2 at `P1`, an
Arena campaign asking for 3 at `P2`, and other work at `P3`. The program holds 3, the mission 2, the campaign 1,
and the other work waits with "Waiting for agent capacity: higher-priority work is active (P1 "...")".

## Dispatch pause

You can pause dispatch from the tray (Pause dispatch) or the Control Center (`runtime.setDispatchPaused`). While it is
paused, `allocate` grants nothing more and starts nothing. What runs keeps running and keeps the sessions it has.
The setting is stored in the database, so it survives a restart of the runtime, and pausing and resuming are
written as incidents. Resuming starts what waited.

## The waiting reasons

`allocate` produces these sentences for a queued item that is not started, checked in this order:

| Situation | Reason |
|---|---|
| Dispatch is paused | `Dispatch is paused. Nothing new starts until you resume it.` |
| Claude is unavailable | `Waiting for the Claude usage limit to reset.` |
| No workload slot is free | `Waiting for a workload slot (<n> run at once).` |
| No agent capacity, and an item of higher priority holds or was granted capacity | `Waiting for agent capacity: higher-priority work is active (<priority> "<title>").` |
| No agent capacity otherwise | `Waiting for agent capacity (<n> agents in use or reserved).` |

The Control Center adds three more for items `allocate` does not consider: `Held by you.`, the workload's own
sentence for a paused or blocked item, and `Next in the queue.` for a queued item that has no reason to wait.

In the priority comparison of the fourth row, `allocate` uses the item's own priority, not the aged one.

## Decision records

Whenever the answer for an item changes, the control plane writes one row to `scheduler_decisions` (migration 010):

| Decision | When | Reason text |
|---|---|---|
| `ADMIT` | The item was started | `Started with <n> of <m> agent(s) at <priority>.` |
| `GRANT` | A live item may hold more or fewer sessions | `May hold <n> of <m> agent(s).` |
| `WAIT` | A queued item waits | the sentence from `allocate` |

A row is written only when the decision and the sentence differ from the last one this runtime process recorded for
the item, so a steady state writes nothing. The Control Center's inspector shows the newest 25 rows of an item
(`control.decisions`). Nothing prunes the table in 0.7.

## How a grant reaches a run

The orchestrator asks its dispatch gate, for every run, how many sessions that run may hold. The gate answers
with the smallest of: the run's own limit, the usage ramp after a limit, and the grant of the work item that
owns the run less what the item's other runs use. When an allocation changes, the runs are ticked so that freed
capacity is used at once. A run that no item owns yet keeps its own limit until the next pass adopts it. The
question is answered from the present state, because it is often asked at the moment a run was just resumed.

The sessions themselves run in worker processes; the runtime keeps at most `maxAgents + 1` of them (`WORKERS.md`).

## What it does not do

- It does not stop sessions. A limit lowered below what runs takes effect as sessions end.
- It does not model providers. Capacity is one number; a session of another provider counts like a Claude one, and
  work of another provider does not continue while the Claude usage gate is closed.
- It does not know costs or deadlines of tasks inside a workload; deadlines are per work item.
- It does not run while no runtime process runs. Nothing starts the runtime at Windows sign-in; see
  `CONTROL_PLANE.md`.

## Evidence

10,000 seeded queues against the rules above (never more granted than free, never a running session taken,
priority order, slots, held items, determinism); 5,000 seeded histories of the whole control plane with
scripted workloads; one test on the built app in which a mission's sessions are counted against a limit of 3
and never exceed it. A deliberate error in rule 2 was caught by the histories within five seeds. For 0.7:
`tests/integration/control-plane/scheduler-07.test.ts` covers aging (including a stream of higher-priority arrivals
that does not starve a lower one), dispatch pause, decision records and schedule firings. Counts of the latest
measured run are in `V0_7_RELEASE_REPORT.md`.
