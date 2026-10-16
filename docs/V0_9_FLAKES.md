# NEXUS 0.9: tests that did not give the same answer twice

A test that fails and then passes is not retried until green and forgotten: it is written here with how often,
where, and what is known of the cause. A release-critical test is not called flaky without evidence.

| # | Test | Seen | Environment | What happened | Cause | State |
|---|---|---|---|---|---|---|
| 1 | `tests/integration/browser/app-electron.test.ts`, the teardown (`afterAll`), not a test: all 10 tests of the file passed | 1 of 1 full runs of the suite (2026-10-13, `pnpm test`, 246 files, 6 workers, commit after `6417b00`); 0 of 2 runs of the file alone right after | The owner's machine, Bitdefender active, the suite's other files running beside it | `rmSync` of `C:\ProgramData\NexusSandbox\worktrees\app-electron-tests` was refused (EPERM) for 30 tries, 9 s, after `apps.stopAll()` had returned | Not established. Something still held the directory: a process of the application under test that had not ended when `stopAll` returned, or the antivirus reading what Electron's installer had just written. The first would be a product defect (a stop that returns before the job is gone); the second an environment effect | OPEN. To be decided by measurement: record which process holds the directory when the removal is refused. Until then the full suite's file count is reported as it was: 245 of 246 files, 4,769 of 4,769 tests |
| 2 | `tests/e2e/v4.spec.ts:200`, "background engineering is off by default, runs only when enabled, and only proposes" | 1 of 2 full runs of the end-to-end suite on 2026-10-13 (the second, on the source with the operational-autonomy pillar); 0 of 3 runs of the test alone right after; 0 of 1 full runs earlier the same day | The owner's machine, the built application, the whole suite in sequence | `locator.check` on the checkbox `background-kind-test_gap_analysis`: the click was made and the checkbox did not change state | Not established. A click that lands while the section is being rendered again would look like this. This release added a push of progress to the window on every event of a mission, which makes such a moment more likely while a program runs; that is a suspicion, not a finding | EXPLAINED AND FIXED (2026-10-16, 0.9.1): seen again in the full end-to-end run of the 0.9.1 release, 0 of 1 run alone right after. The error named the element as `<input disabled ...>`: the test waited for the runtime to report the setting enabled, and clicked before the window had drawn it. A race of the test, not of NEXUS (the window draws the setting on its next read). The test now waits for the checkbox to be enabled before clicking it |

## Runs of the full suite on this branch

| Date | Commit | Files | Tests | Duration | Note |
|---|---|---|---|---|---|
| 2026-10-13 | after `6417b00` (lint cleanup) | 245 of 246 | 4,769 passed, none failed | 810 s | flake 1 |
| 2026-10-13 | `ed9c18a` (part one, packaged) | 247 of 247 | 4,773 passed | 787 s | end-to-end 42 passed, 3 skipped |
| 2026-10-13 | `ba51995` (pillar integrated) | 269 of 271 | 5,179 passed, 3 failed | 911 s | the 3 were two architecture guards objecting to the new network module (a file named after the power controller, a process started outside the runners): corrected in the next commit |
| 2026-10-13 | the commit after it (guards satisfied) | 271 of 271 | 5,182 passed | 980 s | end-to-end 41 passed, 1 failed (flake 2), 3 skipped |
