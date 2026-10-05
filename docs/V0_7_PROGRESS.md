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

## Open points

- `performance-optimization` Arena case test: load-sensitive on this machine; to be run alone in the final
  regression.
- Remaining phases: full end-to-end run, real acceptance, independent security and UI audits, fixes, final
  regression, package, release report.
