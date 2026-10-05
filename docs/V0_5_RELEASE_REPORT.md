# NEXUS 0.5.0 Release Report

Date: 2026-10-05 (built and validated 2026-10-05 00:40 to 05:17, +01:00). Branch `nexus-0.5`, 0.5.0 in
`package.json`. Released by the unattended overnight release train the user authorized: merged into
`main` with `--no-ff` and tagged `v0.5.0`.

## Verdict

**PASS**, with the items under "Not verified" and the open findings stated.

**Read with it: one defect of the released 0.4.0 was found and fixed during this validation (see "Defects found in
earlier releases").**

The 0.5 gate was: the Workspace core, contracts, release trains, multi-repository programs, usage and overnight
integration, tests, E2E, package, a real acceptance run and an audit. The sections below give the evidence for
each, and "Not verified" and "Known limitations" say what the evidence does not cover.

## What 0.5 is

0.5 goes from "change one repository" to "change several related repositories for one goal".

| Area | What exists |
|---|---|
| Workspaces | A set of repositories the user enrolls explicitly; each stays an ordinary project. Roles, a policy (allowed repositories, limits, review mode; publishing fixed to `never`), memory, decisions |
| Organization graph | Dependencies discovered from root manifests (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`), from contract consumers, or declared by the user, each with its provenance; dependency order and cycle detection |
| Contracts | Six kinds (OpenAPI as JSON, JSON Schema, TypeScript declarations, Protobuf, SQL `CREATE TABLE`, event schemas), read locally into a surface; versions; consumers with optional copies; `compareSurfaces` (identical, compatible, breaking, unknown) |
| Cross-repository missions | A read-only planner session proposes one task per repository; the plan is validated against the workspace and always held for the user's approval; each task is an ordinary mission in its own repository, on its own branch and worktrees, in dependency order; a later task is given the earlier ones' reports and the provider's new contract |
| Global verification | Every task completed, its checks ran and passed, its result exists; each touched contract compared against the mission's own base; every consumer in step; a release order exists. A contract version is recorded only for verified work |
| Release trains | After a verified mission: an order and version bumps, prepared and never published. The publish channel always refuses |
| Workspace programs | An ordered, user-written series of cross-repository missions; each milestone builds on the results of the earlier ones in every repository |
| Usage and overnight | A usage limit is a wait; a workspace mission can be an overnight workload (authorization and failsafe first, a report, the end action) |
| UI | Workspaces list and page with tabs: overview, graph, contracts, missions (plan approval, tasks, verification), releases, memory and decisions, policy |
| Persistence | Migration 007, additive; schema 7 |

Documents: `WORKSPACES.md`, `MULTI_REPO_ORCHESTRATION.md`, `CONTRACTS.md`, `RELEASE_TRAINS.md`, README "What's
new in 0.5".

## Test results

Commit under test: `9f030e9`. The commit that carries this report adds documents and evidence only.

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | 137 files, 2606 tests passed, 300 s |
| `pnpm stress` with `NEXUS_STRESS_RUNS=1000` | 8 files passed in one run, 3834 s, on `e775702`: 1000 orchestrator seeds, and 1000 histories each of the workspace, program, policy, usage, Arena, overnight and overnight-workload stresses. No failure dump. See the note |
| Workspace and program stresses again on the final commit, 1000 histories each | passed on `d09b2ee` (1000 each). The program stress was run again after the program fix: 5000 histories passed, and the seed that had failed (1552) is now a permanent test |
| `pnpm test:e2e` | 22 of 22 passed (1 capture-only test skipped by design), 7.9 min, on the final commit |
| `pnpm package` | pass |
| Packaged build on real 0.1, 0.2.0 and 0.2.1 databases | pass, 19 of 19 checks on each |

Note on the stress run. It ran in a second checkout on `e775702`, before the audit fixes. Those fixes changed
the workspace engine, the contract readers, the scripted demo runtime and test fixtures; they did not change
the orchestrator, the usage system, the policy engine, the Arena or the overnight supervisor. The workspace and
program stresses, which exercise what changed, were run again on the final commit. The orchestrator stress was
not run again.

An earlier full run of `pnpm test` on `e775702` had one failure: the timing-based hidden evaluator of the
built-in Arena case `performance-optimization` measured a ratio of 24.1 against its limit of 24 while a stress
run and other work loaded the machine. The file passed when run alone (16 of 16). The evaluator is 0.3 code and
was not changed.

Tests new in 0.5:

- `tests/unit/workspace/workspace-model.test.ts`: dependency order and cycles, surface comparison for each
  kind, plan validation, release planning.
- `tests/integration/workspace/engine.test.ts`: enrollment and discovery, contracts, a mission from plan to a
  prepared release train, a breaking change with a consumer left behind, a failed task, a usage wait and a
  restart, policy changes, workspace programs (chaining, block and resume, cancel), a workspace mission under
  the overnight supervisor, the regression cases of the audits, migration 007.
- `tests/scenarios/v5-workspace.test.ts`: a cross-repository mission on the real orchestrator with real
  repositories and the scripted runtime.
- `tests/stress/workspace-stress.test.ts`: seeded histories of the workspace engine.
- `tests/e2e/v5.spec.ts`: on the built app, a mission from the dialog to global verification and a prepared
  release train, and a breaking change that blocks.

## Real acceptance

`node scripts/workspace-acceptance.mjs`: real Claude Agent SDK sessions (Claude subscription), three disposable
repositories (`orders-contract` owns a JSON Schema; `orders-api` and `orders-cli` keep copies of it), one goal:
add a required `currency` to the order contract and bring the provider and both consumers in step, with tests.

Two runs, both **15 of 15 gates on the first attempt**:

| Run | Commit | Evidence |
|---|---|---|
| First, 04:12 | `659a473`, before the audit fixes | `docs/acceptance/workspace-mission-2026-10-05T03-15-21-692Z.json` |
| Second, 04:56 | `d09b2ee`, after the audit fixes (the consumers receive the contract in the token-delimited block) | `docs/acceptance/workspace-mission-2026-10-05T03-59-09-480Z.json` |

| Required | Observed (first run; the second matches) |
|---|---|
| At least 2 related repositories | 3 |
| Change the shared contract, update the provider and the consumers, add tests | The schema gained a required `currency` with the pattern `^[A-Z]{3}$`; the validator, `createOrder` and `formatOrder` were changed; the repositories' own tests went from 3, 1 and 1 to 6, 3 and 2 and pass at each result (run outside NEXUS) |
| Real Claude sessions | 10 sessions, 57 turns; each task a mission run with a worker (Sonnet), a security reviewer and a verifier (Opus) |
| Independent worktrees | Each task in worktrees of its own repository, on its own `nexus/<run>/integration` branch |
| Dependency ordering | The planner proposed contract, then API, then CLI; no consumer started before the provider had finished |
| Messaging | Each consumer's task was given the provider's new contract and the report of the task before it |
| Global verification | Passed, 13 checks; the contract compared (`compatible`: one element added), both copies equal to the provider's contract at their results |
| Verify compatibility, version | Contract version 2 recorded after verification |
| Release train | Prepared in dependency order (1.1.0, 1.0.1, 1.0.1); the publish channel refused |
| Original repositories remain clean | All three on `main` at their first commit, clean |

The plan was accepted by the script, as a user would; no approval of a tool was asked for. The second run was
made before the fix of the program engine described below, which does not touch workspace missions.

What the run does not show: it is one small mission on three tiny repositories. The contract change was
classified `compatible` although it adds a required property (see Known limitations); the consumers were adapted
because the plan said so.

## Audit

One independent read-only code audit of 0.5, one independent UI review of the Workspaces area, and the
observations of the agent that wrote the documents from the code.

| Severity | Found | State |
|---|---|---|
| Critical | 0 | |
| High | 1 | fixed |
| Medium (code) | 7 | 5 fixed, 2 documented |
| Low (code) | 8 | not fixed, listed below |
| UI review (Workspaces) | 0 high, 6 medium, 6 low | 3 medium fixed |
| Documentation pass | 16 observations | 7 fixed in code, the rest documented |

- **High, fixed:** global verification passed for a repository whose checks never ran, because the orchestrator
  records "no check commands are configured" as a passed check. A cross-repository mission could complete, and
  an overnight one end as SUCCESS, with no build or test evidence for a repository; three passages of the
  documents said the opposite. Now checks that did not run are not passed checks; a repository whose role is
  `documentation` is excused and the check says so. Regression test included. The real acceptance run was not
  affected: its three repositories each ran a check command.
- **Medium, fixed:** enrollment could write a policy read before its Git calls and so re-allow a repository the
  user had just disallowed; contract and manifest readers were quadratic on hostile input and unbounded (now
  linear, 512 KB for the lexical kinds, 256 KB for manifests); a failed read of the contract before the mission
  was taken for "new contract" (now `unknown`, which counts as breaking) and an oversized contract was cut
  silently (now refused); a consumer that keeps a copy was told to equal a contract it had been given truncated
  and escaped (now whole and verbatim in a token-delimited block); a program whose mission could not start was
  stuck, and cancelling a program left blocked missions alive.
- **Medium, documented, not fixed:** after a failed verification, Resume verifies the same results again, so a
  consumer that was left behind can only be fixed by a new mission; the TypeScript and Protobuf readers miss
  some changes (multi-line type aliases, a `service` with an options block), listed in `CONTRACTS.md`.
- **Found by the documentation pass and fixed earlier:** a later milestone that changes only consumers read the
  contract from the checkout instead of the earlier milestone's result; a run created just before a crash was
  unknown to the mission; the planner session was listed among the user's missions; Resume was offered during a
  usage wait.
- **Found by writing the E2E:** the scripted demo runtime never carried a cross-repository task to its worker,
  so the path through the built app had not been exercised before the E2E existed.
- **Low, not fixed:** the plan is validated when it is made and only the allowed list is checked again at task
  start; "one writer per repository" holds within a mission, not across missions; recovery of workspaces is
  skipped if an earlier engine's recovery rejects (the 15 second pass picks missions up); `workspace.enroll`
  accepts a path from the window as `projects.open` does; a manifest that is a symbolic link is followed;
  `workspace_tasks.repository_id` has no foreign key; `bumpVersion` leaves a non-semver version unchanged
  without a note; preparing a release twice makes two trains.
- **UI review, fixed:** the line above the tabs said "in progress" for missions that were blocked or waiting for
  approval; accepting a plan did not say what it causes; a destructive confirmation focused the destructive
  button. **Not fixed:** errors of a failed cancel or remove appear behind the dialog; a stale error can stay
  after a later success; list rows replace their content with an `aria-label` that omits the state; the tab
  strip may overflow at 1024 px; duplicate "awaiting approval" content.

## Defects found in earlier releases

Found by the reliability campaign that ran beside this validation (5000 seeded histories per engine; the
releases were validated with 1000):

- **Programs, in 0.4.0, fixed in 0.5.0.** When another milestone was accepted while a mission ran (around a
  restart), that mission's result was built on an older state of the program branch and could never be recorded
  on it. The milestone was verified, accepted by the verifier, refused by the branch and blocked, and the same
  again on every resume, with a verifier session each time. No work was lost and the branch was never moved
  wrongly; the program could not get past that milestone. Now such a result is rejected at the gates
  (`builds_on_accepted_work`) and the milestone is carried out again from the current state. Seed 1552 of the
  program stress, permanent since. `v0.4.0` is not changed; the fix is in 0.5.0.
- **Overnight, since 0.3.0, not fixed in 0.5.0.** A run that ended with a failed power action keeps its failsafe
  armed. If Windows is restarted within a minute of the failsafe being armed, the record keeps saying "armed"
  although the timer is gone. The record overstates; no power action is taken because of it. Four seeds in
  2 x 5000 overnight histories. The fix (a two second margin instead of a minute) is on the 0.6 line.

## Packaged build

| | |
|---|---|
| Installer | `release/NEXUS-Setup-0.5.0.exe`, 207,343,181 bytes, built 2026-10-05 05:14 from `9f030e9` |
| SHA-256 | `bbc711e549f7045bfebf952c8f3312e9bf8372c3e1dab7c7eabaac4f625927cc` |
| Installed launch, uninstall | **NOT VERIFIED.** The installer was not executed |

`release/win-unpacked/NEXUS.exe` on real databases of 0.1, 0.2.0 and 0.2.1: launches as packaged 0.5.0, schema
upgraded to 7 with no row lost and a backup copy kept, the old run readable, every page renders including
Programs and Workspaces, an upgraded database has no program and no workspace. 19 of 19 checks each
(`packaged-validation-2026-10-05T04-16-35-696Z.json`).

## Not verified

- A cross-repository mission on the packaged build with real Claude sessions; the acceptance used the
  development build.
- A workspace program and an overnight workspace mission with real Claude sessions. Both are covered with the
  scripted runtime and the fake power controller only.
- A real usage limit during a cross-repository mission.
- Contract kinds other than JSON Schema with real sessions.
- Installer execution, as in every release so far.

## Known limitations

- NEXUS never publishes, pushes, tags or merges. A release train is a plan the user carries out.
- `compatible` means no breaking change was seen in what NEXUS can read from the contract file. For JSON Schema,
  event schemas, Protobuf and SQL every element counts as something the provider sends, so a new required
  property is `compatible` although it breaks a consumer that produces such data.
- A plan is always held for approval, so a draft mission started overnight ends the night as a blocker; approve
  the plan first.
- The Workspaces view has no screen for workspace programs and no control to run a mission overnight; both are
  reached through the IPC channels.
- Dependency discovery reads the root manifest of each repository only.
- A repository with no check command cannot pass global verification unless its role is `documentation`.

## Evidence

- Commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm stress` (`NEXUS_STRESS_RUNS=1000`), `pnpm test:e2e`,
  `pnpm package`, `node scripts/packaged-validation.mjs`, `node scripts/workspace-acceptance.mjs`.
- Committed evidence: `docs/acceptance/workspace-mission-*.json`, `docs/acceptance/packaged-validation-*.json`.
- The log of the night: `docs/OVERNIGHT_0_3_TO_1_0_READINESS.md`.
