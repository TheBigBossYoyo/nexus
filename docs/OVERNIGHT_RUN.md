# Overnight Run Log

Unattended run started 2026-10-03T22:35+01:00. This file is updated as the run proceeds.

## Initial state

| Item | Value |
|---|---|
| Repository | `C:\Users\user\Documents\Nexus` |
| Branch | `main` |
| HEAD | `7ea4b1e` Record final acceptance evidence, test status and build progress |
| Working tree | clean |
| Node / pnpm | v24.14.0 / 12.8.1 |
| Claude Code | 2.1.288 |
| Agent SDK | 0.3.288 |
| Electron | 44.5.1 (`node_modules/electron/dist/electron.exe` present, restored earlier this evening) |
| Existing installer | `release/NEXUS-Setup-0.1.0.exe` |

## Shutdown

The brief requires a failsafe shutdown timer at the start and a forced shutdown at the end.
The command `shutdown.exe /s /f /t 36000` was **refused by Claude Code's permission system**
(classified as irreversible local destruction). No shutdown is scheduled. The refusal was reported
to the user immediately, with the command to run by hand. It is not worked around.

## Initial issues carried in

1. One intermittent scenario failure (run `paused` instead of `completed`, once in about 35 runs),
   cause not established.
2. E2E not re-run since the final 0.1.0 packaging (Electron binary was blocked by antivirus).
3. Repair loop, messaging, dependencies, rotation and recovery verified only with scripted agents.
4. Temporary test installation left at `%LOCALAPPDATA%\Temp\nexus-install-test`.

## Phase status

| Phase | Status |
|---|---|
| v0.1 baseline validation | in progress |
| Orchestrator stress campaign | pending |
| Real adversarial mission (v0.1) | pending |
| v0.2 design | pending |
| v0.2 implementation | pending |
| v0.2 validation | pending |
| Independent review | pending |
| Final packaging and report | pending |

## Log

- 22:36 v0.1 baseline on restored Electron: typecheck pass, lint pass, `pnpm test` 47 files / 1031 tests pass,
  `pnpm test:e2e` 4/4 pass, `pnpm package` produced `release/NEXUS-Setup-0.1.0.exe`.
- 22:50 Added `tests/stress/orchestrator-stress.test.ts` (`pnpm stress`): seeded random DAGs, timings,
  crashes, review rejections, verification failures, pause/resume, task cancellation, messaging; checks
  invariants on durable state; failing seeds are dumped to `test-results/stress-failures/`. Two early
  failures (seeds 8, 13) were oracle errors in the test (an injected crash scheduled into a session that a
  pause had already stopped), not orchestrator defects. 60 seeds pass after correcting the oracle.
- 23:00 Started the 1,000-seed campaign on the v0.1 orchestrator code (background).
- 23:05 Wrote `docs/V0_2_DESIGN.md` and the v0.2 shared contracts (`src/shared/v2.ts`, events, IPC).
- 23:10 Started four parallel implementation agents: persistence migration 002, pure logic (proposals,
  router, performance, dedupe, heuristics), repository intelligence, mission-control UI.
- 23:15 Started the real adversarial mission (`scripts/adversarial-mission.mjs`) against the v0.1 packaged
  build `release/win-unpacked/NEXUS.exe`: four tasks, fast-tier workers, controlled restart mid-run.
- Wave 1 of v0.2 finished: migration 002 + repositories (64/64 persistence tests incl. a v0.1→v0.2 upgrade
  test), pure logic (116/116), repository intelligence (15/15), mission-control UI (74 renderer tests).
- **Real adversarial mission on the v0.1 packaged build: run ended `paused` (intervention), not completed.**
  Evidence: `docs/acceptance/adversarial-2026-10-03T22-00-46-235Z.json`. 40 SDK sessions, about 8 minutes.
  What it demonstrated with the real runtime: 3 concurrent workers in separate worktrees; a task (`report`)
  depending on three others and correctly never started; 11 persisted `interface_change` messages routed to
  `report`; a controlled app restart mid-run (3 sessions ended `shutdown`, the run was listed as recoverable
  with `pauseReason: recovery`, and resumed); 9 real repair tasks; the repair bound (3 cycles) ending in an
  intervention pause; the user's checkout untouched.
  **Defect found:** the planner turned "tell the report task the signatures through a message" into an
  acceptance criterion. The verifier has no visibility of persisted messages, so it failed that criterion
  every cycle although the messages had been sent, and every module task exhausted its repair cycles.
  All 10 reviews approved (no HIGH finding), so review-rejection repair was not exercised by real agents;
  the repairs came from verification failures. Fix scheduled in v0.2: give the reviewer and verifier the
  orchestration evidence they cannot see in the repository (messages sent by the task and its repairs).
