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

## Phases 3 onward

| Phase | State |
|---|---|
| Contracts, migration 004, repositories | in progress |
| UI design system and shell | not started |
| Usage Intelligence, quota pause, automatic resume, Overnight integration | not started |
| Arena core, scoring, built-in cases | not started |
| TaskProfiler, policy engine, snapshots, candidates | not started |
| Strategies and speculative execution | not started |
| Usage, Arena, Policy pages; Mission Control, inspector, agents, home, settings redesign | not started |
| Tests, stress, E2E, visual regression | not started |
| Real-Claude acceptance | not started |
| Independent audits and fixes | not started |
| Version 0.3.0, package, packaged launch, release report | not started |
