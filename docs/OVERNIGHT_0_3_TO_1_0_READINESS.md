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
