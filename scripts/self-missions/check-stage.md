Show which check is running in the mission's progress, so the owner never sees a silent "Testing" for minutes.

Today the progress panel of a mission (src/renderer/src/views/run/ProgressPanel.tsx, fed by src/main/modules/progress) says "Working on: <task>" while a task's checks run, and nothing while the mission's final checks run beyond its stage.

What to do:
- In src/main/modules/progress/service.ts, follow the events 'checks.started' (payload: the commands about to run) and 'checks.completed' (payload: passed, failed) of the run, for tasks and for the mission's final checks (taskId null).
- While checks run, the snapshot's stage says which: "Running checks of <task title>: <command names>" for a task, and "Final checks: <command names>" for the mission. When they complete, the stage goes back to what it was.
- Add unit tests in tests/unit/progress/service.test.ts for: a task's checks started then completed, the mission's final checks started.

Constraints:
- Do not change anything under native/, src/main/modules/privilege/, electron-builder.yml, package.json or the database migrations.
- Do not push or tag.
