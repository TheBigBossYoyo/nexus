# NEXUS 0.7 Release Report

Date: 2026-10-07. Branch `nexus-0.7`, version 0.7.0 in `package.json`. Theme: Secure Control Plane.
This report replaces the PARTIAL report of 2026-10-05. The working log is `V0_7_PROGRESS.md`, the design
`V0_7_DESIGN.md`.

## Verdict

**PASS.**

Every item of the acceptance gate was measured on the final code and is listed below with its evidence. What was
not verified is said where it belongs and again under "Not verified". 0.7 is not a sandbox, and this report does
not say it is.

Two things a reader should know before the tables:

- The independent security review found defects on every round, thirteen of them HIGH, and three of those are in
  released 0.6.0. Twelve were fixed and the fixes verified again by reviewers who had not seen the code; one is
  an architectural limitation and is accepted as such below. The lesson (a list of patterns loses to a new spelling) is in `V0_8_PROPOSAL.md`.
- Two defects of 0.7's own were found only by running the real thing: a runtime that was cut short at exit lost
  the key of the overnight authorization, and the window's process was not reaped after its window closed. Both
  are fixed; both are described under "Found by running it".

## Control Plane

| Item | State | Evidence |
|---|---|---|
| Persistent runtime | Done. `NEXUS.exe --nexus-runtime`: a process of its own without a window, started by the window when none answers, one per data directory | `runtime-process.test.ts`; packaged validation; real acceptance |
| IPC | Done. One named pipe, mutual HMAC handshake over a token in a file restricted to the user, protocol version, request ids, push events, every request validated against the closed channel contract. No TCP listener | `tests/unit/runtime/boundary.test.ts`, `runtime-process.test.ts` |
| Renderer independence | Done. The window's process ended 250 ms after its window closed; the runtime worked on for 40 s with no window (18 run events) and the new window found the same runtime | real acceptance, run 3 |
| Global queue | Done. Six work item types, P0 to P3, eleven states, persisted order. A mission is adopted when it runs; it cannot be queued before it exists | `control-plane.test.ts`, `scheduler-07.test.ts` |
| Global scheduler | Done. One pure allocation of agent sessions and workload slots; decisions recorded when they change and shown in the inspector. Provider capacity is one number, not per provider | same; 5,000 seeded histories |
| Priority and fairness | Done. Priority, then deadline, then stored position; a waiting item rises one priority per 30 minutes (configurable), shown to be bounded and, without aging, unbounded | `scheduler-07.test.ts` |
| Worker Manager | Done. One agent session per worker process, nine states with a transition table, at most `maxAgents + 1` workers | `tests/unit/workers`, `tests/integration/workers` (real processes) |
| Leases and heartbeats | Done. A lease per assignment with an expiry; two unique indexes make "one active lease per session" and "per worker" a property of the database | same; 10,000 seeded histories |
| Worker recovery | Done. A worker that exits, is killed, hangs or outlives its lease is ended with its process tree; its session ends as crashed, never as completed | same; real acceptance (a reviewer's worker killed, the task reviewed again, the run completed) |
| Runtime recovery | Done. Stale workers and leases marked, runs paused for recovery and not judged, then resumed by rule; `RECOVERING` reported with counts | `runtime-process.test.ts` (runtime killed mid-mission); E2E restart tests |
| Schedules | Done. Owned by the runtime, fire with no window, one firing per occurrence across restarts (claim, queued work and next time in one transaction) | `scheduler-07.test.ts`, `runtime-process.test.ts`, stress |
| Notifications | Done. Work failed, workload blocked, usage wait and its end, schedule started, milestone completed, Arena regression, overnight run ended, tool call refused; one per subject in ten minutes, four per quarter hour | `notifier-tray.test.ts`. Not verified on screen |
| Database ownership | Done. The runtime is the only process that opens `nexus.db` | design; soak (4 runtime kills, no corruption) |
| Tray | Done. Belongs to the runtime; states, open, Control Center, pause dispatch, stop (asks first) | model test. Not verified on screen |

## Execution Security

| Item | State |
|---|---|
| Trust model | Five trust classes; every shell decision carries one. `SECURITY.md`, "0.7: execution security" |
| Capabilities | Nine capabilities mapped to roles. `SYSTEM_CHANGE` is granted to no role |
| Interpreter handling | Interpreters recognised by family, the script or inline code they run is read, agent-written scripts are judged by content and profile, stdin-fed interpreters count as inline code |
| Package-script handling | The script body is resolved (workspaces, pre and post hooks), compared with the run's base commit and judged; unknown flags fail closed; `script-shell`, package-manager config files and `npm_config_*` are judged |
| Filesystem boundaries | One path normaliser for the file tools and the shell (case, trailing dots and spaces, data streams, 8.3 names, UNC, device paths, drive-relative paths, links); writes through unresolved variables or provider prefixes ask |
| Git and worktree protection | Stronger than 0.6. For its own worktrees NEXUS names the Git directory and checks the branch from its own record and never reads the `.git` pointer; replacement objects are not read; agents' git commands cannot change the worktree's branch or write refs directly without a question |
| Restricted mode | `RESTRICTED` profile: no inline interpreter code, approval before agent-written scripts, no network tools unless allowed, tool reads limited to the worktree. Its text says it is not a sandbox |
| Security events | Every refusal, question and audited allowance is stored (bounded) with classification, provenance, reason and policy version; shown in the Control Center |
| Power boundary | Direct power commands, the known wrappers and APIs are refused and cannot be approved. Only the overnight supervisor reaches the power controller, under a sealed authorization that is confirmed in a dialog of the runtime process |
| Regression corpus | 916 data-driven cases, plus 46 filesystem boundary tests with real junctions, plus malicious repository fixtures whose payloads only write a marker file |

**Full OS sandbox: NO.**

Exactly: NEXUS reads what an agent asks to run and decides. It does not confine what runs. Code that NEXUS allows
(a test file run by the test runner, a build script, a compiled program, a command assembled at run time) runs as
the Windows user and can do what the user can: start processes, write outside the worktree, write the user's
branches with git, read the runtime's endpoint file and call the runtime, call the Windows shutdown API. Nothing
in 0.7 stops that; the patterns stop the obvious and the careless and leave a record. Codex sessions are not
authorized per tool call by NEXUS at all; their boundary is the provider's own read-only mode. Confinement by the
operating system is the subject of 0.8.

## UI

| Item | State |
|---|---|
| Control Center | Health, workers, Claude, dispatch; active, waiting, scheduled, needs attention, finished; inspector with reason and scheduler decisions; runtime diagnostics with the worker view; refused commands |
| Blocked workload | Own "Needs attention" card, badge, the reason, a button to the workload's own page |
| Cancel confirmation | Asks for anything that has started; says what stops, that sessions are stopped and not drained, and what is kept, per workload type; the safe button has the focus |
| Delete confirmation | Asks; names the queued work that stays |
| Failure state | Error text with Retry that stays pressable while the load is tried again; diagnostics stay reachable |
| Runtime states | Starting, connecting, recovering (with counts), disconnected with Retry and Diagnostics; while out of contact nothing outside the banner shows a live-looking state |
| Responsive | No overlap or page scroll at 1024 and 1100 px in the reviewed screenshots |
| Accessibility | Contrast of the nine measured pairs between 5.0 and 17.8 (light) and 6.9 and 14.9 (dark); focus goes to the safe choice and returns to the trigger. Keyboard traversal and screen reader output: NOT VERIFIED |

Independent UI review (static: screenshots, measured colours, source): all four former HIGH items FIXED, no HIGH
found, eleven MEDIUM and several LOW, all addressed in `fix(ui): findings of the independent UI review`. Left
open, LOW: rows inside the dimmed page keep their last badge; one date tooltip still uses the system locale.

## Real Acceptance

`scripts/v07-acceptance.mjs`, real Claude sessions (Claude subscription), development build 0.7.0, disposable repository.
Run 3, on the final code: **14 of 14 gates**. `docs/acceptance/v07-acceptance-2026-10-07T03-16-49-044Z.json`.

- A two-milestone program (P1) and a one-trial Arena campaign (P2) through the global queue, active at the same
  time, never more than 2 of the 3 allowed agent sessions, 12 real sessions in 3 worker processes, no lease
  violation in any sample.
- The window closed in the middle: its process gone after 250 ms, the runtime alive, 18 run events in the 40 s
  without a window, the reopened window on the same runtime.
- A worker holding a real reviewer session ended from outside: worker `FAILED`, lease `REVOKED`, a new reviewer
  session, the task and the run completed.
- Program `COMPLETED` (both milestones at the first attempt), campaign `completed` (trial passed), no active
  lease left, clean stop, and a new runtime found both finished items in the database.
- 8 security decisions recorded during the run (7 refusals of read-only roles' commands, 1 audited allowance).
- 13 sessions, 81 turns, about 52,000 new tokens in and out.

Runs 1 and 2 are kept as evidence. Run 1: 9 of 14; the script closed the window with a call that waits for the
runtime. Run 2: 13 of 14; the script's liveness check was wrong. A further run stopped on a script error when the
worker it chose had already ended. In all of them the product behaved as in run 3; `V0_7_PROGRESS.md` has the
details.

## Tests

Final code, commit `f9cba8d` (the commit that carries this report adds documents, evidence and one test file).

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm test` | 158 files, **3819 of 3819** passed, 636 s (0.6.0: 141 files, 2688 tests) |
| `pnpm test:e2e` | **28 of 28** passed, 2 capture-only tests skipped by design, 8.4 min, on the build that was packaged |
| Migration campaign, nine real databases 0.1 to 0.6 | PASS, 82 checks: every schema upgraded to 11 in order, a backup kept, no table lost a row, every old run readable (`migration-campaign-2026-10-07T02-42-25-600Z.json`; run at `b967cf9`, one commit before the final one, which changed how the runtime exits and one button) |
| Packaged validation, three old databases | PASS, 82 checks, including: the runtime is a separate process of the packaged executable, the endpoint file is restricted, a worker starts from the packaged entry and reports the provider runtimes, the window process ends and the runtime goes on, a new window finds it, Stop ends it, no worker outlives it (`packaged-validation-2026-10-07T03-13-40-220Z.json`) |

The built-in Arena case tests now run in a group of their own after the parallel suites: the performance case's
slow fixture needs most of its 120 s and timed out beside six other workers in every full run.

## Stress

All passed. Run at commit `0f210dc` (version 0.7.0). The three commits after it changed one test, the two Electron
entry files and one renderer button; no stress suite loads any of them.

| Suite | Seeds | Time |
|---|---|---|
| Orchestrator | 1,000 | 5,440 s |
| Control plane runtime (workers, leases, schedules, runtime restarts) | 10,000 | within the 1,213 s below |
| Control plane queue | 5,000 | " |
| Arena, overnight, overnight workloads, policy, usage, program, workspace | 5,000 each | 1,213 s for the nine suites together |

The runtime stress was checked against two deliberate defects (a lease not ended when its worker is lost; a
schedule claim skipped): each was caught at the first seed.

## Soak

60 minutes, the real runtime process (Node host) with the scripted agent runtime in real worker processes:
263 of 263 missions finished through 4 runtime kills, 18 worker kills, 60 client reconnects, 48 dispatch pauses,
177 holds, 37 schedules. Pending timers 1.8 at the start of the last runtime and 1.3 at its end, handles 15 and
13.8, heap 32.9 and 39.6 MB, at most 4 workers, write-ahead log at most 4.2 MB, no active lease and no worker
process left. Resident memory of the last runtime rose from 148 to 254 MB while the database grew to 66 MB; the
heap did not follow, and this was not investigated further. Worktrees of finished runs are kept by design (320
directories at the end). `docs/acceptance/soak-runtime-2026-10-06.summary.json`. A soak with real provider
sessions: NOT RUN.

## Security Audit

Seven independent read-only reviews, then three verification passes, by reviewers that had not written or seen
the code. They ran the real authorizer and the real Git service on their own fixtures.

- **Critical: 0.**
- **High: 13 confirmed. 12 fixed and verified closed; 1 accepted as an architectural limitation; 0 open.**
  1. A literal power command in shell text outside a known wrapper was allowed.
  2. `pwsh-preview` was not an interpreter to the policy.
  3. A value-taking package-manager flag hid an agent-changed script.
  4. Trailing dot, data stream, extensionless and unknown-launcher routes to an agent's script.
  5. Power API names with a suffix (`InitiateSystemShutdownExW`), a WMI method call.
  6. A pipe client that calls itself the window answered its own power confirmation.
  7. `settings.update` could name a program for NEXUS to start.
  8. `cmd /c shutdown/s` (no space before the switch).
  9. The pointer check accepted a Git directory an agent made itself; NEXUS's commit moved the user's branch. **In 0.6.0.**
  10. `.git` with a trailing space or dot, or as `GIT~1`, passed the shell guard. **In 0.6.0.**
  11. NEXUS's read-only git commands ran the filters of the repository the pointer named. **In 0.6.0.**
  12. Found by the first verification pass: an allowed `git symbolic-ref HEAD refs/heads/main` or `git checkout
  main` turned the worktree to the user's branch and the next commit advanced it. Fixed on both sides and
  verified closed, including the form in which the task branch itself is made a symbolic reference.
  13. The runtime's token is readable by code that agents are allowed to run. Not fixed in 0.7: see "Accepted
  architectural limitations".
- **Medium: 13 confirmed; 12 fixed, or documented where the reviewer asked for the documentation to be corrected.** Open: git filter, text conversion and merge drivers of the repository's own
  configuration still run inside NEXUS's git commands (an agent needs an approval to write that configuration).
- **Low, open and documented:** a command substitution in the git subcommand position; an alias that already
  exists; the WebFetch private-host check is lexical; the pipe accepts read-only opens from other users until the
  handshake timer; a worktree whose branch was made a symbolic reference cannot be reset by NEXUS until repaired.
- **Accepted architectural limitations** (the reviewers' own classification): everything under "Full OS sandbox:
  NO"; a process of the same Windows user that reads the endpoint file can call every channel, and can operate a
  dialog; the reviewer of the process boundary called the token's reachability by agent-run code a regression
  against 0.6. It is one: 0.7 keeps power authorization and program-starting settings behind a dialog of the
  runtime, refuses obvious access to the file and the pipe, and what remains through the pipe is what such code
  can already do directly. The severity decision: accepted for 0.7, because the product claims no sandbox, the
  Settings and the security panel say so, `RESTRICTED` exists, the easy bypass classes the reviews found are
  closed, and the repository, path and power boundaries hold as far as `SECURITY.md` now claims them.

`README.md` records that 0.6.0 has defects 9 to 11.

## Found by running it

- **The overnight authorization after a stop.** For one build the runtime ended itself at Electron's `quit`. That
  is before Chromium saves the key that protects the overnight signing key; after a restart the authorization of
  an interrupted overnight run could not be verified and no power action was taken. The end-to-end restart test
  failed on it. The runtime now ends only through Electron's own shutdown. What stays true: a runtime that is
  killed within seconds of its very first start may not have saved that key, and an overnight run interrupted
  then ends without its power action (the safe direction).
- **The window's process.** After its complete quit sequence it was not reaped by Windows while the runtime it
  had started was alive (measured packaged and unpackaged, with and without Playwright). It owns nothing durable
  and now ends itself at `quit`. The runtime cannot do the same (see above): a stopped runtime that had started a
  window from the tray is not reaped until that window closes. It holds nothing by then.
- **A mission lost before adoption** was never resumed after a restart; a program asked for the global default
  of agents instead of its own; the lease outlived its session by a moment; `commit` was invisible to a check
  keyed on git's first argument. All fixed; see `V0_7_PROGRESS.md`.

## Packaging

| | |
|---|---|
| Installer | `release/NEXUS-Setup-0.7.0.exe` |
| Size | 207,980,538 bytes |
| SHA-256 | `0d6cf508d155ee20fa6ff5251fe5d4ba994ddf119bbb3cb1add3d74ae8aaba3d` |
| Contents | window and runtime (one executable, two roles), worker entry (`out/main/worker.js` in `app.asar`), Claude runtime unpacked, Arena cases. The Node host of the runtime is not packaged |
| Unpacked build | validated (above) |
| Installer execution | **NOT VERIFIED.** Not run, because the antivirus on this machine has quarantined unsigned NSIS installers of this project before. The installer is unsigned |

## Not verified

- Running the installer and the installed application.
- Pressing a button of the runtime's own confirmation dialog. That the runtime opens the dialog (class `#32770`,
  title "NEXUS Settings", owned by its top-most window) was observed; `pnpm smoke:dialog` exists to operate it and
  its final version has not been run. The answer is handled by the same code the end-to-end tests exercise
  through their test-only route.
- Whether that dialog comes to the front of other windows on every desktop configuration.
- Tray and native notifications on screen.
- Keyboard traversal and screen reader output of the new surfaces.
- A soak with real provider sessions; a long-lived runtime over days.
- The stress suites after the last changes to the Electron entry files and the renderer (they do not load them).
- Codex sessions in worker processes with a real Codex (the scripted provider only); the provider's read-only
  mode against power commands.
- The defects of 0.6.0 on a build of 0.6.0 (reproduced on the 0.7 branch before the fix; the code is the same).

## Known limitations

- Not a sandbox (above). 0.8 is about that.
- A mission cannot be queued before it exists; nothing creates a `background_job` item; `FINALIZING` is in the
  model and no workload reports it; the Control Center's own form queues programs only.
- No preemption: a higher priority gets the next free capacity and stops nothing.
- Capacity is one number. Work of another provider does not continue during a Claude usage wait.
- Nothing starts the runtime at Windows sign-in. Schedules fire while a runtime runs; it stays up without a window
  while a schedule is switched on, but not across a sign-out until NEXUS is opened once.
- The scripted runtime runs sessions inside the runtime unless asked otherwise; real sessions always run in workers.
- Children that detach themselves from a worker's process tree are not tracked.
- Home is as in 0.6; the Control Center is its own page.
- Confirmations for power control, trusting a case, program-starting settings and stopping with work active are
  dialogs of the background runtime, not of the window.
- Changing a setting that starts a program, or lowering the profile, now needs that confirmation.
- Several git commands agents could run unasked in 0.6 now ask (branch changes, config writes, tags, rebase).

## Recommendation

**READY TO MERGE.**

Merge `nexus-0.7` into `main` without fast-forward and tag `v0.7.0`. Do not push from this report. Because 0.6.0
has the three Git defects listed above, 0.7.0 should be treated as the minimum recommended line once merged.
