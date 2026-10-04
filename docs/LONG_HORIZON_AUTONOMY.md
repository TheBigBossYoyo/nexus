# Long-horizon autonomy (0.4)

How a program keeps going across usage windows, work windows, restarts and nights, and what stops it. The
program model itself is in [PROGRAMS.md](PROGRAMS.md).

## Usage limits

A program can span several Claude usage windows. A usage limit is a wait, never a failure.

| Situation | What the engine does |
|---|---|
| The current run is paused for a usage limit, or the usage dispatch gate is closed | Checkpoint. With `usageBehavior: wait` the program becomes `WAITING_FOR_QUOTA` and remembers the state to return to |
| Claude is available again | Quota recovery resumes the run (QUOTA_RECOVERY.md). The program returns to its state by itself and records `quota_resumed` |
| The wait lasts longer than `quotaWaitMaxMinutes` | `BLOCKED`, with the reason. The user resumes it |
| `usageBehavior: stop` | The program is `PAUSED` (`usage_policy`) and waits for the user. A run that quota recovery resumes meanwhile is paused again |
| The user resumes while Claude is still limited | The program becomes `WAITING_FOR_QUOTA` and continues at the reset, also under `stop`: the policy decides what happens when a limit is first met, the user decided to go on |

Waiting does not count as active time, does not consume a mission attempt and does not change the plan.

The engine does not run its own recovery. The pause, the probe and the resume of the run are those of 0.3; the
engine observes the run and the gate.

## Autonomous work windows

A schedule is a list of windows, each with the days it starts on and a local start and end time. A window
whose end is not after its start runs past midnight (`22:00` to `07:00`). Overlapping windows are merged.

With `respectWorkWindows` and at least one window:

- Outside a window nothing is dispatched.
- When a window closes the engine stops dispatching, pauses the run in flight, writes a checkpoint and sets
  the program to `PAUSED` with the reason `work_window`. The page shows when the next window opens.
- When the next window opens the program returns to its state and the same run continues.

Without windows a program works whenever NEXUS is running.

`windowStatus` is a pure function of the schedule and the local time; its tests cover midnight, the days a
window starts on, merging and the exclusive end.

## A power action at the end of a window

A program can be an overnight workload (`overnight.startProgram`). It is the third workload type next to a
mission and an Arena campaign, under the same supervisor: explicit authorization, a hard deadline, the
failsafe armed before the program continues, a report, and the end action (`NONE`, `SHUTDOWN`, `SLEEP`,
`HIBERNATE`).

- The overnight deadline is the end of the window. At the deadline the program is paused, checkpointed and
  reported, then the policy for `TIME_LIMIT` decides the power action.
- A program that completes, fails, is blocked or needs an approval during the window ends the window early with
  the matching terminal reason. Nobody is there to approve a plan overnight, so a program that asks for
  approval ends the window as `BLOCKED`.
- The end of a window is not the end of the program. It continues in the next window or when resumed.

The engine and its agents never call the power controller. Only the supervisor does, as before.

## Restart

See PROGRAMS.md, "Restart". A program is rebuilt from its tables; the checkpoint is a record of where it stood,
not the source of truth. The engine's own state is the current run id and kind on the program row, so a
restart between two steps resumes at the step that was not finished: a milestone in `VERIFYING` without a run
is verified again, a milestone `ACTIVE` without a run is made `READY`.

## What stops a program

| Stop | State | To continue |
|---|---|---|
| A plan waits for approval | `PAUSED` (`approval`) | Accept or reject the plan |
| The user paused it | `PAUSED` (`user`) | Resume |
| Outside a work window | `PAUSED` (`work_window`) | Continues by itself |
| Usage limit with `stop` | `PAUSED` (`usage_policy`) | Resume |
| Restart, cautious policy | `PAUSED` (`restart`) | Resume |
| Usage limit with `wait` | `WAITING_FOR_QUOTA` | Continues by itself |
| No valid plan after a retry | `BLOCKED` | Resume plans again |
| A milestone could not be verified | `BLOCKED` | Resume verifies again |
| A milestone used all its missions and no reassessment remains | `BLOCKED` | Resume gives it another round |
| A budget ran out (missions, active time) | `BLOCKED` | Resume; the budget is the policy's |
| An internal error of the engine | `BLOCKED`, with the error | Resume |
| The current run needs a person | `BLOCKED` | Deal with the run, then resume |

## Decision trail and checkpoints

Every transition the engine makes is recorded in `program_decisions` with a kind, a one-line summary and the
milestone and run it concerns: created, plan proposed, accepted or rejected, milestone started, mission
generated and ended, milestone accepted, rejected or blocked, reassessment requested or kept, paused, resumed,
quota wait and resume, window closed and opened, blocked, recovered, budget, completed, failed, cancelled.

Checkpoints are written at a plan change, an accepted or rejected milestone, a failed mission, a pause, a
block, a usage wait, a recovery and the end. The newest 100 are kept.

## Tests

- `tests/unit/program/program-model.test.ts`: state machines, policy presets, work windows, plan schema and
  structure, plan diff, prompts and parsing, memory selection and validation.
- `tests/integration/program/engine.test.ts`: the engine on a real Git repository and database with a
  stand-in for the orchestrator. Multi-milestone completion, gate rejection, verifier rejection with backlog
  and memory, failed mission to backlog and a stored revision, plan approval, usage wait and resume, the
  closed gate, the stop policy, an endless wait, restart in the middle of a mission and of a verification,
  work windows, selective memory, refused memory, unreadable plans, budgets, user actions, strategy per mission.
- `tests/scenarios/v4-program.test.ts`: a program on the real orchestrator with the scripted runtime.
- `tests/integration/program/background-overnight.test.ts`: background engineering, a program under the
  overnight supervisor (window end, blocker, usage limit, authorization), migration 006.
- `tests/stress/program-stress.test.ts`: seeded histories with random answers, outcomes, limits, user actions
  and restarts, checking the invariants after every step (300 seeds in `pnpm test`; `NEXUS_PROGRAM_STRESS_RUNS`
  selects more).

## Not verified

- A program that actually spans two real usage windows. The wait and resume were exercised with the stand-in
  and the scripted runtime.
- A program under the overnight supervisor with a real power action.
