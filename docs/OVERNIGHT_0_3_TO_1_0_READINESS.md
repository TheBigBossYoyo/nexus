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

### 00:00 to 00:33 Phase B: 0.4 audit, UI, E2E and real acceptance

- Programs UI delivered (list, new-program dialog with presets and work window, program page with state
  notices, plan approval with a diff, roadmap with verification evidence, tabs for missions, plan history,
  decisions, backlog, memory, expertise; background-engineering card; Home section).
- Independent code audit of 0.4 (read-only): no CRITICAL, 1 HIGH, 7 MEDIUM, 11 LOW.
  - HIGH: the program branch could lose accepted work. A retry started from its previous attempt's result; if
    a revision had another milestone accepted in between, accepting the retry moved the branch to a commit
    that lacked that milestone. Fixed: the branch only fast-forwards (compare-and-swap, refused while checked
    out), and a retry starts from the accepted work when its previous attempt does not contain the branch tip.
  - MEDIUM, all fixed: a judgment had to cover the milestone's criteria; a mission that finished around a
    crash was thrown away; `update-ref` was unconditional; quoted data could be closed with `</tag >`, and
    recorded context reached mission prompts unquoted; a revision could reuse a cancelled key or drop all
    remaining work while the program reported "completed"; a run created just before a crash was unknown to
    the program; a milestone could be accepted with an unreadable result commit.
  - LOW fixed: pause during a closed window, pause of a blocked program, a plan decision undoing a user pause,
    the shown work window ignoring `respectWorkWindows`, list total, project history order, two missing
    indexes, leftover settings keys. Not fixed: a user-cancelled mission run counts as a failed mission; the
    retry counter of an unreadable answer is in memory only.
  - Docs corrected where they claimed more than the code did.
  - Regression tests added for every HIGH and MEDIUM finding (8 cases); the stress gained the invariant "the
    program branch contains every accepted result" (1500 seeds pass).
- Found by the E2E after a restart: the gate `no_blocking_findings` rejected a completed mission because an
  earlier review of a since-completed task had requested changes. Fixed: a review is open only while its task
  is not finished.
- E2E (`tests/e2e/v4.spec.ts`, built app, scripted runtime): 3 of 3 pass. A program from the dialog to
  completion; plan approval, a user-requested reassessment and a restart mid-mission; background engineering.
- Real acceptance (`node scripts/program-acceptance.mjs`, real Claude Agent SDK sessions, Claude subscription): **15 of
  15 gates, first attempt**, evidence `docs/acceptance/program-2026-10-04T23-31-29-309Z.json`.
  - Goal: two functions in a small library, in two steps. Plan v1: 2 milestones. The user asked for a third
    (README); the reassessment produced plan v2 (added `document-readme`, changed the criteria of `round-trip`).
  - 3 missions (SINGLE), each started from the result of the one before; 3 milestones verified with 6 gates
    and 5, 5 and 3 judged criteria; 10 runs, 9 observed sessions.
  - NEXUS was quit in the middle of the second mission and started again; the program continued with the same
    run.
  - Backlog: 6 proposals with evidence (3 from milestone verification, 3 from a real read-only background
    job), all still `proposed`. Memory: 2 validated entries (interfaces).
  - The repository's own tests pass on the program branch (8 of 8, run outside NEXUS); the user's checkout is
    untouched.
- Usage after the run: five-hour window about a third used, seven-day 60 percent (runtime figures).
- In progress: independent UI review of the Programs area; the 0.3 stress is still running.

### 00:35 to 00:52 Phase B: Programs UI review; Phase C prepared

- Independent UI review of the Programs area (read-only, 17 screenshots and source): no HIGH; 5 MEDIUM (a
  colour token that does not exist on the approval card, a Resume button competing with Accept while a plan
  awaits approval, the same message three times, a diff that only repeats "Added" for a first plan, a
  full-width status select in the backlog); 7 LOW. All 5 MEDIUM and 6 LOW fixed; checked on fresh screenshots.
- Seen on those screenshots and fixed: a program's own planning and verification sessions were listed among
  the user's missions. `runs.list` now leaves them out unless asked, and the Home feed excludes them in SQL.
- E2E for Programs after the fixes: 3 of 3 pass.
- State at 00:52: `nexus-0.4` at `ecae730`; the 0.3 stress (started 23:39 on `e4253e5`) is still running, one
  worker left (the orchestrator stress).
- Work on 0.5 (Workspaces) is being written outside the tree while 0.3 and 0.4 are validated, in
  `%TEMP%\claude\C--Users-user-Documents-Nexus\6b6462d8-ada3-40b3-ad87-466ce2dd7776\scratchpad\wip05`:
  `src/shared/workspace.ts` (domain, dependency order, contract surface comparison, cross-repository plan
  validation, release planning), `src/main/modules/workspace/{contracts,discovery,engine}.ts`, migration 007
  and its repositories. It is brought into `nexus-0.5` once 0.4 is released.

### Order of the remaining release steps (kept here so it survives a long session)

1. When the 0.3 stress ends: record its result; switch to `nexus-0.3`; correct the duplicate-version test in
   `database.test.ts` (ok = latest + 1, broken = latest + 2); run `pnpm typecheck`, `pnpm lint`, `pnpm test`,
   `pnpm test:e2e`, `pnpm build`, `pnpm package`, `node scripts/packaged-validation.mjs`; update the 0.3
   release report, TEST_STATUS and BUILD_PROGRESS; commit; `git checkout main`; `git merge --no-ff nexus-0.3`;
   `git tag -a v0.3.0`.
2. Back on `nexus-0.4`: `git merge main`; bump the version to 0.4.0; full validation (typecheck, lint, test,
   stress at 1000 seeds, E2E, build, package, packaged validation); write `V0_4_RELEASE_REPORT.md`; merge to
   `main` and tag `v0.4.0` only on PASS.
3. `nexus-0.5` from `main`: bring in the Workspaces work, tests, UI, real acceptance, audit.
4. Reserve the last 45 minutes for the final report, preservation and the supervisor's `finish-now`.

### 00:52 to 02:40 Release of 0.3.0; 0.4 validated except its stress; 0.5 engine, UI, tests, documents

- **0.3.0 released.** The 1000-seed stress ended at 01:46 (6 files passed, 7600 s on a shared machine; it had
  started at 23:39 on `e4253e5`). On `0902f0a` (one corrected persistence test on top of `e4253e5`): typecheck
  and lint pass; `pnpm test` 126 files, 2399 tests; E2E 17 passed; package built
  (`release/NEXUS-Setup-0.3.0.exe`, 207,250,922 bytes, SHA-256
  `2d905b9e10835472a9bd79abcccb1d870fc0e47e98cbdfb86eebbd29eb38e650`); packaged validation 17 of 17 on each of
  three older databases. Release report rewritten with the verdict PASS (real usage limit and installer
  execution stay NOT VERIFIED). `main` = merge commit `af3e3ed`, tag `v0.3.0`.
- **A second checkout for long runs:** `%LOCALAPPDATA%\NexusValidation`, a plain clone with its own
  `pnpm install` (no junction). It has no Electron binary and is used for vitest only (stress, unit,
  integration). E2E and packaging stay in the main checkout.
- **0.4.0 candidate** (`nexus-0.4`, version 0.4.0, merged with `main`): typecheck and lint pass; `pnpm test`
  132 files, 2497 tests, 451 s; E2E 20 passed (1 capture-only skipped); package built
  (`release/NEXUS-Setup-0.4.0.exe`, 207,299,109 bytes, SHA-256
  `3990d22858e55c275e8e61d57619b23e6734b68722e8c483b535c270cd91df3e`); packaged validation 18 of 18 on each of
  three older databases (schema 6, Programs page). The 1000-seed stress started at 01:47 in the second checkout
  on `c75b8db` and is still running. 0.4 is merged and tagged only when it has passed.
- **0.5 (branch `nexus-0.5`):**
  - Workspace programs (an ordered series of cross-repository missions, each building on the one before) and
    a workspace mission as an overnight workload (`overnight.startWorkspaceMission`).
  - Documents written by a separate agent that read the code: WORKSPACES.md, MULTI_REPO_ORCHESTRATION.md,
    CONTRACTS.md, RELEASE_TRAINS.md. Its reading produced 16 observations. Fixed from them: a later milestone
    that changes only consumers read the contract from the checkout instead of the earlier milestone's result
    (regression test fails without the fix); a run created just before a crash was unknown to the mission
    (marker, cancelled on recovery); the planner session appeared among the user's missions; Resume was
    offered during a usage wait although the engine refuses it; cancelling a release train was unrecorded; two
    UI hints said more than the code does. Left as documented limits: `protectedBranches` is not consulted;
    a failed verification re-verifies the same results; cycle checks on consumers happen at mission start;
    release versions come from the manifest facts at enrollment; no UI for workspace programs or for starting
    a workspace mission overnight (IPC only).
  - E2E `tests/e2e/v5.spec.ts`, 2 of 2 pass on the built app. Writing it showed that the scripted demo runtime
    never carried a cross-repository task to its worker, so the app-level path had not been exercised before;
    fixed in the demo script.
- **Usage at 02:36:** five-hour window 67 percent (resets 04:10 local), seven-day 64 percent. Until 04:10 no
  further agents and no real-Claude acceptance are started. The independent code audit and UI review of 0.5
  and its real acceptance run are planned for after the reset.

### Order of the remaining steps (as of 02:40)

1. When the 0.4 stress ends: write `docs/V0_4_RELEASE_REPORT.md`, update TEST_STATUS and BUILD_PROGRESS on
   `nexus-0.4`, merge into `main`, tag `v0.4.0` (only on PASS).
2. 0.5: migration 007 test, full suites, stress, audit, UI review, real acceptance, release report; version
   0.5.0; merge and tag only on PASS.
3. 0.6 (providers), 0.7 (control plane) as far as time allows, each on its branch; partial work stays unmerged.
4. `docs/ONE_DOT_ZERO_READINESS.md`, `docs/OVERNIGHT_FINAL_REPORT_0_3_TO_1_0.md`, preservation, then
   `finish-now` to the shutdown supervisor. Start finalization no later than 09:45.

### 02:40 to 03:50 Release of 0.4.0; 0.6 built; 0.7 core built

- **0.4.0 released** at 03:13. The stress in the second checkout ended with 997 of 1000 orchestrator seeds:
  seeds 13, 16 and 22 timed out in the first three minutes, while a full test suite, a typecheck and a lint ran
  beside it. Seeds 13 to 22 alone: 10 of 10; seeds 1 to 60 alone: 60 of 60, same commit. Recorded as it
  happened in `docs/V0_4_RELEASE_REPORT.md`. `main` = `3e1b8b3`, tag `v0.4.0`.
- **0.5** (`nexus-0.5`, version 0.5.0): `pnpm test` 137 files, 2600 of 2601 (one failure: the timing-based
  evaluator of the Arena case `performance-optimization` measured a ratio of 24.1 against a limit of 24 while
  the machine was loaded; the file passed alone, 16 of 16); E2E 22 passed. Its 1000-seed stress started at
  03:12 in the second checkout. Still owed before a release: an independent code audit, an independent UI
  review, a real acceptance run, a clean full suite, package.
- **0.6** (`nexus-0.6`, from `nexus-0.5`): providers.
  - `AgentRuntimeProvider`, discovery, provider policy, a router that is itself an `AgentRuntime` (the
    orchestrator did not change), fallback with recorded reasons, provider sessions (schema 8), usage isolation,
    provider-aware evidence (`codex:gpt-5.5` in mission outcomes and Arena trials), Providers page, provider
    line in the mission inspector, IPC, PROVIDERS.md.
  - Codex is installed on this computer (`codex-cli 0.130.0`) and signed in through its own tool ("Logged in
    using ChatGPT"). NEXUS drives `codex exec --json` read-only. Its default model was refused by the service
    for this tool version; `gpt-5.5`, which the service listed, works and is NEXUS's default for Codex.
  - **Real Codex evidence** (`pnpm smoke:providers`, `docs/acceptance/providers-smoke-2026-10-05T*.json`): one
    read-only review of a small commit with a real defect. Outcome success, verdict `request_changes`, the
    defect named (an empty list divides by zero), two shell commands run, the attempt to write a file refused
    by the Codex sandbox, the working directory fingerprint unchanged, 46k input tokens (36k cached).
  - Gemini is not installed here; it is detected only and cannot be enabled.
  - Tests: `pnpm test` 139 files, 2639 passed; E2E 24 passed (2 new, scripted providers).
- **0.7** (`nexus-0.7`, from `nexus-0.6`): the control plane core, in the NEXUS process.
  - Built: global work items (six types, P0 to P3, ten states, persisted order), allocation of agent capacity
    between workloads through the orchestrator's dispatch gate (running sessions are never stopped; free
    capacity goes to the higher priority first), adoption of every working workload however it was started,
    durable schedules (a missed one fires once), runtime health per component, restrained notifications, boot
    reconciliation, Control Center page, IPC (`control.*`), schema 9.
  - Tests: `pnpm test` 140 files, 2671 passed before the page was added; 21 control-plane tests including
    10,000 seeded allocations; E2E 1 of 1 (an adopted mission, a program from the queue, limits, a schedule,
    a restart).
  - **Not built, and 0.7 cannot be released without them:** a runtime process separate from the window (the
    control plane lives in the Electron main process, which already keeps running in the tray when the window
    is closed), a client and runtime IPC boundary of its own, and a worker manager with leases. Home was not
    redesigned into the Control Center; the Control Center is its own page.
- Usage: no agents and no real Claude runs were started between 02:36 and the reset at 04:10.
