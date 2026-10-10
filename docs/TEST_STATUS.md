# Test Status

Factual status as of 2026-10-10, version 0.7.1 (`v0.7.1`, release gate PASS). Details and evidence:
`docs/V0_7_1_RELEASE_REPORT.md`. The sections of earlier versions below are their records, unchanged.

Note, 2026-10-05: tag `v0.5.0` (commit `389d95f`) does not contain the "0.5.0" sections of this page. At that tag the
page still describes 0.4.0. They were committed afterwards as `f8e5a67` ("they missed the release commit"), which is
not in the history of `v0.5.0`. The tag was not moved. See "Release history and supported versions" in `README.md`;
0.2.1 to 0.5.0 also contain security defects fixed in 0.6.0.

## 0.7.1: final source, 2026-10-10

Measured on commit `82671c8` (later commits change documents only). No Claude usage except where a row says so.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm test`, run alone | 169 files, 3,981 of 3,981 passed |
| `pnpm test:e2e` | 29 of 29 passed, 2 capture-only tests skipped by design |
| Orchestrator stress, 1,000 seeds (three processes side by side) | passed |
| Workspace and Arena stress, 5,000 seeds each | passed |
| The other eight stress suites at release sizes | passed, on `00dcddf`; the changes since do not reach them |
| `pnpm package` | `release/NEXUS-Setup-0.7.1.exe`, 208,109,581 bytes, SHA-256 `c86e9318...12d64f93` |
| Navigation benchmark (`context_open` calls an oracle walker needs) | planner 103 to 5 over 18 tuning cases, 38 to 3 over 7 held-out cases |
| Retrieval benchmark | unchanged: hybrid pack 100% and 100% recall, no non-current record shown as current |
| Real campaign against the 0.7.0 sources (real Claude, 50 runs, 8 task categories) | no case worse; quality gate NON_INFERIOR with the Context Graph off and on; with it on, six mission categories used 16.1% fewer turns and 7.5% less input |
| Real compaction fidelity (real Claude, one session, deliberate trigger) | compaction occurred; 27 of 28 facts kept, 15 of 15 that lived only in the conversation; the task continued correctly. Automatic trigger NOT VERIFIED |
| Tool-definition sharing across roles | reviewed for security and NOT ENABLED |
| Migration campaign, runtime soak | not repeated (no schema change since 2026-10-07) |
| Installer execution | NOT VERIFIED |

Two tests failed on time limits in the full run on `00dcddf`, and each led to a defect older than this release:
the workspace schema parser took 4.8 s on a hostile contract (now one pass, a few milliseconds), and the Arena
performance evaluator took 108 s of its 120 s limit (now about 40 s, same verdicts).

## 0.7.1: automated, as measured on 2026-10-07 (no Claude usage)

Measured 2026-10-07 on commit `db9c9dc` (later commits change documents and one stress invariant).

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm test` | 166 files, 3,958 of 3,958 passed, 535 s |
| `pnpm test:e2e` | 29 of 29 passed, 2 capture-only tests skipped by design, 7.5 min; no stored screenshot changed |
| Control plane runtime stress, 10,000 seeds; queue, Arena, overnight (two suites), policy, usage, program, workspace at 5,000 each; Context Graph and token accounting at 100,000 nodes, 499,994 edges, 5,000 histories, 125,000 accounting sessions | 10 files passed, 1,640 s together |
| Orchestrator stress, 1,000 seeds | passed, 2,782 s, after the invariant correction described under "Intermittent failures"; the first run: 999 of 1,000 |
| Retrieval benchmark (`pnpm bench:retrieval`), 18 tuning and 7 held-out cases | 0.7.0 selection 86.5% and 54.8% recall; hybrid pack 100% and 100%; no non-current record shown as current |
| `pnpm package` | `release/NEXUS-Setup-0.7.1.exe`, 208,079,443 bytes, SHA-256 `1528a2ae...a4da663b` |
| Migration campaign on the packaged build, ten real databases 0.1 to 0.7.0 | PASS, 9 checks each; schema 12 |
| Runtime soak, 60 minutes | not repeated for 0.7.1 |

## 0.7.1: manual and with real providers, as measured on 2026-10-07

Superseded where the section "0.7.1: final source" above says otherwise: the campaign and the compaction
check were run on 2026-10-10.

| Check | Result |
|---|---|
| `pnpm smoke:cache` (7 one-turn sessions, `haiku`) | first request writes, a later one reads, a changed prompt still reads, a changed role writes again |
| `pnpm accept:graph` (one real mission pair, graph off and on) | both completed, hidden evaluation passed, review approved, no repairs. With the graph: 45 turns against 39, cache read 345,257 against 293,515 |
| Real comparison campaign over eight task categories | NOT VERIFIED: one pair only; the weekly usage window was at about 92% |
| Compaction and rotation fidelity on real sessions | NOT VERIFIED |
| Independent reviews | three (security; graph and memory correctness; token accounting, SDK use and test quality): 3 HIGH and 11 of 12 MEDIUM fixed with regression tests |
| Installer execution | NOT VERIFIED |

## Intermittent failures (0.7.1)

- Orchestrator stress, seed 597, failed once in a 1,000-seed campaign and passed alone. A crashed task had its
  retry scheduled and was then split and cancelled by another worker's approved graph proposal before the
  retry ran; the mission completed correctly. The invariant ("a crashed task is retried") did not allow for
  that order. It now requires the retry to have been scheduled, and to have run unless a proposal cancelled
  the task. No change of the product was involved.
- Scenario tests remain sensitive to other heavy work on the machine; run the suite by itself.

## 0.7.0: automated (no Claude usage)

Measured 2026-10-07 on commit `f9cba8d` unless a row says otherwise. Details: `V0_7_RELEASE_REPORT.md`.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm test` | 158 files, 3819 of 3819 passed, 636 s |
| `pnpm test:e2e` | 28 of 28 passed, 2 capture-only tests skipped by design, 8.4 min |
| Orchestrator stress, 1,000 seeds (`0f210dc`) | passed, 5,440 s |
| Control plane runtime stress, 10,000 seeds; queue, Arena, overnight (two suites), policy, usage, program, workspace at 5,000 each (`0f210dc`) | passed, 1,213 s together |
| Runtime soak, 60 minutes, scripted sessions in real worker processes | passed: 263 of 263 missions through 4 runtime kills and 18 worker kills |
| Migration campaign, nine databases 0.1 to 0.6 (`b967cf9`) | PASS, 82 checks |
| Packaged validation of `release/win-unpacked/NEXUS.exe`, three old databases | PASS, 82 checks, including the runtime and worker processes of the package |

## 0.7.0: manual and with real providers

| Check | Result |
|---|---|
| Real acceptance, `pnpm accept:v07` (program and Arena campaign at once, window closed, worker killed) | 14 of 14 gates on the final code; two earlier runs kept as evidence |
| Independent security review | seven reviews and three verification passes; 13 HIGH confirmed, 12 fixed and verified, 1 accepted limitation |
| Independent UI review | no HIGH; the four former HIGH items fixed |
| `pnpm smoke:dialog` (the runtime's own confirmation dialog) | the dialog opens (observed); operating it: NOT VERIFIED |
| Installer execution | NOT VERIFIED |

## Intermittent failures (0.7.0)

- The built-in Arena case `performance-optimization` timed out in every full run while it shared the machine with
  six other workers, and passed alone. The built-in cases now run in a group of their own after the parallel
  suites (`vitest.config.ts`, project `arena-cases`); three full runs since were green.
- End-to-end, "the Control Center shows a failed load with Retry": the test pressed Retry after its fixture had
  begun to succeed, and the page's own refresh removed the button first. The test now presses Retry while the
  load still fails. No change of the product was involved.
- Scenario tests remain sensitive to other heavy work on the machine; run the suite by itself.

## 0.6.0: automated (no Claude usage)

| Command | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | 139 files, 2650 tests passed, 423 s |
| `pnpm stress` with `NEXUS_STRESS_RUNS=1000` | 8 files passed, 4901 s, on `b7afbcf` (before the security hardening) |
| Orchestrator stress, 100 seeds, after the hardening of NEXUS's git calls | passed |
| Overnight stresses, 5000 histories each, after the bookkeeping fix | passed |
| `pnpm test:e2e` | 24 Playwright tests passed, 1 capture-only test skipped by design |
| `pnpm package` | produced `release/NEXUS-Setup-0.6.0.exe` (207,358,553 bytes, SHA-256 `eb1a8855...de4e65ba`) |
| `node scripts/packaged-validation.mjs` on 0.1, 0.2.0 and 0.2.1 databases | 20 of 20 checks each, schema 8 |
| `node scripts/migration-campaign.mjs` (0.7 development build, nine real databases 0.1 to 0.6) | 9 of 9 checks each |

## 0.6.0: manual

| Check | Result |
|---|---|
| Mission with real Claude and a real Codex review (`node scripts/provider-acceptance.mjs`) | passed twice, 14 of 14 gates each |
| `pnpm smoke:providers` (real Codex, read-only review of a commit with a defect, a planted `codex.cmd`) | passed: the defect found, the write refused, the planted file not run |

Not verified: Gemini; heterogeneous speculation with a real second provider (Codex is read-only); a real
provider outage; the real mission on the packaged build; the installer.

## Intermittent failures (0.6.0)

Under machine load: the timing evaluator of `performance-optimization` (fixed: it measures again before it
fails), and an E2E test that did not wait for the first agent session (fixed). See the release report.

## 0.5.0: automated (no Claude usage)

| Command | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | 137 files, 2606 tests passed, 300 s |
| `pnpm stress` with `NEXUS_STRESS_RUNS=1000` | 8 files passed, 3834 s, on `e775702` (before the audit fixes) |
| Workspace and program stresses, 1000 histories each, after the audit fixes | passed |
| Program stress, 5000 histories, after the program fix | passed; seed 1552 is a permanent test |
| `pnpm test:e2e` | 22 Playwright tests passed, 1 capture-only test skipped by design |
| `pnpm package` | produced `release/NEXUS-Setup-0.5.0.exe` (207,343,181 bytes, SHA-256 `bbc711e5...625927cc`) |
| `node scripts/packaged-validation.mjs` on 0.1, 0.2.0 and 0.2.1 databases | 19 of 19 checks each, schema 7 |

## 0.5.0: manual

| Check | Result |
|---|---|
| Cross-repository mission with real Claude (`node scripts/workspace-acceptance.mjs`) | passed twice, 15 of 15 gates each, first attempt: three repositories, a shared contract, provider then consumers, global verification, a prepared release train, original checkouts untouched |

Not verified: a workspace program and an overnight workspace mission with real Claude; a real usage limit during
a cross-repository mission; a cross-repository mission on the packaged build with real Claude; the installer.

## Intermittent failures (0.5.0)

The timing-based hidden evaluator of the Arena case `performance-optimization` failed once (ratio 24.1 against a
limit of 24) in a full `pnpm test` that ran beside a stress run and other work; the file passed alone and in
the three full runs after it.

## 0.4.0: automated (no Claude usage)

| Command | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | 132 files, 2497 tests passed, 451 s |
| `pnpm stress` with `NEXUS_STRESS_RUNS=1000` | 6 of 7 files passed; orchestrator 997 of 1000 in the run (three timeouts in the first three minutes, under a full test suite on the same machine) |
| Orchestrator stress, seeds 1 to 60, alone, same commit | 60 of 60 passed |
| `pnpm test:e2e` | 20 Playwright tests passed, 1 capture-only test skipped by design |
| `pnpm package` | produced `release/NEXUS-Setup-0.4.0.exe` (207,299,109 bytes, SHA-256 `3990d228...91df3e`) |
| `node scripts/packaged-validation.mjs` on 0.1, 0.2.0 and 0.2.1 databases | 18 of 18 checks each, schema 6 |

## 0.4.0: manual

| Check | Result |
|---|---|
| Program with real Claude (`node scripts/program-acceptance.mjs`) | passed, 15 of 15 gates, first attempt: 3 milestones, 3 missions, one revision, 6 backlog proposals, 2 memory entries, a restart in the middle |

Not verified: a real usage limit during a program; a program under a real shutdown timer; a program on the
packaged build with real Claude; the installer.

## Intermittent failures (0.4.0)

The orchestrator stress has a 120 s limit per seeded run. Three seeds (13, 16, 22) exceeded it while a full
`pnpm test`, a typecheck and a lint ran beside the stress; each passed when run without that load. Run the
stress without other suites.

## 0.3.0: automated (no Claude usage), final tree

| Command | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | 126 files, 2399 tests passed, 783 s (unit, integration, scenarios, and the policy, usage, Arena and overnight stresses at 1000 seeds each) |
| `pnpm stress` with `NEXUS_STRESS_RUNS=1000` | 6 files passed in one run, 7600 s on a shared machine; 1000 orchestrator seeds, no failure dump. Started on `e4253e5`; see the release report for the conditions |
| `pnpm test:e2e` | 17 Playwright tests passed, 1 capture-only test skipped by design; 11 stored screenshots compared |
| `pnpm package` | produced `release/NEXUS-Setup-0.3.0.exe` (207,250,922 bytes, SHA-256 `2d905b9e...38e650`) |
| `node scripts/packaged-validation.mjs` on 0.1, 0.2.0 and 0.2.1 databases | 17 of 17 checks each, schema 5 |

## 0.3.0: manual

| Check | Result |
|---|---|
| `pnpm smoke:usage` (real runtime, no prompt sent) | passed: account mode and plan windows with percentages and reset times reported |
| ADAPTIVE mission with real Claude | passed, 15 of 15 gates, first attempt |
| Speculative task with real Claude | passed, 17 of 17 gates, first attempt |
| Arena campaign with real Claude (3 cases, 2 strategies) | passed, 15 of 15 gates, on the second run; the first run (14 of 15) exposed a NEXUS defect, fixed |
| ADAPTIVE mission with real Claude on the packaged 0.3.0 build | passed, 15 of 15 gates |
| Packaged build on real 0.1, 0.2.0 and 0.2.1 databases (first 0.3.0 build, 2026-10-04) | passed, 17 of 17 checks each: schema 4, no row lost, backup copy kept, redesigned pages render, built-in Arena cases found |

Not verified: a real Claude usage limit and the automatic resume after it; running the NSIS installer and
uninstaller; real sleep, hibernate and a completed shutdown; Overnight Arena under a real shutdown timer (it
is tested with the fake power controller). The real-Claude runs above were made on 2026-10-04 and were not
repeated on the final tree.

## Intermittent failures (0.3.0)

Under load (the whole suite beside the Arena case self-tests) two unit tests exceeded the 5 s default and one
Arena evaluator that compared sub-millisecond timings failed a correct solution. The unit limit is now 30 s and
the evaluator measures batches of at least 40 ms with a wide margin. The final run had no failure.

---

# 0.2.1 status (2026-10-04 13:20)

Factual status as of 2026-10-04 13:20 (+01:00), version 0.2.1, commit `10be52f` (recorded on branch `v0.2.1`,
since merged into `main` as `4062355`, tag `v0.2.1`). Details and
evidence: `docs/V0_2_1_RELEASE_REPORT.md`. The 0.2.0 and 0.1 sections below are the earlier records, unchanged.

## 0.2.1: automated (no Claude usage), final tree

| Command | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test:unit` | 46 files, 1361 tests passed |
| `pnpm test` | 80 files, 1772 tests passed (34 integration and scenario files, 411 tests) |
| `pnpm test:e2e` | 10 Playwright tests passed, run after the version bump and the last code change |
| `pnpm stress` (orchestrator, 1000 seeds) | 977 passed in three parallel ranges; 23 hit the 120 s per-run limit on a busy machine and each passed when rerun alone. No invariant failure |
| Overnight state-machine stress (1000 seeds) | passed (part of `pnpm test`) |
| `pnpm package` | produced `release/NEXUS-Setup-0.2.1.exe` (206,906,496 bytes) |

## 0.2.1: manual

| Check | Result |
|---|---|
| `pnpm smoke:power` (real Windows shutdown timer, one hour away, aborted at once) | passed; nothing left armed |
| Dynamic graph proposal with real Claude | passed, 12 of 12 gates, on the third attempt (the first two exposed NEXUS defects, fixed) |
| Session rotation with real Claude | passed, 11 of 11 gates, on the fifth attempt (see the release report for each attempt) |
| Packaged build on a real 0.1 and a real 0.2.0 database | passed: schema 3, no row lost, auth, project open, Overnight UI |
| Real mission on the packaged build | completed, mission verification passed |

Not verified: running the NSIS installer and uninstaller; real sleep, hibernate and a completed shutdown; a
real Claude usage limit; restart recovery, parallel workers and messaging with the real runtime on 0.2.1.

## Intermittent failures (0.2.1)

Scenario tests time out when the machine is busy (git process start-up was about 180 ms at the worst). They
pass on a quiet machine; wait budgets were raised and the integration project limited to six workers. The
0.1 "run ended paused" symptom did not recur; its cause is still unproven.

---

# 0.2.0 status (2026-10-04 02:35)


Factual status as of 2026-10-04 02:35 (+01:00), version 0.2.0. The section "v0.1 status (2026-10-03)" below
is the earlier record, kept unchanged.

## Automated (no Claude usage), final tree

| Command | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test:unit` | 38 files, 945 tests passed |
| `pnpm test:integration` | 29 files, 322 tests passed (includes `tests/scenarios`) |
| `pnpm test` | 67 files, 1267 tests passed |
| `pnpm test:e2e` | 4 Playwright tests passed (run after the audit fixes; not re-run after the version bump, which changed only `package.json`) |
| `pnpm stress` with `NEXUS_STRESS_RUNS=1000` | 1000/1000 seeds passed on the final orchestrator code, 4488 s, no failure dumps |
| `pnpm package` | produced `release/NEXUS-Setup-0.2.0.exe` (206,863,779 bytes) |

Earlier the same night: 1000/1000 seeds on the v0.1 orchestrator (2090 s).

## Manual, with the real Claude runtime (consumes usage)

| Check | Result |
|---|---|
| Adversarial mission on the v0.1 packaged build | Ended paused. Exercised parallel workers, dependencies, messaging, restart recovery, 9 repairs. Exposed the verifier-evidence defect |
| v0.2 acceptance mission 1 (before audit fixes) | Ended paused; 4/5 planned tasks merged. Exercised consensus planning, dual review with arbitration, review-rejection repairs, routing, context packs, outcomes, restart recovery |
| v0.2 acceptance mission 2 (final code, dev build) | **Completed**: 11/11 tasks, 51 sessions; independent `node --test` on the integration worktree: 117 pass, 0 fail |
| Packaged 0.2.0 launch (`release/win-unpacked/NEXUS.exe`) | Launched on a copy of a real v0.1 database: schema 1 → 2, old run readable, auth reported, project opened |

Not exercised with the real runtime: dynamic graph proposals, session rotation, quota pause.
Not performed: running the NSIS installer (see `docs/OVERNIGHT_BLOCKERS.md`).

## Intermittent failures

None observed during this run. The earlier once-in-35 `paused` symptom did not recur; its cause remains
unproven (see `docs/OVERNIGHT_FINAL_REPORT.md`, "Flake Investigation").

---

# v0.1 status (2026-10-03)

Factual status as of 2026-10-03, commit `4503709` plus the documentation commit that follows it.

## Automated (no Claude usage)

| Command | Result | When |
|---|---|---|
| `pnpm typecheck` | pass | last run after the hardening fixes |
| `pnpm lint` | pass | same |
| `pnpm test:unit` | 29 files, 812 tests passed | same |
| `pnpm test:integration` | 18 files, 219 tests passed (includes `tests/scenarios`) | same |
| `pnpm test` | 47 files, 1031 tests passed | same, and again after the antivirus incident below |
| `pnpm test:e2e` | 4 Playwright tests passed | before packaging the final build; not re-run since |
| `pnpm build` | pass | part of `pnpm package` |
| `pnpm package` | produced `release/NEXUS-Setup-0.1.0.exe` (about 207 MB) | final build |

### Intermittent failures seen

During repeated full-suite runs after the hardening fixes (about 35 runs in total), three single-test
failures occurred:

1. `happy-path.test.ts`: the parallelism assertion saw 1 concurrent worker instead of 2. Cause: the
   test's first worker could finish before git had created the second worktree. The test now holds
   the first worker until the second has started.
2. `collaboration.test.ts`: timed out after 20 s with the run legitimately in `verifying`, while a
   second test loop was loading the machine. Harness timeouts were raised to 60 s (test timeout 90 s).
3. `scheduling.test.ts`: a run ended `paused` instead of `completed`, once. **Cause not established.**
   Task worktree creation is now serialized with merges (concurrent `git worktree add` and ref updates
   can collide on git lock files), and the harness now logs the reason and task errors for every
   intervention pause. It did not recur in about 25 later runs, which does not prove it is fixed.

## Manual, with the real Claude runtime (consumes usage)

| Check | Result |
|---|---|
| `pnpm smoke:claude` | 3 tests passed: account info (authenticated, subscription), read-only session reporting the package name, Write attempt denied by policy |
| Installed build probe | Installed `NEXUS.exe` launched; SQLite opened; Git detected; packaged `claude.exe` reported auth and model list; a project opened |
| Acceptance mission, attempt 1 | **Failed** in planning: the policy hook denied the SDK's `StructuredOutput` tool. Fixed in the adapter. Evidence: `docs/acceptance/mission-2026-10-03T19-21-27-590Z.json` |
| Acceptance mission, attempt 2 (pre-hardening build) | Completed. Evidence: `docs/acceptance/mission-2026-10-03T19-26-27-508Z.json` |
| Acceptance mission, attempt 3 (final installed build) | Completed: 2/2 tasks, 2 parallel workers in separate worktrees, 8 SDK sessions, 2 reviews approved, 3 verifications passed, `npm test` exit 0; independent `node --test` on the integration worktree: 15 pass, 0 fail. Two medium-risk shell approvals were raised and denied by the script; the workers continued with file tools. Evidence: `docs/acceptance/mission-2026-10-03T20-45-55-133Z.json` |

Not exercised with the real runtime (covered by scripted-agent scenarios and E2E only): the repair
loop after a rejected review, inter-agent messages, quota pause, session rotation, crash recovery.

## Environment incident

After the final acceptance run, Bitdefender quarantined files on the development machine. Source
files and all commits are intact. `node_modules/electron/dist/electron.exe` is missing and could not
be restored (`Access denied`), so `pnpm dev` and `pnpm test:e2e` cannot run until it is restored
(`node node_modules/electron/install.js` once the antivirus allows it). The uninstaller of the
temporary test installation was also removed, so that installation was not uninstalled.
