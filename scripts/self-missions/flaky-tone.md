Show the run event 'checks.flaky' with the warning tone in a mission's event log.

The event (payload: { files: string[] }, test files that failed in a check and passed when run again alone) already has its text in src/renderer/src/views/run/eventText.ts, but eventTone gives it the default tone. A test that passes only on a second run deserves the owner's attention.

What to do:
- In eventTone (src/renderer/src/views/run/eventText.ts), 'checks.flaky' has the 'warning' tone.
- Add a unit test in tests/unit/renderer (the existing event text tests, or a new file) that 'checks.flaky' reads "Failed once, passed when run again: a.test.ts, b.test.ts" and has the warning tone.

Constraints:
- Do not change anything under native/, src/main/modules/privilege/, electron-builder.yml, package.json or the database migrations.
- Do not push or tag.
