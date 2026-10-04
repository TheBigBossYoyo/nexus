# NEXUS 0.3 Progress

Factual log for branch `nexus-0.3`. Design: V0_3_DESIGN.md. Anything not listed as done is not done.

## Phase 1: housekeeping and baseline (2026-10-04) — done

- `main` contains the 0.2.1 merge commit `4062355`; tag `v0.2.1` points at it.
- Local branch `v0.2.1` was fully merged and was deleted. There is no remote. The tag was kept.
- Stale wording ("not merged into `main`", "`main` is unchanged") corrected in V0_2_1_RELEASE_REPORT.md and
  TEST_STATUS.md; commit `2b9f208` on `main`.
- Branch `nexus-0.3` created from `2b9f208`.

Baseline on `2b9f208`, run one command at a time:

| Command | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | 80 files, 1772 tests passed, 189 s |
| `pnpm stress` (default: 20 orchestrator seeds; overnight stress file) | pass, 80 s |
| `pnpm test:e2e` | 10 of 10 passed, 2.5 min |
| `pnpm package` | pass, `release/NEXUS-Setup-0.2.1.exe` rebuilt |

The 1000-seed orchestrator stress was not rerun for the baseline (about 75 minutes); it is part of the final
validation.

## Phase 2: design — done

`docs/V0_3_DESIGN.md`.

## Phases 3 to 30 — done (2026-10-04)

| Phase | State |
|---|---|
| Contracts, migration 004, repositories, IPC surface | done |
| UI design system, shell, Home, Activity, Overnight page, settings | done |
| Usage Intelligence, quota pause, automatic resume, Overnight integration | done |
| Arena core, scoring, 12 built-in cases | done |
| TaskProfiler, policy engine, snapshots, candidates, rollback, simulator, mission outcomes | done |
| Strategies and speculative execution | done |
| Usage, Arena, Policy pages; Mission Control, inspector, agents, composer redesign | done |
| Unit, integration, scenario tests; stress; E2E; stored screenshots | done |
| Independent audits (three code audits, one UI review) and fixes | done; open items in the release report |
| Real-Claude acceptance: ADAPTIVE mission, speculative task, Arena campaign | done |
| Final regression, version 0.3.0, E2E after the bump, package, packaged launch | done |
| Release report | `docs/V0_3_RELEASE_REPORT.md` |

Incidents:

- 15:00 local: three background workstreams stopped with a network error reaching the API. Nothing was lost;
  each was resumed.
- 17:30 local: the Claude account's five-hour limit was reached by the development work itself (not by NEXUS
  missions). Two workstreams stopped and were resumed after the reset at 18:10.
- 19:40 local: the first real Arena campaign left two trials waiting on a tool approval until their time budget.
  Fixed (unattended trials answer approvals) and rerun.

Not done:

- Overnight Arena with a power action (not implemented).
- A real usage limit inside a NEXUS mission (did not occur; not provoked).
- Running the installer.
- Merge into `main` and tag `v0.3.0` (left to the user).
