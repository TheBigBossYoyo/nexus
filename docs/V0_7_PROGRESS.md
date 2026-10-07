# NEXUS 0.7 Progress

Working log of the mission "finish NEXUS 0.7: Secure Control Plane" on branch `nexus-0.7`. The design is in
`V0_7_DESIGN.md`; the verdict, when there is one, is in `V0_7_RELEASE_REPORT.md`. Entries are dated 2026-10-05
unless they say otherwise. Numbers are what was measured on this machine at that point; the final numbers are
in the release report.

## Phase 1: preserve the overnight results, baseline

- STATUS: done.
- The working tree was clean. The four overnight documents (`OVERNIGHT_FINAL_REPORT_0_3_TO_1_0.md`,
  `ONE_DOT_ZERO_READINESS.md`, `V0_7_RELEASE_REPORT.md`, `OVERNIGHT_0_3_TO_1_0_READINESS.md`) were already
  committed in `a6ffcd3`. Nothing had to be committed separately.
- Release history: `README.md` has a "Release history and supported versions" section. 0.6.0 is the minimum
  recommended line; 0.2.1 to 0.5.0 are kept as tags and not recommended, because they lack the two fixes of
  0.6.0. The `v0.5.0` tag does not contain the 0.5.0 state of `TEST_STATUS.md` and `BUILD_PROGRESS.md` (commit
  `f8e5a67` came 28 seconds after the tag); those pages and `V0_5_RELEASE_REPORT.md` now say so. No tag was
  moved or deleted. Commit `2d1e4db`.
- Baseline at `a6ffcd3` (before any change): typecheck and lint pass; `pnpm test` 141 files, 2687 of 2688
  passed. The one failure is `tests/integration/arena/builtin-cases.test.ts`, case `performance-optimization`:
  its timing evaluator timed out on the unmodified fixture while other work loaded the machine. It is a
  load-sensitive test that predates this mission; see "Open points".

## Phase 2: design

- STATUS: done. `V0_7_DESIGN.md`.
- Decisions: one executable with three roles (window, runtime, worker); the runtime core imports nothing from
  Electron and has two hosts (Electron for the app, plain Node for tests); named pipe with mutual HMAC
  handshake over a token in a user-only file; the dispatcher and the closed channel contract of 0.6 are reused
  unchanged behind the pipe; one agent session per worker process under a durable lease.

## Phases 3 to 5: persistent runtime, typed IPC, reconnect

- STATUS: implemented and tested.
- `src/main/index.ts` was the whole application. It is now the role switch. The former bootstrap is
  `src/main/runtime/core.ts`; `src/main/runtime-electron.ts` and `src/main/runtime-node.ts` host it;
  `src/main/desktop.ts` is the window process and a client.
- Protocol: `src/shared/runtime-protocol.ts`; server, client, framing, endpoint file in
  `src/main/modules/runtime/`.
- Found while testing: a window could be used before its runtime had answered. The renderer now shows the
  startup state, and the end-to-end launcher waits for `READY`.
- Found while testing: the runtime waited for the overnight supervisor's recovery before it reported `READY`;
  that recovery lasts as long as the run. It is started and no longer waited for.
- Found while testing: quitting the window's process during an overnight run asked the "hide to tray" question
  and never quit. Quitting the process asks nothing now; closing the window still asks.

## Phase 6: worker manager

- STATUS: implemented and tested.
- `src/shared/workers.ts`, `src/main/modules/workers/`, `src/main/worker.ts`, migration 010.
- Found while testing: the lease was released when the worker reported the end of the assignment, a moment
  after the session's own end event. A session started again at once for the same agent (a rotation) would have
  found its own old lease. The lease now ends with the session's end event.
- Found while testing: a mission the runtime lost before the queue had adopted it (killed within two seconds
  of its start) had no queue item and was never resumed with `resume` chosen. Interrupted missions without an
  item are resumed too.

## Phase 7 and 8: scheduler, schedules, notifications

- STATUS: implemented and tested.
- Aging (`agingMinutes`, default 30), dispatch pause, decision records, schedule firing records (an occurrence
  fires once across restarts), health component `schedules`, state `FINALIZING` in the model.
- A program now asks the queue for what its own policy allows (`policy.maxAgents`), not for the global default.
  Before, a program asked for the default four agents and, with a capacity of three, left nothing for a second
  workload until it had finished.
- Notifications wired in the runtime: work item failed, workload blocked (every type), usage wait and its end,
  schedule started, milestone completed, Arena regression, overnight run ended, tool call refused by the
  execution policy. The restraint rules of 0.7's first cut apply to all of them.

## Phases 9 to 12: execution security

- STATUS: implemented and tested. See `SECURITY.md`, section "0.7: execution security".
- Trust classes, capabilities per role, interpreter policy, package-script resolution with provenance against
  the run's base commit, content inspection, execution profiles `STANDARD` and `RESTRICTED`, the security
  decision log (migration 011, channel `security.decisions`), filesystem boundary hardening, an adversarial
  corpus of about 210 cases, malicious repository fixtures with harmless sentinel payloads.
- Not a sandbox. The classes of bypass that remain are listed in `SECURITY.md` and in the release report.

## Phase 13: Control Center

- STATUS: implemented; unit tests pass; end-to-end tests written.
- Cancel asks first for anything that has started and says what stops and what is kept, per workload type.
  Deleting a schedule asks. A failed load shows the error and Retry. Blocked and failed items have their own
  presentation and reason. Inspector with scheduler decisions. Runtime diagnostics with the worker view.
  Connection states (`STARTING RUNTIME`, `CONNECTING`, `RECOVERING`, `READY`, `CONTROL PLANE DISCONNECTED`).
  Security decisions panel. Execution profile in Settings.

## Phases 14 to 16: tests, stress, adversarial tests

See the release report for the counts. New suites:

- `tests/unit/workers/manager.test.ts`, `tests/integration/workers/worker-process.test.ts` (real worker
  processes: crash, kill while waiting, kill while idle, hang, stop, runtime gone).
- `tests/integration/runtime/runtime-process.test.ts` (real runtime process: start, authentication, closed
  contract, client gone while a mission runs, kill and reconnect, clean stop, idle exit, program and Arena
  together, worker killed mid-mission, runtime killed mid-mission, schedule with no window).
- `tests/integration/control-plane/scheduler-07.test.ts`.
- `tests/stress/control-plane-runtime-stress.test.ts` (workers, leases, schedules and runtime restarts;
  two deliberate defects, a lease not ended on worker loss and a schedule claim skipped, were each caught at
  seed 1).
- `tests/stress/soak-runtime.test.ts` (opt-in soak of the real runtime process).
- Security: `tests/unit/policies/adversarial-corpus.test.ts`, `filesystem-boundary.test.ts`,
  `execution-units.test.ts`, `tests/integration/security/`.

## Phase 17: real acceptance (2026-10-06)

- `scripts/v07-acceptance.mjs`: a small program and a one-trial Arena campaign through the global queue with real
  Claude sessions in worker processes; the window is closed in the middle and opened again; one worker that holds
  a real session is ended from outside.
- Run 1: 9 of 14 gates. The run itself completed, but the script closed the window with Playwright's `close`,
  which waits for the output streams of the process it launched; the runtime that process started holds them
  open, so `close` returned only when the runtime had stopped by itself, minutes later. Nothing of NEXUS was
  wrong; the script could not observe what it was written to observe. The script now closes the window as a user
  does. Evidence kept: `docs/acceptance/v07-acceptance-2026-10-05T21-51-32-951Z.json`.
- Run 2: 13 of 14 gates. Both workloads active at once, never more than the limit of 3 agents, 10 real sessions
  in 3 worker processes, the runtime alive and working for 40 s without a window (19 run events in that time),
  the new window on the same runtime, a verifier's worker ended and its lease revoked, the task verified again
  by a new session, both workloads completed, clean stop, finished work found by a new runtime. The failed gate
  ("the window process ended") was the script's liveness check answering "alive" for a process that had ended
  (a signal check on a handle the script still held). The check now asks Windows' process list.
  Evidence: `docs/acceptance/v07-acceptance-2026-10-06T21-12-14-919Z.json`.
- A third run on the final code is in the release report.

## Phases 18 and 20: independent security review and fixes (2026-10-06)

Seven read-only reviews by reviewers that had not written the code. Each ran the real authorizer or the real Git
service on its own fixtures. What they confirmed, and what was done:

| Review | Confirmed | Fix |
|---|---|---|
| Execution policy | HIGH x5: a literal power command in shell text without a known wrapper passed; `pwsh-preview`; a value-taking package-manager flag hid the script; trailing dot, data stream, extensionless and unknown-launcher routes to a script; power API names with a suffix | `a09e2c9` |
| Process boundary | HIGH x3: a pipe client that calls itself the window answered its own power confirmation; `settings.update` could name a program to start; the token is readable by code agents may run | `b087386`: confirmations are shown by the runtime and never travel over the pipe; settings that start a program are confirmed. The third is the documented limit (allowed code runs as the user); the endpoint file and pipe are on the agent deny list |
| Providers and tools | no HIGH; MEDIUM x2 (project Claude configuration opt-in unconfirmed; agent-to-agent text unbounded and unfenced) | `9da95ce` |
| Power boundary | HIGH: `cmd /c shutdown/s` (no space before the switch); MEDIUM: assembled names; recovery requested a shutdown for a record without verifying its seal | `e4fba3a`, `9da95ce` |
| Filesystem and Git | HIGH x3, **all present in released 0.6.0**: the pointer check accepted a Git directory the agent made itself, and NEXUS's commit then moved the user's branch; `.git` with a trailing space or dot or as `GIT~1` passed the shell guard; read-only git commands ran the filters of the repository the pointer named. MEDIUM: a replacement ref stood in for the base commit; writes through paths with variables; git commands writing shared configuration | `5fe39ba` (NEXUS names the Git directory of its worktrees itself), `e4fba3a` |
| Verification of the fixes | five of six areas closed; HIGH: an allowed `git symbolic-ref HEAD refs/heads/main` or `git checkout main` turned the worktree to the user's branch and the next commit advanced it | `137f2bb` (NEXUS refuses to commit or merge off the recorded branch), and the branch invariant in the classifier |
| Verification of the branch invariant | see the release report | |

The README's release history now says that 0.6.0 has these defects.

Other findings of the day, outside the reviews:

- The built-in Arena case test for `performance-optimization` failed in every full run and passed alone: its
  slow fixture needs most of the evaluator's 120 s. The built-in cases now run in a group of their own after the
  parallel suites.
- `commitAll` passes `-c user.name=...` before the subcommand, so a check keyed on the first argument never saw
  `commit`. The subcommand is now found behind global options.

## Phases 19 to 24: UI review, final regression, package, report (2026-10-06 and 07)

- Independent UI review from 38 screenshots, measured colours and the source: the four former HIGH items fixed,
  no HIGH, eleven MEDIUM. Fixed in `8888a14`.
- Verification passes of the security fixes: the direct forms closed; the branch invariant closed after the
  symbolic-reference form was added to NEXUS's own check.
- The runtime's own confirmation dialog: a smoke test showed that it opens. The attempt to keep it off the screen
  failed (Windows puts a dialog on a display), so two dialogs were visible for about twenty seconds each during
  those runs. The corrected test was not run again.
- Soak, stresses, final suite, end-to-end, package, packaged validation, migration campaign and the third real
  acceptance run: numbers in `V0_7_RELEASE_REPORT.md`.
- Found in the last hours, by the end-to-end restart test and by the packaged validation: the window's process was
  not reaped after its window closed while its runtime lived; ending the runtime the same way lost the key of the
  overnight authorization. See "Found by running it" in the report.
- Verdict PASS; `nexus-0.7` merged into `main` without fast-forward and tagged `v0.7.0`. Nothing was pushed.

## Open points

- See "Not verified" and "Known limitations" in `V0_7_RELEASE_REPORT.md`.
