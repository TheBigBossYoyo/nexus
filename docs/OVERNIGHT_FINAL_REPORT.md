# NEXUS Overnight Engineering Report

Run: 2026-10-03 22:35 to 2026-10-04 02:35 (+01:00).

## Final Verdict

V0.1: **PASS** on build, tests, E2E, packaging and scheduler stress; **PARTIAL** on real-runtime
validation (the real adversarial mission on the v0.1 build ended paused because of a defect that was
fixed in v0.2).

V0.2: **PARTIAL**. All eight features are implemented, tested, audited and packaged, and a real mission
completed on the fixed build. Dynamic graph proposals were not exercised by real Claude agents.

COMPUTER SHUTDOWN: **NOT PERFORMED.** The shutdown command is refused by Claude Code's permission system.
See `docs/OVERNIGHT_BLOCKERS.md`.

## Repository

| | |
|---|---|
| Initial commit | `7ea4b1e` |
| Final commit | the `release: prepare nexus 0.2.0` commit that contains this report |
| Final git status | clean after that commit |
| Final version | 0.2.0 |

## v0.1 Closure

| Item | Result |
|---|---|
| Electron | Binary present and working (restored earlier in the evening) |
| Typecheck | pass |
| Lint | pass |
| Tests | 47 files, 1031 tests pass |
| E2E | 4/4 pass |
| Build | pass |
| Package | `release/NEXUS-Setup-0.1.0.exe` rebuilt |
| Scheduler stress | 1000/1000 seeds pass on the v0.1 orchestrator (2090 s) |
| Real Claude mission | Ran on the v0.1 packaged build; ended **paused**, 40 sessions. Evidence `docs/acceptance/adversarial-2026-10-03T22-00-46-235Z.json` |
| Dependencies | Real: `report` depended on three tasks and never started while they were unfinished |
| Messaging | Real: 11 persisted `interface_change` messages routed to the dependant |
| Review | Real: 10 reviews, all approved |
| Repair | Real: 9 repair tasks, all triggered by verification failures; the repair bound ended in an intervention pause |
| Verification | Real, but failing for the wrong reason (see below) |
| Session rotation | Not exercised with the real runtime |
| Crash recovery | Real: controlled app restart mid-run; run listed as recoverable (`pauseReason: recovery`) and resumed |

Defect found by the real mission: the planner turned "tell the dependant your interface through a message"
into an acceptance criterion; the verifier could not see persisted messages and failed it on every cycle.

## Flake Investigation

- **Original symptom:** a scenario run ended `paused` instead of `completed`, once in about 35 full-suite runs.
- **Evidence:** none captured from the failing run; the assertion did not include the pause reason.
- **Root cause:** not proven. Inferred: git lock contention between concurrent `git worktree add` and ref
  updates in one repository.
- **Fix:** task worktree creation is serialized with merges (made before this run).
- **Regression:** the scenario harness now logs the reason and task errors for every intervention pause.
- **Stress iterations:** 1000 seeds on v0.1 code, 1000 seeds on final v0.2 code, plus 150 + 150 + 100 seed
  runs by the integration and fix agents. No unexplained pause in any of them.
- **Remaining uncertainty:** absence of recurrence is not proof; the original trigger was never reproduced.

## v0.2

| Feature | State |
|---|---|
| Dynamic DAG | `propose_graph_change` tool, seven proposal types, deterministic validation, approval policy, per-task and per-run limits, yield/resume, persisted revisions with UI diff |
| Consensus planning | Three independent planners, critic, synthesizer, fallbacks; candidates and critiques persisted |
| Adaptive model routing | Single `routeModel` path for every session; decisions and reasons persisted and shown |
| Agent performance | One outcome per implementing task; aggregated by role, model, category with sample counts and a minimum of 5 samples before stats influence routing |
| Repository intelligence | Static, manifest and git analysis into facts with provenance, confidence and fingerprints; refresh on open and before planning |
| Context Engine V2 | Context packs with per-entry inclusion reasons persisted for every implementing, repair and resume session |
| Adversarial review | Standard, dual and auto modes; deduplication; finding arbiter with a fail-safe |
| Mission Control | Plan inspector, revision diff, routing reasons, context tab, Performance and Intelligence views |
| DB migration | Migration 002 (nine tables, FTS mirror); no v0.1 table altered |

## v0.2 Validation

| Layer | Result |
|---|---|
| Unit | 38 files, 945 tests pass |
| Integration (incl. scenarios) | 29 files, 322 tests pass |
| Scenario | All ten scenarios from the brief have tests (`tests/scenarios/dynamic-graph.test.ts`, `v2-*.test.ts`, `audit-fixes.test.ts`, `tests/integration/persistence/v0-2.test.ts`) |
| E2E | 4/4 pass, with v0.2 assertions (plan v2 from a proposal, plan inspector, routing, context packs, performance, intelligence, revisions surviving restart) |
| Stress | 1000/1000 seeds pass on the final code (4488 s), including proposal injection, consensus, dual review and coverage assertions |
| Real Claude acceptance | Mission 1 (before fixes): paused, 4/5 planned tasks merged. Mission 2 (fixed build): **completed**, 11/11 tasks, 51 sessions, about 19 minutes. Independent `node --test` on the result: 117 pass, 0 fail |

Real mission 2 exercised: consensus planning (three valid candidates, critic, synthesis), three concurrent
workers, dependencies, persisted messages, dual review with arbitration, two rejected reviews and four
failed verifications leading to five repairs that then passed, routing decisions for every session,
repository facts in context packs, a controlled restart and recovery, mission-level verification. It did
not exercise a dynamic graph proposal (the plan already contained the prerequisite) or session rotation.

Evidence: `docs/acceptance/v02-acceptance-2026-10-03T23-32-39-266Z.json` (mission 1) and
`docs/acceptance/v02-acceptance-2026-10-04T00-36-19-550Z.json` (mission 2).

## Independent Review

Four read-only reviewers covered architecture and persistence, concurrency and scheduler, security and
Windows/Electron, and test quality.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 5 from the audit (one reported twice), plus 1 found by the real mission |
| Medium | 12 groups, including five test-quality gaps |
| Low | 3 |

Fixed: all high and medium findings, and the low cleanups, each with a test except two low cleanups and
one tool-schema restriction (covered only on the orchestrator side). High findings were: graph approvals
expiring with the proposer's session; agents able to send `user_instruction` and `review_finding`
messages; unsanitized agent text presented as authoritative evidence; writing proposals rejected outside
BUILD mode; no run-wide bound on proposal-created tasks; evidence missing messages received by a task.

Deferred: none of the reported findings. Not addressed because out of reach of a name-based check: a
public DNS name that resolves to a private address in the WebFetch policy (carried over from v0.1).

## Windows Release

| | |
|---|---|
| Build | pass |
| Installer | `release/NEXUS-Setup-0.2.0.exe`, 206,863,779 bytes |
| SHA-256 | `f604bcf1fff4d6c0893c6cd747a3538960d2d3d0d11d9de072b3064f5bc4df5b` |
| Launch | Verified on `release/win-unpacked/NEXUS.exe` (version 0.2.0, packaged): started on a copy of a real v0.1 database, schema migrated 1 → 2, the v0.1 run (13 tasks, 40 agents) stayed readable, auth reported subscription, a project opened, a UNC path was rejected |
| Installer run | Not performed (antivirus behaviour detection killed a session during a silent uninstall earlier that day) |

## Known Limitations

- Dynamic proposals are unverified with real agents.
- The shell-command classifier treats a `git commit -m "$(cat <<EOF ...)"` heredoc as needing approval;
  real workers hit this and fell back to other commit forms after the request was denied.
- Fast-tier workers needed repairs on most tasks in the real missions (first-pass rate 1/5 and 3/5).
- A real mission of five small tasks used 42 to 51 sessions; dual review triples review sessions.
- Repository analysis is regex-based and bounded; fingerprints use size and modification time.
- Results are still merged into the user's branch by hand.
- See README.md for the full list.

## Remaining Work

1. Exercise `propose_graph_change` and session rotation with real agents.
2. Install the 0.2.0 installer by hand and add an antivirus exception or sign the build.
3. Relax the commit-heredoc classification for writing roles inside their worktree.
4. Notify the proposing agent when an approval-gated proposal is decided.
5. Remove the leftover temporary installation and mission directories.

## Evidence

- Commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:unit`, `pnpm test:integration`,
  `pnpm test:e2e`, `pnpm build`, `pnpm package`, `pnpm stress` (`NEXUS_STRESS_RUNS=1000`),
  `node scripts/adversarial-mission.mjs release/win-unpacked/NEXUS.exe`,
  `node scripts/v02-acceptance-mission.mjs`.
- Logs (not committed): `test-results/baseline.log`, `stress-v01.log`, `stress-v02-final.log`,
  `adversarial-v01.log`, `v02-acceptance.log`, `v02-acceptance-2.log`.
- Files: `docs/OVERNIGHT_RUN.md` (chronological log), `docs/V0_2_DESIGN.md`, `docs/acceptance/`.
- Commits after `7ea4b1e`: stress campaign and design; v0.2 contracts and foundations; dynamic graph;
  consensus, routing, outcomes, context, review; E2E extension; audit fixes; docs; release.

## Shutdown

Final report saved. Repository preserved and committed. The machine was **not** scheduled for shutdown:
the command was refused by the permission system and was not worked around.
