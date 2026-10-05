# Global Scheduler

Part of the 0.7 feature set on the `nexus-0.7` branch, which is not released (`V0_7_RELEASE_REPORT.md`). The
whole control plane is described in `CONTROL_PLANE.md`; this page is about the one decision the scheduler makes.

## The decision

`allocate(items, active, limits, claudeAvailable)` in `src/shared/control-plane.ts` is a pure function. It takes
the open work items, the number of agent sessions each one runs now, the two limits (agent sessions at once,
workloads at once) and whether Claude is available, and returns:

- `allowance`: for each live item, how many sessions it may hold now;
- `admit`: the queued items to start now, in order;
- `waiting`: for each queued item that could start but for capacity, the reason shown to the user;
- `free`: the capacity left.

## The rules

1. Queue order is priority (`P0` first), then the earlier deadline, then the position the user set, then age.
2. Running sessions are never taken away. The free capacity is the limit less everything that runs.
3. Free capacity is handed out in queue order, to running and queued items alike. A queued `P0` item is served
   before a running `P2` item gets another session.
4. A queued item starts only when at least one session can be granted to it and a workload slot is free.
5. An item the user holds is neither granted nor started.
6. While Claude is unavailable nothing starts and nothing more is granted.

Worked example, with 6 agents: a program asking for 3 at `P1`, a workspace mission asking for 2 at `P1`, an
Arena campaign asking for 3 at `P2`, and other work at `P3`. The program holds 3, the mission 2, the campaign 1,
and the other work waits with "Waiting for agent capacity".

## How a grant reaches a run

The orchestrator asks its dispatch gate, for every run, how many sessions that run may hold. The gate answers
with the smallest of: the run's own limit, the usage ramp after a limit, and the grant of the work item that
owns the run less what the item's other runs use. When an allocation changes, the runs are ticked so that freed
capacity is used at once. A run that no item owns yet keeps its own limit until the next pass adopts it.

## What it does not do

- It does not stop sessions. A limit lowered below what runs takes effect as sessions end.
- It does not model providers. Capacity is one number; a session of another provider counts like a Claude one.
- It does not know costs or deadlines of tasks inside a workload; deadlines are per work item.
- It runs inside the NEXUS process. There is no scheduler when NEXUS is not running.

## Evidence

10,000 seeded queues against the rules above (never more granted than free, never a running session taken,
priority order, slots, held items, determinism); 5,000 seeded histories of the whole control plane with
scripted workloads; one test on the built app in which a mission's sessions are counted against a limit of 3
and never exceed it. A deliberate error in rule 2 was caught by the histories within five seeds.
