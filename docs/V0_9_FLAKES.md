# NEXUS 0.9: tests that did not give the same answer twice

A test that fails and then passes is not retried until green and forgotten: it is written here with how often,
where, and what is known of the cause. A release-critical test is not called flaky without evidence.

| # | Test | Seen | Environment | What happened | Cause | State |
|---|---|---|---|---|---|---|
| 1 | `tests/integration/browser/app-electron.test.ts`, the teardown (`afterAll`), not a test: all 10 tests of the file passed | 1 of 1 full runs of the suite (2026-10-13, `pnpm test`, 246 files, 6 workers, commit after `6417b00`); 0 of 2 runs of the file alone right after | The owner's machine, Bitdefender active, the suite's other files running beside it | `rmSync` of `C:\ProgramData\NexusSandbox\worktrees\app-electron-tests` was refused (EPERM) for 30 tries, 9 s, after `apps.stopAll()` had returned | Not established. Something still held the directory: a process of the application under test that had not ended when `stopAll` returned, or the antivirus reading what Electron's installer had just written. The first would be a product defect (a stop that returns before the job is gone); the second an environment effect | OPEN. To be decided by measurement: record which process holds the directory when the removal is refused. Until then the full suite's file count is reported as it was: 245 of 246 files, 4,769 of 4,769 tests |

## Runs of the full suite on this branch

| Date | Commit | Files | Tests | Duration | Note |
|---|---|---|---|---|---|
| 2026-10-13 | after `6417b00` (lint cleanup) | 245 of 246 | 4,769 passed, none failed | 810 s | flake 1 |
