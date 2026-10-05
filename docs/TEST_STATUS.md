# Test Status

Factual status as of 2026-10-05 02:10 (+01:00), version 0.3.0, branch `nexus-0.3` (released as `v0.3.0`). Details and evidence:
`docs/V0_3_RELEASE_REPORT.md`. The 0.2.1, 0.2.0 and 0.1 sections below are the earlier records, unchanged.

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
