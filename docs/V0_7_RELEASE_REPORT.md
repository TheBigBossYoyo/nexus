# NEXUS 0.7 Release Report

Date: 2026-10-05. Branch `nexus-0.7` (from `nexus-0.6`). `package.json` says 0.6.0: the version was not
raised to 0.7.0. **Not merged into `main`, not tagged.**

## Verdict

**PARTIAL. 0.7 is not released.**

0.7 was to turn NEXUS into a persistent local runtime with the desktop window as a client. What was built in
the time available is the control plane's core inside the existing process. What makes 0.7 what it is, a runtime
that is a process of its own, was not built. A release needs every item of the gate; several are missing, so
the branch stays a branch.

| Gate item | State |
|---|---|
| Persistent local runtime (a process separate from the window, user level) | **NOT IMPLEMENTED.** The control plane lives in the Electron main process. Closing the window hides NEXUS to the tray while work is active, as since 0.2; quitting NEXUS stops everything |
| Secure UI and runtime boundary (authenticated, versioned, reconnecting) | **NOT IMPLEMENTED** as a boundary of its own. The window uses Electron IPC with strict schemas, as before; nothing listens on the network |
| Global scheduler | **Implemented and tested.** One allocation of agent capacity across every workload, through the orchestrator's dispatch gate |
| Job queue | **Implemented and tested.** Six work item types, P0 to P3, ten states, persisted order; missions cannot be queued before they exist |
| Worker manager (worker processes, heartbeats, leases, crash recovery) | **NOT IMPLEMENTED.** Sessions run inside the main process |
| Restart recovery | **Implemented and tested** for the queue, limits and schedules; workloads continue by their own recovery rules; a plain mission is resumed only by setting |
| Schedules | **Implemented and tested.** Daily, weekly, once; stored; a missed one fires once. They run only while NEXUS runs |
| Notifications | **Partly.** Failed work, blocked programs, usage wait and its end, schedule start, with restraint rules. Not: milestone completed, Arena regression, overnight completed, high security finding |
| Global quota handling | **Implemented and tested.** While Claude is unavailable nothing starts and nothing more is granted; waiting items show it; the reset resumes. Work of another provider does not continue during a Claude wait |
| Control Center | **Partly.** Its own page with health, capacity, queue, schedules, finished work and incidents. Home was not redesigned into it |
| Tests | 21 integration tests including 10,000 seeded allocations; 4 model tests; see below |
| Stress | 5000 seeded histories of the control plane passed; a mutation that broke the capacity rule was caught by it |
| E2E | 1 test on the built app passed |
| Package | **NOT DONE** for 0.7 |
| Real acceptance (real Claude, two concurrent workload types) | **NOT DONE** |
| Security audit of 0.7 | The readiness security review read the 0.7 code (see `ONE_DOT_ZERO_READINESS.md`); there was no audit of 0.7 as a release candidate |

## What exists

See `CONTROL_PLANE.md`, which lists what is implemented and what is not. In short: `src/shared/control-plane.ts`
(work items, the pure `allocate`, schedules, health, notification restraint), `src/main/modules/control-plane/`
(`ControlPlane`, adapters for missions, programs, Arena campaigns, workspace missions and background audits),
migration 009 (three tables), the `control.*` channels, the Control Center page.

How capacity is enforced: for every run the orchestrator asks its dispatch gate how many sessions the run may
hold; the gate answers with the smaller of the run's own limit, the usage ramp and what the run's work item was
granted. Running sessions are never stopped; free capacity goes to the higher priority first.

## Test results

Commit under test: `95debd5` (the commit that carries this report adds documents only).

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm test` | 141 files, 2688 tests passed, 333 s |
| Control plane tests | 22 integration tests including 10,000 seeded allocations; 4 model tests |
| Control plane stress, 5000 histories | passed, 472 s |
| `pnpm test:e2e` | 25 of 25 passed (1 capture-only test skipped by design), 8.2 min, run in the continuation |
| Migration campaign (development build, nine real databases 0.1 to 0.6) | 9 of 9 checks on each of nine databases, the 0.6 one holding a real mission with a Codex review (`migration-campaign-2026-10-05T19-37-27-463Z.json`; a run minutes earlier is kept too: it counted a newly registered Arena case version as a changed table) |
| `pnpm stress` at 1000 seeds for the whole of 0.7 | NOT RUN |
| `pnpm package`, packaged validation | NOT RUN for 0.7 |
| Real acceptance | NOT RUN |

The first full E2E run of 0.7 failed four tests, all of them "a run is resumed and must complete" (after a
restart, after a usage wait, in an overnight run). The queue still saw the resumed run as paused and answered
that it may hold no session; the orchestrator took that for a run that cannot make progress and paused it
again. Fixed: a run with no capacity waits behind a closed gate, and a resumed run is answered from the
present state. Without the E2E this would have shipped: the control plane's own tests and its 5000 histories
did not contain an orchestrator.

## Open findings of the UI review of the Control Center

An independent review read the page after it was built. Not fixed:

- HIGH: "Cancel" on a running workload and "Delete" on a schedule act at once, without confirmation.
- HIGH: when the overview cannot be loaded, the error is shown beside "Loading the queue" for good, with no
  retry.
- HIGH: a blocked or failed item cannot be opened from the queue; the only action offered for a blocked item is
  Cancel.
- MEDIUM: no announcement for screen readers when the queue changes; "Hold", "Pause", "Release" and "Resume"
  for one idea; a running item with no session yet reads "0 agents running"; health details in developer
  wording; the schedule form sets no priority and can only schedule programs; Home says nothing about the
  queue.

## What a release of 0.7 still needs

1. A runtime process of its own (a background process at user level, started at sign-in or on demand), owning
   the database, the engines, the sessions and the schedules, with the window as a client.
2. A local IPC boundary between the two: a named pipe scoped to the user, authenticated, versioned, with the
   existing strict schemas, reconnecting, and no network listener.
3. A worker manager: sessions in worker processes with heartbeats and leases, so that a crashed worker does not
   take the runtime with it.
4. The same test list as the brief: client reconnect, window closed while work continues, runtime restart,
   worker crash; a real run with two workload types at once; package and packaged validation; a security audit
   of the new attack surface.
5. Queued missions, provider capacity, the remaining notifications, Home as the Control Center.

None of this is a small change to what exists. The control plane was written so that it does not care which
process it lives in (its dependencies are interfaces), which is what item 1 needs first.
