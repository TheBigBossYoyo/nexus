Bug: while a boundary request of a mission waits for the owner's decision, the progress panel says only "Waiting for your decision on a boundary request", even when other tasks of the mission keep working.

Seen in a real mission (2026-10-15): one task's command waited for a boundary decision, and for two minutes the stage said only that while two other tasks were implemented and verified. The owner cannot tell that work goes on, and the remaining-time estimate is withheld ("when that ends is not known").

Expected:
- When the mission waits on a boundary request but at least one task is running (or in its checks, review or verification), the stage says what is being worked on, as when nothing waits, followed by " (a boundary request waits for your decision)"; the estimate is given as usual.
- When nothing else can proceed, the stage says "Waiting for your decision on a boundary request" as today, and the estimate is withheld as today.
- Waits for the network or for the provider stop the whole mission: they are unchanged.

The stage and the estimate are computed in src/main/modules/progress/estimator.ts (estimateProgress, WAIT_TEXT); add unit tests in tests/unit/progress/estimator.test.ts for the two boundary cases.

Constraints:
- Do not change anything under native/, src/main/modules/privilege/, electron-builder.yml, package.json or the database migrations.
- Do not push or tag.
