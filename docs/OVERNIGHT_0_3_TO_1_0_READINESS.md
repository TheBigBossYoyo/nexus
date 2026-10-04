# Overnight release train: 0.3 to 1.0 readiness

Running log of the unattended session of 2026-10-04 to 2026-10-05. Times are local (UTC+1). Entries are added
as things happen; results are stated as run, not as hoped.

## Start

| | |
|---|---|
| Start | 2026-10-04 22:35 |
| Hard deadline | 2026-10-05 10:36 (12 hours) |
| Initial branch and HEAD | `nexus-0.3` at `162fc0c` |
| `main` | `2b9f208` (0.2.1) |
| Tags at start | `v0.2.1` |
| Reported 0.3 state at start | PARTIAL (see `V0_3_RELEASE_REPORT.md` as of `162fc0c`) |

Environment: Windows 11 Pro 10.0.26200, Node 24.14.0, pnpm, Electron 44.5.1, Claude Agent SDK 0.3.288. Windows
idle sleep and hibernate are off on mains power, so the machine stays awake by itself. Bitdefender is active;
`node_modules/electron/dist/electron.exe` was present at the start.

## Shutdown supervisor

The end-of-session shutdown does not depend on the coding assistant.

- `scripts/dev-supervisor/development-overnight-supervisor.ts`: a small detached Node process. It uses the
  application's `WindowsPowerController` for every power call and accepts three controls as JSON files in its
  control directory: `status`, `extend {minutes}` (never past the hard deadline) and `finish-now`. No control
  carries an executable, an argument or message text; anything else is discarded and logged.
- Started 22:36:46. It armed a forced Windows shutdown timer for 12 hours later (`shutdown /s /f /t 43200`,
  exit 0). That timer belongs to Windows and stays armed if the supervisor, the terminal or the assistant dies.
- State and control directory: `%LOCALAPPDATA%\NexusDevSupervisor` (`state.json`, `control\`). A copy of the
  bundle is kept there.
- At the end: `finish-now` cancels the distant timer and schedules a forced shutdown 90 seconds later. If the
  supervisor cannot be reached, the 12-hour timer is left armed.
- It is not part of the application. No NEXUS agent, IPC channel or MCP tool can reach it. Unit tests:
  `tests/unit/power/dev-supervisor.test.ts` (23 cases, fake power controller).

## Log

### 22:35 Inspection

- Read the 0.3 release report, the supervisor (1503 lines), the power controller, the Arena service, the main
  entry point and the test harnesses. The report's list of gaps matches the source: no overnight path for a
  campaign, and the UI items it lists.

### 22:40 to 23:00 Phase A: Overnight Arena and the workload abstraction

- `AutonomousWorkload` (`src/main/modules/overnight/workload.ts`): `start`, `pause`, `resume`, `cancel`,
  `checkpoint`, `isTerminal`, `summarize`, `getDeadlineState`, `getFinalizationState`, plus `projectRoot`,
  `extend` and `recoverAfterRestart`. Two implementations: `MissionWorkload` (the code that was inside the
  supervisor: stop, checkpoint, Git capture, report) and `ArenaCampaignWorkload`.
- One supervisor. Arming, the deadline, finalization, the power decision, the countdown, the user actions and
  restart recovery are the same code for both workload types. What stays mission-only: the watchdog, the run
  budgets, unattended approvals and the probe-before-resume quota path (a campaign's quota pause and resume
  are the Arena's own, driven by the usage gate).
- Schema 5 (`005-overnight-workloads`): `overnight_runs` no longer references `runs`, gains `workload_type`,
  every existing row is kept as `mission`; a trigger keeps "deleting a run deletes its overnight record".
- `OvernightSupervisor.startArena`: campaign created as a draft, Node.js preflight before anything is armed,
  authorization and failsafe before the first trial, then the campaign starts.
- `ArenaService.suspend` and `idleCampaign`: finalization stops the trials in flight (cancelled, not evidence)
  and leaves queued trials queued, so the campaign can be resumed by hand.
- IPC `overnight.startArena` (strict schema, native confirmation in the main process). Tray wording and
  pause/resume for a campaign.
- Tests written and run:
  - `tests/integration/arena/overnight-arena.test.ts`: 13 cases covering A to H of the brief (success, failure
    policy, budget blocker, reset before the deadline, reset after the deadline, unknown reset until the
    deadline, timeout with trials in flight, restart during a quota pause, restart while active, restart of
    Windows, double finalization, agent content and a tampered row, single workload). 13 of 13 pass.
  - `tests/stress/overnight-workload-stress.test.ts`: 1000 seeded histories of a non-mission workload with the
    power invariants of the mission stress plus three of its own. Pass, 15 s.
  - `tests/integration/persistence/overnight.test.ts`: migration 005 on a schema-4 database with a record.
  - Existing overnight, power, persistence, IPC and Arena suites after the refactor: pass, after updating the
    schema-version expectations (4 became 5) and the migration-004 isolation test (now runs migrations up to 4).

### 23:00 to 23:30 Phase A: UI closure and independent review

- Remaining items of the first 0.3 review fixed (one status badge component, per-strategy counts next to the
  Arena progress strip, the Agents page below 1100 px, the composer's project facts and a note when no check
  command is configured, keyboard access to task-graph nodes). The dark theme already existed and was clean.
- Overnight Arena UI: "Run overnight" in the new-campaign dialog (same policy controls and authorization as a
  mission), an Overnight panel on the campaign page, a workload-aware Overnight page.
- Screenshot capture of the real build (`tests/e2e/ui-review.spec.ts`, 77 images: every view, light and dark,
  1440 and 1024 px, plus Mission Control, the inspector, Agents with a mission, the overnight form and panel).
- Independent review 1 (read-only, on the screenshots and the source): no HIGH; 5 MEDIUM (contradictory
  overnight wording, disabled actions without a reason, page title crushed at 1024 px, Missions table clipped
  at 1024 px, no skip link); 6 LOW. It also reported that three areas were missing from the screenshots.
- All MEDIUM and five LOW findings fixed. Capture extended to the three missing areas.
- Independent review 2 (a different reviewer, fresh screenshots): the five MEDIUM fixes confirmed (one partly:
  the Missions table now scrolls and no longer hides data); no HIGH; 2 MEDIUM, both about the overnight
  authorization form (the status line claimed "authorized" before the box was ticked; the force-close and
  failsafe notes left the risk to unsaved work unclear); several LOW. Verdict: release quality once those two
  are fixed. Both fixed, plus the Missions column width and a reason on two disabled buttons.
- Not fixed (LOW): accessible names for task-graph nodes, `aria-selected` on table rows without a grid role,
  the empty band above the bottom panel of Mission Control, the stray divider when the status strip wraps.

### 23:10 A defect in the tests, found by the clock

- Two tests failed that had passed earlier in the day: `tests/unit/usage/recovery.test.ts` ("an ended wait is
  durable") and `tests/scenarios/usage-recovery.test.ts` ("an ended wait stays ended across a restart").
- Cause: both drive the controller with a manual clock fixed at 2026-10-04 22:00 UTC, while durable events are
  stamped with the real clock. The controller compares the two. The tests passed while the wall clock was
  before 22:00 UTC and failed after it. The product code is not affected: in the application both times come
  from the same clock.
- Fix: both manual clocks now start a day ahead of the wall clock. No assertion was changed.

### 23:27 Phase A: final validation of 0.3 (commit `b11129b`)

- `pnpm typecheck`: pass. `pnpm lint`: pass. `pnpm build`: pass.
- `pnpm test:e2e`: 17 passed, 1 skipped (the review capture, which runs only on request), 4.3 min.
- `pnpm test` and `pnpm stress` (1000 seeds): started 23:28 as one job.

### 23:28 to 23:40 Phase A: final suites on the 0.3 tree

- `pnpm test`: 126 files, 2398 tests passed, 469 s.
- While reviewing the restart path of a campaign: after a restart, `QuotaRecoveryController.recover()` closed
  the usage gate for every waiting overnight record. For a mission the supervisor probes and reopens it; for a
  campaign nothing would, if the wait of its trial run had been ended by the user. Fixed (the gate is restored
  for a waiting overnight mission only) with a regression test. Commit `e4253e5`.
- `pnpm stress` with `NEXUS_STRESS_RUNS=1000` started 23:39 on `e4253e5` (six files: orchestrator, policy,
  usage, Arena, overnight, overnight workload).
- A test defect found while preparing 0.4: in `database.test.ts` the "rolls the whole migration back" case had
  two migrations with the same version after the schema bump, so it passed for the wrong reason (a duplicate
  key, not the broken SQL). To be corrected on `nexus-0.3` before the merge.

### 23:40 Phase B started: NEXUS 0.4 (branch `nexus-0.4`, from `e4253e5`)

Written while the 0.3 stress runs; only light test runs alongside it.

- Domain (`src/shared/program.ts`): Program, ProgramGoal, Milestone, Workstream, BacklogItem, ProgramDecision,
  ProgramCheckpoint, ProgramOutcome, ProgramPolicy (presets Conservative, Balanced, Autonomous),
  ProgramSchedule (work windows), ProgramMemoryEntry, ProgramPlanRevision, ExpertiseProfile, BackgroundJob;
  transition tables for programs and milestones; plan, revision, judgment and findings schemas; plan
  structure validation (unique keys, known dependencies, no cycle); plan diff; `windowStatus`.
- Migration 006 (additive, 11 tables) and repositories.
- `ProgramEngine`: plan, mission per milestone, deterministic gates, verifier judgment, backlog, validated
  memory, selective memory per mission, reassessment and revisions with diffs, budgets, usage waits, work
  windows, restart recovery, user actions, decision trail, checkpoints. Missions and reasoning sessions are
  ordinary runs; `createRun` gained `baseRef` so a mission starts from the program branch.
- `BackgroundEngineering` (off by default, read-only runs, proposals only).
- `ProgramWorkload`: a program as an overnight workload for one work window (`overnight.startProgram`).
- IPC: 19 channels (`program.*`, `backlog.*`, `background.*`, `expertise.list`, `overnight.startProgram`).
- The scripted demo runtime answers the program reasoning sessions, so the built app can run a program in E2E.
- Tests so far, all passing:
  - `tests/unit/program/program-model.test.ts` (24)
  - `tests/integration/program/engine.test.ts` (16): multi-milestone completion, gate rejection, verifier
    rejection with backlog and memory, failed mission to backlog and a stored revision, plan approval, usage
    wait and resume, closed gate, stop policy, endless wait, restart mid-mission and mid-verification, work
    windows, selective memory, refused memory, unreadable plans, budgets, user actions, strategy per mission.
  - `tests/integration/program/background-overnight.test.ts` (7): background jobs, a program under the
    overnight supervisor, migration 006.
  - `tests/scenarios/v4-program.test.ts` (1): a whole program on the real orchestrator with the scripted
    runtime (three real missions, one rejection, one revision, memory, backlog, user checkout untouched).
  - `tests/stress/program-stress.test.ts`: 3000 seeded histories pass.
- Found by these tests and fixed: a milestone that used all its missions could not be blocked (missing
  transition `READY -> BLOCKED`), which left the program looking busy; an engine error now blocks the program
  with the error instead of being swallowed. Found by the stress: under the `stop` usage policy a user could not
  resume a program while Claude was still limited; a resume during a limit now waits for the reset.
- In progress: Programs UI (agent), independent code audit of 0.4 (agent).
