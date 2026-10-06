# Overnight Mode (0.2.1, workloads since 0.3)

An overnight run is a MISSION run that works without anyone present and ends with a power action the
user approved for that run: shut down, sleep, hibernate, or nothing.

## Who does what

```
Claude Agent SDK ── agents (planner, workers, reviewer, verifier)
        │
NEXUS Orchestrator ── plans, schedules, reviews, repairs, verifies
        │  run events
OvernightSupervisor ── deterministic code in the NEXUS runtime process (since 0.7; the window is not involved)
        │  the only holder of
PowerController ── WindowsPowerController → System32\shutdown.exe / powershell.exe
```

Agents have no path to the power controller. It is created in `src/main/runtime/core.ts` (until 0.6, `src/main/index.ts`) and passed to the
supervisor only; no IPC handler, agent tool or MCP server holds it (`tests/unit/power/isolation.test.ts`
checks this against the source tree). An agent's shell tool cannot run power commands either: they are
`forbidden` for every role, with no approval path (see SECURITY.md, "Command classes").

## Starting a run

Mission composer → Mode **OVERNIGHT** → set the policy → tick
"I authorize NEXUS to control Windows power state for this run." → START OVERNIGHT RUN → confirm.

The confirmation is per run and is asked twice: in the composer, and then in a native Windows dialog that lists
the policy. Since 0.7 the runtime process asks and shows the dialog itself; the question never travels over the local pipe, so
neither a script in the renderer nor another client of the pipe can answer it. Where nobody can show it the answer is
no. (A program running as the same Windows user could still operate the desktop and click the dialog; the dialog is not
a boundary against that.) A later change that gives NEXUS more power (another end action, force close, more conditions)
asks the native dialog again.

`overnight.start` stores, in `overnight_runs`:

- the policy exactly as approved (`authorization.policy`; later changes are appended as amendments),
- `authorizedAt`, the run id, the confirmation sentence,
- `authorization.seal`: an HMAC over the authorization and the current policy. The key is held by the runtime
  process and kept on disk encrypted for the Windows user (`<data>/overnight.key`, Electron `safeStorage`, DPAPI). Every power decision
  verifies the seal first, so a row edited from outside NEXUS is refused: the report is written and no
  power action is taken.

**The signing key and the upgrade from 0.6.** The key is stored per profile directory, and the 0.7 runtime has its own
profile directory (`<data>/runtime-profile`). A key file written by 0.6 cannot be read by the 0.7 runtime and is
replaced. That ends the power authorization of an overnight run that was in progress during the upgrade, which is
the safe direction: the run is not given a power action it was not authorized for under the new key. When the key
store is not available, the key lives in memory and a restart of the runtime ends the power authorization in the same way.

Order at start: run row → overnight record with the authorization → failsafe timer → state `RUNNING` →
first agent session. If Windows refuses the failsafe (for example another shutdown is already scheduled),
the run is cancelled before any agent starts.

Only one overnight run can be active: Windows has a single shutdown timer.

## The policy

| Field | Default | Meaning |
|---|---|---|
| `maxDurationMinutes` | 480 | Wall-clock mission deadline |
| `endAction` | SHUTDOWN | NONE, SHUTDOWN, SLEEP, HIBERNATE |
| `shutdownOn` | all but cancellation | Which endings the end action applies to: success, failure, blocker, quotaExhausted, timeout, cancellation |
| `finalDelaySeconds` | 60 | Countdown before the end action |
| `forceCloseApplications` | false | Adds `/f`: Windows closes applications without waiting |
| `failsafeEnabled` / `failsafeAfterMinutes` | true / 540 | Windows shutdown timer armed at start; must be later than the deadline. Not armed when the end action is NONE |
| `quotaPolicy` | WAIT_AND_RETRY | or END_RUN |
| `autoApprovePlanChanges` | true | Grant task-start and graph-change approvals. Tool approvals are always denied, and so is the start of a task the planner marked high-risk |
| `budgets` | 400 sessions, 60 repairs | Exceeding either ends the run as blocked |
| `watchdog` | 30 min stall, 15 min grace | See below |
| `saveFinalReport` | true | Also write the report to `<project>/.nexus/reports/` |
| `commitCompletedWork` | true | Commit unfinished work on its task branch during finalization |
| `checkpointIntervalMinutes` | 15 | Periodic checkpoint |

Fixed, not configurable: three planner attempts; mission verification repairs are bounded by Max repairs.
Token or cost thresholds are not implemented (subscription sessions report no reliable cost).

## Facts about Windows that shape the behaviour

- `shutdown /s /t N` with N > 0 always closes applications without waiting, with or without `/f`. The
  failsafe is such a timer, so **the failsafe is always a forced shutdown**.
- A normal (non-forced) shutdown therefore cannot be a Windows timer. NEXUS counts down itself and then
  runs `shutdown /s /t 0`. The failsafe stays armed during that countdown and is replaced at the last
  moment. Applications with unsaved data can still stop a normal shutdown; then the PC stays on.
- With `forceCloseApplications`, the final shutdown is a Windows timer (`shutdown /s /f /t <delay>`), which
  also survives a crash of NEXUS during the countdown.
- Sleep (`SetSuspendState('Suspend')` through Windows PowerShell) and hibernate (`shutdown /h`) have no
  delayed form; NEXUS counts down. The failsafe is always a shutdown, whatever the end action is.
- Windows holds one shutdown timer. A second `shutdown /s` fails with 1190; `shutdown /a` aborts.

## States

`ARMING → RUNNING ⇄ QUOTA_PAUSED → FINALIZING → POWER_ACTION_SCHEDULED → DONE`, plus `CANCELLING`,
`FINALIZATION_FAILED`, `POWER_ACTION_FAILED`.

| Ending | Trigger |
|---|---|
| SUCCESS | run completed |
| FAILED | run failed |
| BLOCKED | NEXUS paused the run for intervention, authentication was lost, the watchdog or a budget fired |
| QUOTA_EXHAUSTED | a usage limit whose reset or next probe falls at or after the deadline, END_RUN, `usage.overnightWaitForReset` off, `usage.maxQuotaWaitMinutes` exceeded, or six waits (in 0.2.1 also any limit with no reset time) |
| TIME_LIMIT | the wall-clock deadline |
| USER_CANCELLED | the run was cancelled |

A pause by the user (PAUSE MISSION) ends nothing; the deadline and the failsafe stay in force.

## End-of-run pipeline

1. State `FINALIZING`; the first terminal reason wins and is persisted.
2. Stop the run (pause; a failed or unfinished run stays resumable). Wait up to two minutes for sessions.
3. Commit unfinished work in task worktrees on their task branches (never in the user's checkout).
4. Checkpoint the SQLite log into the database file.
5. Capture Git state: the user's branch and status, the integration branch head, commits, changed files.
6. Build and persist the report (`overnight_runs.final_report`), write it to `<data>/reports/` and, if
   enabled, `<project>/.nexus/reports/overnight-<start>.md` (`.nexus/` is added to `.git/info/exclude`).
7. `decidePowerAction`: allowed only when Overnight Mode is enabled, the stored authorization is for this
   run id, and the policy applies the end action to the terminal reason.
8. Not allowed: cancel the failsafe, state `DONE`. Allowed: other active runs are paused, the failsafe is
   replaced by the final action, state `POWER_ACTION_SCHEDULED`, the banner shows the countdown.

Finalization is idempotent. Calling it again, from any trigger, changes nothing. A crash in the middle is
finished on the next start with the same reason.

If a power command is refused, the state becomes `POWER_ACTION_FAILED`, the failsafe is restored where it
was replaced, and CANCEL SHUTDOWN still works.

## While the run is going

- **Banner**: state, failsafe time, mission deadline, end action, countdown.
- **CANCEL SHUTDOWN**: during the run, cancels the failsafe and sets the end action to NONE (the mission
  continues); during the countdown, aborts the pending action.
- **CHANGE END ACTION**, **EXTEND MISSION** (moves the deadline and the failsafe together),
  **PAUSE MISSION**, **CANCEL MISSION**.
- **Approvals**: tool approvals are denied (the agent continues another way); the plan is not held for
  approval; task-start and graph approvals follow `autoApprovePlanChanges`.
- **Quota** (0.3): `QUOTA_PAUSED` is not a failure. The supervisor owns an overnight run's wait (the
  ordinary quota controller skips these runs) and uses the shared `planQuotaWait` and the availability
  probe. The deadline and the failsafe are never moved by a wait. Details in QUOTA_RECOVERY.md; the rules:

  | Situation | Behaviour |
  |---|---|
  | Reset known; reset plus `usage.resumeDelaySeconds` (default 60) is before the deadline | Wait, probe at that time, resume if Claude is available |
  | Reset known; that time is at or after the deadline | Ends `QUOTA_EXHAUSTED` |
  | Reset unknown | Probe at 5, 10, 20, 30, 30 ... minutes (`usage.unknownResetProbeMinutes`, `usage.unknownResetProbeMaxMinutes`) while the next probe is before the deadline; then `QUOTA_EXHAUSTED` |
  | Probe finds the limit still on | Re-plan from the new reset time or the next backoff interval |
  | `quotaPolicy` `END_RUN` | Ends `QUOTA_EXHAUSTED` |
  | Setting `usage.overnightWaitForReset` off | Ends `QUOTA_EXHAUSTED` |
  | Six waits already (`MAX_QUOTA_WAITS`) | Ends `QUOTA_EXHAUSTED` |
  | `usage.maxQuotaWaitMinutes` (0 = none) exceeded | Ends `QUOTA_EXHAUSTED` |
  | Deadline reached during the wait | `TIME_LIMIT`, wait row closed |

  The probe asks the runtime's usage report first (no prompt) and falls back to one minimal session; it is
  given the rejected window's type, so a window at 100 percent whose reset has passed is not read as a limit,
  and a rejection with no window type is checked with the minimal session. Each
  wait is a `quota_pauses` row of scope `overnight` (with the limit type), with `quota_resumes` rows for the probes and the
  resume. Every exit from the wait (resume, deadline, cancel, a person's resume) releases the dispatch gate: the usage
  service reacts to `overnight.state_changed` from `QUOTA_PAUSED`, and a closed gate that no `quota_pauses` row and no
  overnight wait owns for `ORPHAN_QUOTA_MS` (30 s) reopens by itself. Without a probe object (not the case in the application) the 0.2.1 rule applies: wait only for a
  known reset, resume 90 seconds after it.
- **Watchdog**: no orchestration event for `stallMinutes` → diagnostic snapshot → scheduler reconciliation →
  if still silent after `graceMinutes` → BLOCKED. Check commands that are still running extend the
  allowance by their timeout. Diagnostics are in the report.
- **Sleep**: the NEXUS runtime holds a "prevent app suspension" request while an overnight run is live, so Windows does
  not put the PC to sleep on idle. If the PC sleeps anyway (lid, manual) and an end-of-run countdown is
  more than five minutes overdue on wake, the action is not executed late.
- **Checkpoints** (`run_checkpoints`): after planning, each graph revision, each completed task, each merge,
  each recovery and every interval. They record run state, graph version, tasks, leases, worktrees, session
  ids, message and decision counts and the last check results. They are a record for inspection; recovery
  itself reads the live tables.

## Window, tray and stopping NEXUS

Since 0.7 the mission, the report and the power action belong to the **runtime process**. The window is a client of it.

- **Closing the window ends only the window's process.** The runtime, the mission, its failsafe and its end-of-run power
  action continue. During an overnight run closing the window still asks first: Hide to tray and continue / Cancel
  mission / Return. That question is asked by the window (`desktop.ts`), from what the runtime last told it about live
  overnight runs; it exists so that closing the window is never mistaken for ending the mission. Hide keeps the window
  process; when the run is over and the window was hidden, the window comes back. Without an overnight run closing the window asks nothing
  and ends the window's process.
- **The tray belongs to the runtime** and exists while the runtime does, whether or not a window is open. Before 0.7 it
  existed only while an overnight run was live. During an overnight run its menu shows that run (state, Pause or Resume,
  Cancel shutdown, Cancel mission) and, below, the runtime's own entries (Open NEXUS, Open Control Center, Pause or
  Resume dispatch, Stop NEXUS...). Without an overnight run it shows the runtime's state and those entries.
- **"Stop NEXUS"** (the tray, or Runtime diagnostics; channel `runtime.stop`) stops the runtime. With an overnight run
  live it asks first, in a native dialog of the runtime process: stop and leave the
  Windows timer armed (when one is pending), cancel the mission and its shutdown and then stop, or return. With other
  work active it asks whether to stop the agent sessions. A stop that nobody can be asked about is not carried out.
  A sign-out of Windows or an operating-system request to quit stops the runtime without a question.
- A crash of the runtime, like a crash of NEXUS before 0.7, leaves the failsafe armed; that is what it is for. A project
  cannot be removed while its overnight run has a timer or a power action pending.
- An overnight run that was active when the runtime stopped resumes without a click when the next runtime starts,
  under the rules in the next section. A runtime does not stop by itself while an overnight run is active.

## Restart of NEXUS or Windows

On start of the runtime (the window opening is not a start) the supervisor looks at every live overnight record. "NEXUS
was away" below means that no runtime was running. Nothing starts the runtime at Windows sign-in; it starts when NEXUS is
opened, so after a reboot an overnight run that was interrupted waits for that.

| Situation | What happens |
|---|---|
| NEXUS was away for at most 10 minutes, before the deadline | The run resumes without a click. The failsafe is not touched and not scheduled again |
| Same, after the deadline | Finalized as TIME_LIMIT with the normal countdown |
| NEXUS was away for more than 10 minutes | The unattended session is over: Windows is asked to drop any pending shutdown, report, **no power action**, the run stays paused for manual resume |
| Windows restarted since NEXUS was last alive | Same, and the failsafe is recorded as lost |
| A final action was pending and its time passed while NEXUS was not running | Cancelled, not executed late; `POWER_ACTION_FAILED` |
| NEXUS died while arming, cancelling, or right after asking Windows for the final timer | The interrupted step is completed: timers are dropped (arming, cancelling) or the already accepted final timer is adopted and stays cancellable |

What Windows holds is never inferred from clocks alone: whenever the record cannot be trusted, NEXUS runs
`shutdown /a` and records the answer.

A person starts NEXUS (and so the runtime), so a launch never powers the machine off for a run that lapsed.

## Workloads: missions, Arena campaigns (0.3) and programs (0.4)

The supervisor supervises a workload. There is one supervisor and one implementation of arming, the
deadline, finalization, the power decision, the countdown, the user actions and restart recovery; a workload
only knows how to run, stop and describe its own work.

`AutonomousWorkload` (`src/main/modules/overnight/workload.ts`):

| Member | Meaning |
|---|---|
| `id`, `type`, `state` | The workload id (run id, campaign id, program id or workspace mission id), `mission`, `arena_campaign`, `program` or `workspace_mission`, and its phase: `working`, `paused`, `quota_wait`, `completed`, `failed`, `cancelled`, `missing` |
| `start()` | Begin the work. Called once, after the failsafe is armed |
| `pause(detail)` | Stop working and stay resumable. Resolves when nothing of the workload is running |
| `resume()`, `cancel()` | Continue; end for good |
| `checkpoint(reason)` | Write a durable checkpoint |
| `isTerminal()` | The work ended by itself |
| `summarize(input)` | The end-of-workload report, from persisted state only |
| `getDeadlineState(now)` | Phase, the terminal reason when it ended by itself, and the reset time of a usage limit |
| `getFinalizationState()` | After the stop: preserve unfinished work and capture what there is to report |

A workload never holds the power controller and takes no part in the power decision. The overnight record
stores `workloadType`; its `runId` is the workload id. One overnight workload at a time, of any type:
Windows has one shutdown timer.

Since 0.4 a program is the third workload type (`ProgramWorkload`, `overnight.startProgram`): one autonomous
work window of a long-running program. The deadline is the end of the window; at the end the program is
paused in a safe state, checkpointed and reported before the power action. A program that completes, fails,
is blocked or waits for a plan approval ends the window early. See LONG_HORIZON_AUTONOMY.md.

Since 0.5 a cross-repository mission is the fourth workload type (`WorkspaceMissionWorkload`,
`overnight.startWorkspaceMission`, workload type `workspace_mission`). The mission keeps its own task queue,
usage wait and global verification; the supervisor owns the deadline and the power lifecycle. A completed
mission ends `SUCCESS`. A blocked mission, a plan waiting for approval and a paused mission end the night as
`BLOCKED`, so the plan must already be approved when the night starts. At the deadline the mission is paused.
The report is `overnight-workspace-<start>.md` in the NEXUS reports directory. The watchdog and the run budgets
are not applied to it. The Workspaces view has no control for it in 0.5; the IPC channel is the way in. See
MULTI_REPO_ORCHESTRATION.md.

| | `MissionWorkload` | `ArenaCampaignWorkload` |
|---|---|---|
| Work | One run of the orchestrator | One Arena campaign (many trial runs) |
| Stop at finalization | The run is paused | No new trial starts, trials in flight are cancelled, queued trials stay queued; the campaign is `paused` (user) and can be resumed by hand |
| Ends by itself as | `SUCCESS`, `FAILED`, `USER_CANCELLED` from the run state | `SUCCESS` when the campaign completed with at least one evaluated trial; `FAILED` when no trial produced a result; `BLOCKED` when a campaign budget ran out; `USER_CANCELLED` when cancelled |
| Usage limit | The supervisor waits, probes and resumes the run (see above) | The Arena pauses and resumes the campaign through the usage gate; the supervisor only decides whether waiting fits before the deadline |
| Checkpoint | A row in `run_checkpoints` | Campaign and trial states are written on every change; a marker records where the campaign stood |
| Report | `overnight-<start>.md`, also in the project | `overnight-arena-<start>.md` in the NEXUS data directory |
| Watchdog, run budgets, unattended approvals | Supervisor | Not used: a trial has its own time budget and its own approval rule (ARENA.md) |

### Overnight Arena

Arena, New campaign, Run overnight. The dialog shows the same policy and the same authorization sentence as
an overnight mission, and the main process asks for the native confirmation. Order of events:

1. Node.js preflight. A campaign that cannot run arms nothing.
2. The campaign is created as a draft with `overnight: true`.
3. The overnight record, the authorization and the failsafe. If Windows refuses the failsafe the campaign is
   cancelled and nothing starts.
4. The campaign starts.

Usage limit during a campaign:

| Situation | What happens |
|---|---|
| Reset reported, before the deadline | `QUOTA_PAUSED`. The campaign continues by itself when the limit clears; the record returns to `RUNNING` |
| Reset reported, after the deadline | No wait. Finalized as `QUOTA_EXHAUSTED`; the policy for that reason applies |
| Reset not reported | `QUOTA_PAUSED` until the limit clears or the deadline, whichever comes first. The deadline finalizes as `TIME_LIMIT` |
| Policy `END_RUN`, or more than six waits | Finalized as `QUOTA_EXHAUSTED` |

A usage limit never moves the deadline or the failsafe.

The power events of a campaign are in the power audit under the campaign id. A campaign is not a run, so
the supervisor writes no run events for it; the window follows it through the `overnight` push.

A finished campaign refreshes the policy evidence and may leave a policy candidate, as any campaign does.
The report lists the candidates proposed since the campaign started. Nothing is promoted without a person.

After a restart of NEXUS the Arena re-attaches the campaign's trials and the supervisor restores the record
(same deadline, same failsafe, same quota wait). After a restart of Windows or an absence of more than ten
minutes the power authorization lapses, the campaign is stopped and nothing powers the machine off.

Tests: `tests/integration/arena/overnight-arena.test.ts` (success, failure policy, budget blocker, reset
before and after the deadline, unknown reset, timeout with trials in flight, restart during a quota pause,
restart while active, restart of Windows, double finalization, agent content and a tampered row),
`tests/stress/overnight-workload-stress.test.ts` (1000 seeded histories), and migration 005 in
`tests/integration/persistence/overnight.test.ts`.

## Verifying on your machine

- `pnpm smoke:power`: schedules a real shutdown one hour away with the real controller and aborts it at
  once, then checks nothing is left armed.
- Everything else uses `FakePowerController` (unit, scenario, stress and E2E tests). It is selected only in
  an unpackaged build, and always when the scripted runtime is in use.

## Limits

- An agent's shell policy is a lexical filter, not an operating-system sandbox (SECURITY.md). A worker can
  run code it wrote. NEXUS guarantees that none of its own mechanisms hands an agent the power controller
  or a valid authorization, and that plain and commonly obfuscated power commands are refused; it cannot
  stop a program the agent wrote from calling Windows directly.
- A normal (non-forced) shutdown can be vetoed by an application with unsaved data. The failsafe has been
  replaced by then, so the PC stays on.
- Finalization waits up to two minutes for agents to stop and three minutes for Git; CANCEL SHUTDOWN
  pressed during that time takes effect when the step returns.

## Not verified

Real sleep and hibernate were not executed (they would suspend the development machine), and no real
shutdown was allowed to complete. Their command lines are pinned by tests; the shutdown timer was exercised
for real by the smoke test only.

Overnight Arena was exercised with the Arena integration rig (real ArenaService, Git and evaluator, a
stand-in for the orchestrator), the fake power controller and a manual clock. A real campaign under the
supervisor with a real power action has not been run.

The 0.3 quota wait (probe before resume, probing on an unknown reset until the deadline) was exercised with
the scripted runtime and a manual clock only (`tests/scenarios/usage-overnight.test.ts`). A real usage
limit during an overnight run has not been observed; see V0_3_RELEASE_REPORT.md. The usage report the probe
prefers is an SDK method declared experimental; NEXUS treats it as optional and falls back to one minimal
session. Quota reset behaviour depends on what the runtime reports, and NEXUS never fabricates remaining
quota. See QUOTA_RECOVERY.md.
