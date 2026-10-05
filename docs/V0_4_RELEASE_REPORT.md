# NEXUS 0.4.0 Release Report

Date: 2026-10-05 (built and validated 2026-10-04 23:40 to 2026-10-05 03:12, +01:00). Branch `nexus-0.4`, 0.4.0 in
`package.json`. Released by the unattended overnight release train the user authorized: merged into `main` with
`--no-ff` and tagged `v0.4.0`.

## Verdict

**PASS**, with the items under "Not verified" stated.

The 0.4 gate was: the core Program architecture, tests, E2E, package, a real acceptance run and audits. Each
holds; the sections below give the evidence.

## What 0.4 is

0.4 goes from "execute a mission" to "pursue an engineering goal across many missions and milestones".

| Area | What exists |
|---|---|
| Programs | A goal with success criteria, a roadmap of milestones with dependencies, one mission per milestone, a program branch (`nexus/program-<id>`) that only ever fast-forwards to accepted work |
| Planner | A read-only Claude session proposes the roadmap as JSON; NEXUS validates it (unique keys, known dependencies, no cycle) and, by policy, holds it for the user's approval with a diff |
| Execution loop | Deterministic: plan, mission, gates, verifier judgment, backlog and memory, reassessment. Claude proposes; NEXUS decides by rules that are in the code |
| Milestone verification | Hard gates (mission completed, checks passed, result commit readable, no blocking finding, result contains the program branch) and a verifier judgment that must cover every criterion |
| Backlog | Persistent items with category, severity, evidence and state, from verification, failed missions and background analysis |
| Replanning | Reassessment after rejections, failures or on request; a revision is stored with a diff and cannot reuse a cancelled key or silently drop all remaining work |
| Memory | Validated entries only (patterns that look like instructions or secrets are refused), selected per mission |
| Budgets, usage, windows | Mission, session and time budgets; a usage limit is a wait, not a failure; work windows; a program as an overnight workload for one window |
| Background engineering | Off by default; read-only runs; proposals only |
| UI | Programs list, new-program dialog with presets, program page (state, plan approval with diff, roadmap with evidence, missions, plan history, decisions, backlog, memory, expertise), background card, Home section |
| Persistence | Migration 006, additive, 11 tables; schema 6 |

Documents: `PROGRAMS.md`, `LONG_HORIZON_AUTONOMY.md`, `BACKGROUND_ENGINEERING.md`, README "What's new in 0.4".

## Test results

Commit under test: `8dcf855` (and `c75b8db` for the stress, see the note). The commit that carries this report
adds documents only.

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | 132 files, 2497 tests passed, 451 s |
| `pnpm stress` with `NEXUS_STRESS_RUNS=1000` | 6 of 7 files passed in the run; the orchestrator file reported 997 of 1000 seeds. See the note |
| Orchestrator stress, seeds 1 to 60 again, alone | 60 of 60 passed, 176 s |
| `pnpm test:e2e` | 20 of 20 passed (1 capture-only test skipped by design), 7.0 min, after the version change |
| `pnpm package` | pass |
| Packaged build on real 0.1, 0.2.0 and 0.2.1 databases | pass, 18 of 18 checks on each |

Note on the stress run. It ran in a second checkout (`%LOCALAPPDATA%\NexusValidation`, a plain clone with its own
install) on `c75b8db`, which differs from `8dcf855` by the merge of the 0.3 release documents, one check added
to the packaged-validation script and one evidence file; no source or test file differs. The run took 4741 s.
The program stress (1000 histories), the policy, usage, Arena, overnight and overnight-workload stresses (1000
each) passed. In the orchestrator stress, seeds 13, 16 and 22 ended with "did not settle: Timed out waiting for
a final run state". All three fell in the first three minutes, when a full `pnpm test` of 0.3, a typecheck and
a lint were running on the same machine; seeds 23 to 1000 had no failure. Seeds 13 to 22 were then run alone
(10 of 10, 34 s) and seeds 1 to 60 again (60 of 60, 176 s), on the same commit. So every seed from 1 to 1000
has passed on this commit, in two runs rather than one. No invariant was violated in any run.

Tests new in 0.4:

- `tests/unit/program/program-model.test.ts` (states, milestones, planner schema, plan validation and diff,
  work windows).
- `tests/integration/program/engine.test.ts`: multi-milestone completion, gate rejection, verifier rejection
  with backlog and memory, a failed mission to the backlog and a stored revision, plan approval, usage wait
  and resume, closed gate, the `stop` policy, an endless wait, restart in the middle of a mission and of a
  verification, work windows, selective memory, refused memory, unreadable plans, budgets, user actions,
  strategy per mission, and the regression cases of the audit.
- `tests/integration/program/background-overnight.test.ts`: background jobs, a program under the overnight
  supervisor (window end), migration 006.
- `tests/scenarios/v4-program.test.ts`: a whole program on the real orchestrator with the scripted runtime.
- `tests/stress/program-stress.test.ts`: seeded histories with the invariant "the program branch contains
  every accepted result".
- `tests/e2e/v4.spec.ts`: a program from the dialog to completion; plan approval, a requested reassessment
  and a restart in the middle; background engineering.

## Real acceptance

`node scripts/program-acceptance.mjs`, real Claude Agent SDK sessions (Claude subscription), development build of the
0.4 code on 2026-10-05 00:31. **15 of 15 gates on the first attempt.** Evidence:
`docs/acceptance/program-2026-10-04T23-31-29-309Z.json`.

| Required | Observed |
|---|---|
| At least 2 milestones | 3 (two planned, one added by the revision) |
| At least 2 missions | 3, each started from the result of the one before |
| Real Claude sessions | 10 runs, 9 observed sessions |
| One replan | The user asked for a README milestone; plan v2 added it and changed the criteria of another |
| One backlog discovery | 6 proposals with evidence (3 from milestone verification, 3 from a real background job) |
| Milestone verification | 3 milestones verified with 6 gates each and 5, 5 and 3 judged criteria |
| Program memory | 2 validated entries |
| Restart recovery | NEXUS was quit in the middle of the second mission; the program continued with the same run |

The repository's own tests pass on the program branch (8 of 8, run outside NEXUS) and the user's checkout was
untouched. The run was made before the last UI fixes and the version change and was not repeated after them.

## Audit

One independent read-only code audit of 0.4 and one independent UI review of the Programs area.

| Severity | Found | State |
|---|---|---|
| Critical | 0 | |
| High | 1 | fixed |
| Medium (code) | 7 | 7 fixed |
| Low (code) | 11 | 9 fixed, 2 not fixed |
| UI review | 0 high, 5 medium, 7 low | 5 medium and 6 low fixed |

- High: the program branch could lose accepted work when a retry was accepted after a revision had another
  milestone accepted. Fixed: the branch only fast-forwards (compare-and-swap, never while checked out), and a
  retry starts from the accepted work. The stress carries the invariant.
- Medium, all fixed, each with a regression test: a judgment had to cover the milestone's criteria; a mission
  that finished around a crash was thrown away; the branch was moved unconditionally; quoted data could be
  closed early and recorded context reached mission prompts unquoted; a revision could reuse a cancelled key or
  drop all remaining work; a run created just before a crash was unknown to the program; a milestone could be
  accepted with an unreadable result commit.
- Found by the tests and the E2E and fixed: a milestone that had used all its missions could not be blocked; an
  engine error was swallowed; a resume during a usage limit under the `stop` policy; a completed mission
  rejected after a restart because of a review of a finished task; a program's own planning and verification
  sessions listed among the user's missions.
- Not fixed (low): a mission run the user cancels counts as a failed mission of its milestone; the retry
  counter of an unreadable planner answer is kept in memory only, so a restart grants one more retry.

## Packaged build

| | |
|---|---|
| Installer | `release/NEXUS-Setup-0.4.0.exe`, 207,299,109 bytes, built 2026-10-05 02:28 from `a08acf9` plus the packaged-validation check (source identical to `8dcf855`) |
| SHA-256 | `3990d22858e55c275e8e61d57619b23e6734b68722e8c483b535c270cd91df3e` |
| Installed launch, uninstall | **NOT VERIFIED.** The installer was not executed |

`release/win-unpacked/NEXUS.exe` on real databases of 0.1, 0.2.0 and 0.2.1: launches as packaged 0.4.0, schema
upgraded to 6 with no row lost and a backup copy kept, the old run readable, every page renders including
Programs, an upgraded database has no program. 18 of 18 checks each
(`packaged-validation-2026-10-05T01-31-02-603Z.json`).

## Not verified

- No program ran on the packaged build with real Claude sessions; the real acceptance used the development
  build.
- A real Claude usage limit during a program. The wait and the resume are covered by tests with the scripted
  runtime only.
- A program as a real overnight workload with a real shutdown timer. Covered with the fake power controller.
- Installer execution, as in every release so far.
- One real program of three small milestones is the whole of the real-runtime evidence. Nothing is claimed
  about long programs, large repositories or the quality of roadmaps in general.

## Known limitations

- A program works in one repository. Programs across repositories are the subject of 0.5.
- The verifier's judgment is Claude's. The gates around it are deterministic, and a judgment that does not cover
  every criterion is refused, but the judgment itself can be wrong.
- Background engineering proposes only and is off by default.
- Budgets are counted in missions, sessions and time. Subscription sessions report no reliable cost.

## Evidence

- Commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm stress` (`NEXUS_STRESS_RUNS=1000`), `pnpm test:e2e`,
  `pnpm package`, `node scripts/packaged-validation.mjs`, `node scripts/program-acceptance.mjs`.
- Committed evidence: `docs/acceptance/program-2026-10-04T23-31-29-309Z.json`,
  `docs/acceptance/packaged-validation-2026-10-05T01-31-02-603Z.json`.
- The log of the night: `docs/OVERNIGHT_0_3_TO_1_0_READINESS.md`.
