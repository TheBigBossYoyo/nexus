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

## Phases 3 onward (state on 2026-10-04, 16:00 local)

| Phase | State |
|---|---|
| Contracts (`src/shared/v3.ts`, `v3-read.ts`), migration 004, repositories, IPC surface | done |
| UI design system, shell, navigation, usage indicator, quota banner, Home, Activity, Overnight page, usage settings | done (phase 1) |
| Usage Intelligence, quota pause, automatic resume, dispatch gate, Overnight probe-before-resume | done |
| Arena core, scoring, 12 built-in cases with reference solutions | done |
| TaskProfiler, policy engine, learning, snapshots, candidates, rollback, simulator | done |
| Strategies (SINGLE, BUILD, SWARM, CONSENSUS, SPECULATIVE, ADAPTIVE) and speculative execution | done |
| Composition root and IPC handlers for usage, recovery, policy, Arena | done |
| Mission Control, inspector, agents, projects and composer redesign (phase 2) | in progress |
| Usage, Arena, Policy pages (phase 3) | in progress |
| Documentation | in progress |
| Independent audits (backend) | in progress |
| E2E for the 0.3 UI, visual regression | not started |
| Real-Claude acceptance (Arena campaign, speculative task, adaptive mission) | scripts written, not run |
| Fix audit findings, final regression, version 0.3.0, package, packaged launch, release report | not started |

Test state after backend integration (commit `e94e60f` plus wiring): `pnpm test` ran 112 files, 2193 tests; 2192
passed. The one failure was an exact-millisecond assertion in a new overnight quota test; the assertion was
corrected and the file passes (8 of 8, three consecutive runs). A full rerun is part of the final validation.

Real runtime, verified so far: `pnpm smoke:usage` (no prompt sent). The runtime reported account mode
`subscription` and answered its usage report in about one second with plan windows, each with a utilization
percentage and a reset time. Evidence: `docs/acceptance/usage-report-2026-10-04T14-29-45-856Z.json`.

Incidents:

- 15:00 local: the three background workstreams then running (usage, Arena, UI shell) stopped with a network
  error reaching the API. No file was lost; each was resumed from where it stopped.

Known gaps so far:

- Overnight Arena (a campaign under the overnight supervisor with a power action) is not implemented. The
  supervisor is bound to one run and its authorization, failsafe and seal are keyed on that run; it was not
  generalized. A campaign runs unattended, pauses for a usage limit and resumes by itself, and proposes policy
  candidates when it ends, but it has no end-of-campaign power action.
- A real usage limit has not occurred.
