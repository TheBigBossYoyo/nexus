Show in a mission's progress feed when a test passed only when it was run again.

Since 0.9.1 the orchestrator emits the run event 'checks.flaky' (payload: { files: string[] }, the test files that failed in a check and passed when run again alone). The progress feed (milestones) does not show it yet.

What to do:
- In src/main/modules/progress/service.ts, milestoneOf turns a 'checks.flaky' event into the milestone "Passed when run again: <files>" (the file names without their folders, joined by ", ", at most three, then "and N more").
- Add unit tests in tests/unit/progress/service.test.ts: one file, and five files (three named, "and 2 more").

Constraints:
- Do not change anything under native/, src/main/modules/privilege/, electron-builder.yml, package.json or the database migrations.
- Do not push or tag.
