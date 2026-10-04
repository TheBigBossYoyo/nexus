# NEXUS 0.2.1 Release Report

Date: 2026-10-04. Branch `v0.2.1` (not merged into `main`). Code commit `10be52f`; this report and the last
two evidence files are in the commit after it.

## Verdict

**PARTIAL.**

Every item of the completion checklist is met, and both real-runtime release gates pass. It is not a full
PASS because the installer was built but not executed (install and uninstall are NOT VERIFIED), and three
things could not be verified for real: sleep, hibernate, and a shutdown that actually completes.

## Existing suite

All from the final versioned tree (`package.json` 0.2.1, commit `10be52f`).

| Check | Result |
|---|---|
| Typecheck (`pnpm typecheck`) | pass |
| Lint (`pnpm lint`) | pass |
| Unit (`pnpm test:unit`) | 46 files, 1361 tests passed |
| Integration and scenario | 34 files, 411 tests passed (includes the overnight state-machine stress) |
| Total (`pnpm test`) | 80 files, 1772 tests passed, 187 s |
| E2E (`pnpm test:e2e`) | 10 of 10 passed, run after the version bump and after the last code change |
| Stress, orchestrator | 1000 of 1000 seeds passed, but not in one clean run (see below) |
| Stress, overnight state machine | 1000 of 1000 seeded histories passed |
| Build and package | pass |

0.2.0 had 1267 tests and 4 E2E tests. No existing test was weakened. Changed existing assertions:

- Schema version expectations (2 became 3) in the persistence tests.
- One policy test list: `shutdown` moved from "needs approval" to "forbidden".
- One 0.2.0 evidence test: a decision's text is now shown to the verifier as a quoted, labelled block instead
  of being hidden (a real mission failed because the verifier could not read it).
- Scenario wait budgets raised from 60 s to 150 s (test timeout 90 s to 240 s) and the integration project
  limited to six workers. These bound a hang; they are not performance assertions.

### Orchestrator stress: what actually happened

The campaign was run on a busy machine, where starting a `git` process took about 180 ms.

1. A single-process run was stopped at about seed 310 after 80 minutes. Two seeds (308, 310) had timed out.
2. All 1000 seeds were then run as three parallel ranges. 977 passed. 23 timed out on the test's fixed
   120-second limit for a whole run: 82, 124, 159, 162, 187, 203, 228, 407, 472, 495, 501, 517, 526, 538,
   554, 563, 597, 747, 797, 857, 889, 890, 891.
3. Each of those 23 was rerun alone and passed, in 9 to 25 seconds.

No seed failed an invariant. Seeds 308 and 310 passed in step 2. Logs: `test-results/final-021-stress-a.log`,
`-b.log`, `-c.log`, `-rerun.log`; dumps of the timeouts in `test-results/stress-failures-parallel-run/`.

## Real runtime

Real Claude Agent SDK sessions, Claude subscription subscription, SDK 0.3.288, NEXUS 0.2.1.

| Item | Result |
|---|---|
| Dynamic graph proposal | **Proven.** 12 of 12 gates. `docs/acceptance/dynamic-proposal-2026-10-04T09-44-04-448Z.json` |
| Graph revision | **Proven.** Revision 2 created from proposal `0ade3ac3`; tasks went from `implement-export-csv` to that plus `implement-normalize` |
| Session rotation | **Proven.** 11 of 11 gates. `docs/acceptance/session-rotation-2026-10-04T09-52-30-716Z.json` |
| Dependencies | Exercised: the proposer was made to depend on the new task, yielded, and resumed after it was merged |
| Review | Exercised: 3 reviews in the proposal run, all approved |
| Repair | Exercised: `implement-normalize` failed its first verification, was repaired, then passed |
| Verification | Exercised: task and mission verification passed in both gate runs |
| Parallel workers | NOT RE-EXERCISED on 0.2.1 (last real evidence: 0.2.0 mission 2, three concurrent workers) |
| Messaging | NOT RE-EXERCISED on 0.2.1 (last real evidence: 0.2.0 mission 2) |
| Restart recovery | NOT RE-EXERCISED with the real runtime on 0.2.1 (last real evidence: 0.2.0 mission 2). Covered by scenarios and E2E |
| Quota pause and resume | NOT VERIFIED with a real usage limit (none was provoked on purpose). Covered through the runtime adapter simulation and the isolated classification and decision logic |

### Dynamic graph proposal

The fixture hides the prerequisite from planning: the export contract is packed in a vendor bundle that only
`npm run generate-schema` unpacks, and a read-only planner may not run it. The mission text never mentions
normalization.

- Plan v1 (real planner): one task, `implement-export-csv`. No mention of normalization.
- The real worker ran the generator, read the contract and called `propose_graph_change`. Its first call was
  rejected by validation (no tasks listed); the second, `ADD_TASK implement-normalize` with
  `blocksProposer: true`, was applied.
- Proposed by agent `594998ef` (`Worker/implement-export-csv`, model `claude-sonnet-5-5`), SDK session
  `9ed359db-28c2-49ab-9205-ed307c9a8fa2`.
- Dependency `implement-export-csv → implement-normalize` created. The worker's session ended at 09:34:20;
  `implement-normalize` ran 09:34:22 to 09:40:51; the original task resumed in a new SDK session
  (`88fa3693-…`) at 09:40:52 and completed.
- Run completed, mission verification passed, independent `node --test` on the integration worktree: 15 pass,
  0 fail. The user's checkout was untouched.

Three attempts were needed, and the two failures were NEXUS defects that this release fixes:

1. The planner made a separate "read the contract" task whose criteria were about its result text. The
   verifier could not see that text and failed it four times. Fix: evidence now includes the agent's reported
   result.
2. The mission verifier could not run the project's own generator script and judged a plan-v1 criterion ("only
   these two files are new") literally after the plan had been revised. Fix: project package scripts count as
   verification commands for gate roles, and the mission verifier is told how to read pre-revision criteria.

### Session rotation

Run created with `sessionRotationTurns: 4` (new override on `runs.create`).

- Session A `c37f2519-ca3f-47ba-b3ff-1e6a7c2c352b` reached the turn threshold.
- Structured handoff generated by the model and persisted: 4 completed-work items, 1 commit, 2 files, 3 open
  issues, 3 findings, 3 next steps.
- Session B `9b507d48-c2e3-4d8a-8464-b3f19b4e3b22` started from the handoff (context pack recorded) and
  finished the same task.
- One decision recorded, task and mission verification passed, 15 of 15 tests pass independently.

Five attempts in total. The rotation gates themselves passed in runs 1, 2, 3 and 5. Run 1 failed only on a
parsing bug in the script. Run 2 failed because the verifier could not read a decision's text (fixed). Run 3
failed on a self-conflicting criterion in my mission text (fixed in the fixture). In run 4 the worker finished
before the 8-turn threshold, so nothing rotated; run 5 used 4 turns.

## Overnight Mode

Verified with `FakePowerController` in scenario tests (real orchestrator, scripted agents), the seeded stress
and Playwright E2E against the built app. Nothing here shut down, slept or hibernated the machine.

| Item | Result |
|---|---|
| Authorization | Run-specific: composer checkbox and dialog, then a native main-process dialog. Stored with the run (policy, time, run id, sentence) and sealed with an HMAC; an edited row is refused. Tested |
| Failsafe | Armed before the first agent session; the run does not start if Windows refuses it. Never scheduled twice. Tested |
| Mission deadline | Wall-clock; stops the agents, saves the report, applies the policy. Tested (scenario and a real 60-second E2E) |
| Background execution | Finalization runs in the main process with the window hidden. Tested in E2E |
| Tray | Icon only while a run is live; status and menu from a pure model. Model tested; shown state checked in E2E. The icon itself was not looked at by a person |
| Success shutdown | Report, failsafe replaced, final action scheduled. Tested |
| Failure shutdown | Tested |
| Quota shutdown | Tested, including waiting for a reset inside the mission time and resuming |
| Timeout shutdown | Tested |
| Final report | Saved to the database and to disk before any final power request, in every tested path |
| Power-controller isolation | Only the supervisor and the main entry point import it; no IPC channel, agent tool or MCP tool reaches it. Tested against the source tree |
| Recovery | Short restart resumes and leaves the failsafe alone; long absence or a Windows restart ends without a power action. Tested |

## Windows power smoke

Real `WindowsPowerController`, run once (`pnpm smoke:power`, 09:27 local).

| Step | Result |
|---|---|
| Schedule | `shutdown.exe /s /t 3600 /c <fixed message>` accepted, exit 0 |
| Abort | `shutdown.exe /a` accepted, exit 0 |
| Result | A second abort returned 1116 (nothing in progress): no timer was left armed |

NOT VERIFIED on real hardware: a shutdown that completes, sleep, hibernate.

## Installer

| | |
|---|---|
| Path | `release/NEXUS-Setup-0.2.1.exe` |
| Size | 206,906,496 bytes |
| SHA-256 | `4a9ec18db5d77f5333facae4df2c3a87a99c4a445763679cb3b07d3c7b9959bb` |
| Installed launch | **NOT VERIFIED.** The installer was not executed |
| Uninstall | **NOT VERIFIED** |

Why the installer was not run: on 2026-10-03 Bitdefender Advanced Threat Defense killed the session during a
silent uninstall, and that test installation is still registered with its uninstaller in quarantine. Running
the 0.2.1 installer could trigger that uninstaller, and would leave a second registered installation that
cannot be removed unattended.

What was verified instead, on the unpacked packaged build `release/win-unpacked/NEXUS.exe` (the files the
installer lays down):

- Launches as packaged 0.2.1.
- A real 0.1 database (13 tasks, 40 agents, 1123 events) upgraded from schema 1 to 3 with no row lost; the old
  run is readable.
- A real 0.2.0 database (11 tasks, 51 agents, 1670 events) upgraded from schema 2 to 3 with no row lost.
- Claude status reported (authenticated, subscription), a project opens.
- Overnight panel renders; start is disabled until authorized; force close is off by default.
- A real mission on the packaged build completed with mission verification passing and 15 of 15 tests
  (`session-rotation-2026-10-04T12-15-05-715Z.json`; the worker finished before the threshold, so that run
  did not rotate).

Evidence: `docs/acceptance/packaged-validation-2026-10-04T12-11-56-357Z.json`.

To check the installer yourself: run `release\NEXUS-Setup-0.2.1.exe`, choose a test folder, launch, then
uninstall from Windows Settings.

## Audit

Three independent read-only reviewers covered the eight areas: power-control security and Windows/Electron
lifecycle; supervisor state machine and persistence/recovery; scheduler, agent runtime, Git safety and tests.

| Severity | Found | State |
|---|---|---|
| Critical | 0 | |
| High | 7 | 5 fixed, 2 mitigated with a stated limit |
| Medium | about 22 | about 17 fixed, 5 not fixed (listed below) |
| Low | about 12 | 5 fixed, the rest not fixed |

High findings:

1. A crash right after Windows accepted the final timer left it armed and un-cancellable. **Fixed** (the intent
   is written first, the timer is adopted on restart, cancel always asks Windows).
2. Removing a project deleted the overnight record while a timer was armed. **Fixed** (refused).
3. A failure or crash while arming could leave the failsafe armed with nothing tracking it. **Fixed.**
4. A usage limit reported twice (with and then without a reset time) ended the run instead of waiting.
   **Fixed.**
5. `git config` could set keys that run code (aliases, hooks path, editor) without approval; present since
   0.1. **Fixed** (approval required).
6. The agent shell policy is a denylist: a writing agent could run power commands through carets, quotes,
   interpreters or PowerShell APIs. **Mitigated:** those forms are now refused or need approval. **Not
   solvable in the policy:** a worker can still run a program it wrote. There is no OS sandbox.
7. An agent's shell can reach the NEXUS database file and could edit the stored policy. **Mitigated:** the
   authorization and policy are sealed with a key held by the main process, and commands naming the database
   are refused. **Limit:** code running as the same Windows user could, with effort, recover the key.

Medium findings not fixed: `billing_error` is still treated as a usage limit; a cancel during the few
milliseconds of `prepare` emits a second `run.cancelled`; CANCEL SHUTDOWN waits behind a finalization step in
progress (bounded to about five minutes); the session row marked `rotated` is the handoff session, not the one
that hit the limit; a few test gaps the reviewer listed (controller timeout path, an application vetoing a
normal shutdown).

Also found while fixing: a stuck helper process left by a sub-agent, and a shutdown race in the orchestrator
(background planning work was not awaited), fixed.

## Known limitations

- Installer install and uninstall not executed (above).
- Real sleep, hibernate and a completed shutdown not executed.
- The agent shell policy is a lexical filter, not a sandbox (audit finding 6).
- The failsafe is a Windows timer and always closes applications without waiting, whatever "force close"
  says. A normal final shutdown can be vetoed by an application with unsaved data; the PC then stays on.
- After more than 10 minutes without NEXUS, or a Windows restart, an overnight run ends without a power
  action and must be resumed by hand.
- One overnight run at a time; always MISSION mode without plan approval. Tool approvals are always denied
  while unattended, so work that truly needs one ends as blocked.
- Budgets cover sessions and repairs only; no token or cost limits. Planner attempts stay fixed at three.
- Checkpoints are written but not read by recovery.
- The original 0.1 "run ended paused" flake: root cause still **not proven**. The reviewer found no
  interleaving that pauses a healthy run; the one mechanism that fits is any exception in a task pipeline
  failing the task without a retry. In Overnight Mode such a pause ends the run as blocked.
- Shell policy for `git commit` (gap 4 of 0.2.0): plain `git commit` was never blocked for writing roles.
  What was blocked was heredoc content parsed as shell (commit messages, and `cat > file <<'EOF'`); both fixed.
- The release is on branch `v0.2.1`; `main` is unchanged.

## Evidence

- Commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:unit`, `pnpm test:e2e`, `pnpm stress`
  (`NEXUS_STRESS_RUNS`, `NEXUS_STRESS_START`), `pnpm smoke:power`, `pnpm package`,
  `node scripts/dynamic-proposal-acceptance.mjs`, `node scripts/session-rotation-acceptance.mjs`,
  `node scripts/packaged-validation.mjs`.
- Logs (not committed): `test-results/final-021-suite.log`, `final-021-e2e.log`, `final-021-stress-*.log`,
  `final-021-package.log`, `accept-proposal-*.log`, `accept-rotation-*.log`, screenshots in
  `test-results/screenshots/`.
- Acceptance evidence (committed, failed attempts included): `docs/acceptance/dynamic-proposal-*.json`,
  `session-rotation-*.json`, `packaged-validation-*.json`.
- Documents: `docs/OVERNIGHT_MODE.md`, `docs/SECURITY.md` ("Command classes (0.2.1)"), `docs/TESTING.md`,
  `docs/RECOVERY.md`, `README.md`.
- Commits on `v0.2.1` after `d8a3217`: `0f1414b` (feature), `fd7f9d7` (audit fixes, version), `10be52f`
  (fixes from the real acceptance runs), and the report commit.
