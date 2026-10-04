# NEXUS

NEXUS is a Windows desktop application that coordinates several independent Claude agent
sessions over one Git repository. You describe a goal. A planner agent turns it into a task graph,
NEXUS schedules the tasks in parallel (each writing task in its own Git worktree), and every task
goes through automated checks, an independent review and an independent verification before it is
merged into a per-run integration branch. You merge that branch into your own branch yourself.

Orchestration (scheduling, state machines, retries, merging, recovery) is ordinary application code
backed by a SQLite database. Claude is used only for planning, engineering work, review and
verification. NEXUS never writes to your working tree.

Documentation index: [ARCHITECTURE](docs/ARCHITECTURE.md), [ORCHESTRATION](docs/ORCHESTRATION.md),
[TASK_LIFECYCLE](docs/TASK_LIFECYCLE.md), [AGENT_RUNTIME](docs/AGENT_RUNTIME.md),
[GIT_WORKTREES](docs/GIT_WORKTREES.md), [SECURITY](docs/SECURITY.md), [RECOVERY](docs/RECOVERY.md),
[AUTHENTICATION](docs/AUTHENTICATION.md), [TESTING](docs/TESTING.md),
[V0_2_DESIGN](docs/V0_2_DESIGN.md).

## What's new in 0.2

| Feature | What it does | Where to read more |
|---|---|---|
| Dynamic task graph | A working agent can call `propose_graph_change` to add a missing prerequisite, split a task, cancel an obsolete one, rewire dependencies, change a priority or replan the open work. Deterministic code validates the proposal (unique keys, no cycles, finished tasks immutable, criteria carried over). Safe changes apply at once, the rest wait for your approval. Every applied change is a numbered graph revision (version 1 is the approved plan) that you can diff. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Consensus planning | Optional planning mode: three planners with different lenses (risk-first, parallelism-first, minimal-change) plan independently, a critic reviews them, a synthesizer writes the final plan, which goes through the normal plan validation. Falls back to the single planner when no candidate is valid. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Adaptive model routing | One router picks the capability tier of every agent session from the role policy, task risk and size, attempt number, repair severity, escalation and measured performance. The requested policy, the resolved model and the reasons are stored per agent and shown in the Agents view. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Empirical performance | When an implementing task reaches a final state, one outcome row is stored. The Performance view aggregates them by role, model and task category with sample counts; a row has to reach 5 samples before it can influence routing. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Repository intelligence | Static, manifest and Git analysis stores facts about the project (languages, modules, commands, imports, test mapping, hot files and more) with source, confidence, supporting files and a freshness fingerprint. Stale facts are excluded from agent context. | [ARCHITECTURE](docs/ARCHITECTURE.md) |
| Context packs with provenance | Every agent session gets a stored context pack that lists each candidate source (task, criteria, dependency results, decisions, repository facts, memory, messages, review findings) with why it was included or left out. The task inspector has a Context tab. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Dual review with an arbiter | Review mode `dual` (or `auto` for high-risk tasks) runs two reviewers with different lenses, merges duplicate findings, and lets an arbiter accept or reject each finding against the code. Only accepted critical or high findings request changes. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Orchestration evidence | Verifiers see sanitized records of the messages, decisions and graph proposals of a task (existence, sender, type and time are authoritative; quoted text is not). | [ORCHESTRATION](docs/ORCHESTRATION.md), [SECURITY](docs/SECURITY.md) |
| New views | Performance (Ctrl+6), Intelligence (Ctrl+7), and in the Run view a Plan inspector (candidate plans, critic findings, final plan, graph revisions with a diff, change proposals) plus a revision selector on the task graph. | |

The design and its deviations from the implementation are in [V0_2_DESIGN](docs/V0_2_DESIGN.md).

## Requirements

| Requirement | Notes |
|---|---|
| Windows 11 x64 | The only supported and packaged platform. CI runs on `windows-latest`. |
| Node.js 24 | Matches Electron 44's Node and the CI configuration. |
| pnpm | CI pins pnpm 12.8.1. |
| Git | Needed for worktrees. Developed against Git 2.53 for Windows. |
| Claude Code, logged in | Run `claude auth login` once in a terminal. See [Authentication](#authentication). |

No C++ build tools are needed: `better-sqlite3` ships a prebuilt N-API binary and the Claude binary
comes from the Agent SDK's Windows package.

## Install from source

```powershell
git clone <this repository> Nexus
cd Nexus
pnpm install
pnpm dev          # development app with hot reload
```

| Command | Result |
|---|---|
| `pnpm build` | Bundles main, preload and renderer into `out/`. |
| `pnpm start` | Runs the built bundle (`electron-vite preview`). Run `pnpm build` first. |
| `pnpm package` | `pnpm build`, then electron-builder produces an NSIS installer for Windows x64. |

The installer is written to `release/NEXUS-Setup-<version>.exe` (see `electron-builder.yml`:
`directories.output: release`, `nsis.artifactName`). The installer is not code-signed by anything in
this repository. The install location can be chosen and it is a per-user install.

## Authentication

NEXUS does not store, read or manage Claude credentials and has no login flow. Each agent is a
`claude.exe` process started by the official `@anthropic-ai/claude-agent-sdk`, and that runtime uses
whatever credentials the Claude Code runtime already has on this machine. Log in with:

```powershell
claude auth login
```

The Authentication view asks the runtime for its account information (no model call is made) and
shows one of: authenticated, authentication required, runtime unavailable, SDK error, together with
the mode the runtime reports (subscription, API key, third-party provider).

`ANTHROPIC_API_KEY` warning behaviour: if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` exists in the
environment NEXUS was started from, the Authentication view shows

> ANTHROPIC_API_KEY is present and may cause Claude usage to be billed through the API rather than
> your Claude subscription.

Settings, Claude, "Subscription Mode" is on by default. While it is on, NEXUS gives every agent a copy
of its environment with those two variables removed (your system and user environment variables are
never modified). With it off, the variables are passed through and the runtime chooses the credential.
Details and the policy caveat about third-party use of Claude subscription login are in
[docs/AUTHENTICATION.md](docs/AUTHENTICATION.md). NEXUS makes no claim about subscription limits or
cost beyond that document.

## Launching and opening a project

1. Start the app (`pnpm dev`, `pnpm start`, or the installed NEXUS shortcut). Only one instance runs;
   starting a second one focuses the first.
2. Projects view, "Open Project", and pick a folder. NEXUS resolves the Git root, then profiles the
   project read-only: package managers, languages, frameworks, scripts, and the build, test, lint and
   typecheck commands it will use as automated checks. Nothing in the folder is changed.
3. In the project, write the mission, choose a mode, a preset, a planning mode and a review mode, and start the run.

Constraints enforced by the code:

- BUILD, SWARM, REPAIR, MISSION and LOOP need a Git repository with at least one commit.
- ASK and AUDIT also work on a folder that is not a Git repository.
- Agents work from the commit that is `HEAD` when the run starts. Uncommitted changes are not
  visible to writing agents, and the UI warns about a dirty repository.

Ctrl+K opens the command palette; Ctrl+1 to Ctrl+7 switch between Projects, Run, Agents, Memory,
Settings, Performance and Intelligence.

## Run modes

All modes share the same engine. What the code does differently per mode:

| Mode | What actually differs |
|---|---|
| ASK | No planner run. NEXUS creates a single read-only `researcher` task (kind `ask`) from your prompt and starts it immediately, with no plan approval. No worktree, no review, no verification, no mission verification. Works outside Git. Read-only agents run in your project directory. |
| BUILD | Planner guidance: small DAG of bounded tasks, tests for new behaviour. |
| SWARM | Planner guidance only: maximum safe parallel decomposition, shallow wide graph, disjoint `suggestedFiles`. Real parallelism is still limited by the preset's agent cap and file-overlap serialization. |
| REPAIR | Planner guidance only: reproduce, diagnose, fix, regression test. |
| AUDIT | Planner guidance (parallel read-only review tasks, then one synthesis task depending on all of them) plus code rules: a plan containing a `worker` or `debugger` task is rejected and sent back to the planner; tasks with dependencies get kind `synthesis`, the others `audit`; adding a task with a writing role later is refused. Works outside Git. No merges happen because no task writes. |
| MISSION | Planner guidance only: features with implementation and test tasks, architect tasks first where interfaces must be settled, final integration verification task. |
| LOOP | Planner guidance only: objectively checkable mission criteria, first iteration planned as concrete tasks. The composer also sends a `maxIterations` override for LOOP. There is no separate outer loop for LOOP: iteration bounds are the repair bounds that apply to every mode (see [ORCHESTRATION](docs/ORCHESTRATION.md)). |

So BUILD, SWARM, REPAIR, MISSION and LOOP differ only in the planner prompt (and the `maxIterations`
override for LOOP). The one-line descriptions in the UI describe intent, not separate code paths.

## Planning mode and review mode

Both are chosen in the mission composer and stored in the run configuration (`planningMode`, `reviewMode`).
Runs created before 0.2 have neither field and behave as the defaults.

| Option | Values | Behaviour |
|---|---|---|
| Planning mode | `single` (default) | One planner agent, as in 0.1. |
| | `consensus` | Three planners (risk-first, parallelism-first, minimal-change) run concurrently, then a critic and a synthesizer when at least two candidates are valid. With exactly one valid candidate it is used directly; with none, the single planner runs and is told the candidates' errors. Costs several planner sessions. The composer shows a recommendation from `planning.recommend` (a heuristic on prompt length, number of deliverables, scope keywords and repository size); it is advice only. |
| Review mode | `auto` (default) | Two reviewers plus an arbiter for tasks whose risk is `high`; one reviewer for the rest (the `security_reviewer` role for high-risk tasks, `reviewer` otherwise). |
| | `standard` | Always one reviewer, as in 0.1. |
| | `dual` | Every reviewed task gets two reviewers and, when a significant finding survives deduplication, an arbiter. |

ASK runs have no planner, so planning mode does not apply to them.

## Presets

Implemented in `src/shared/settings.ts` (`presetMaxAgents`, `presetRolePolicy`):

| Preset | Parallel agents | Model tiers |
|---|---|---|
| ECO | 2 | Planner and verifier keep their configured tier. Architect, worker, debugger, reviewer and security reviewer move from `strongest` to `balanced`; researcher uses `fast`. |
| BALANCED | The "max parallel agents" setting, capped at 4 | The configured role policy. Defaults: `strongest` for planner, architect, debugger, reviewer, verifier and security reviewer; `balanced` for worker and researcher. |
| MAXIMUM | The "maximum preset agents" setting (default 8) | Same role policy as BALANCED. It only raises parallelism. |

Tiers map to model aliases in Settings (defaults: strongest = `opus`, balanced = `sonnet`,
fast = `haiku`); the runtime resolves the alias. MAXIMUM can use your Claude usage quickly; the
composer shows a warning. A run can override max agents, iterations, duration and plan approval.

## Where results end up

NEXUS never writes to your working tree or your branches. Each run creates an integration branch
`nexus/<run>/integration`, where `<run>` is the first 8 hex characters of the run id. Every task that
passes verification is merged into it with `git merge --no-ff`. The run page shows the branch name.

When the run completes, review and merge it yourself from your repository:

```powershell
git log --oneline main..nexus/<run>/integration
git diff main...nexus/<run>/integration
git merge nexus/<run>/integration
```

The integration branch is also checked out in a worktree under the data directory until the run is
cleaned up. NEXUS does not merge into your branch, push, or delete branches. See
[docs/GIT_WORKTREES.md](docs/GIT_WORKTREES.md).

## Where data is stored

| What | Location |
|---|---|
| Database (SQLite, WAL) | `%APPDATA%\NEXUS\nexus.db` (plus `-wal` and `-shm` files while running) |
| Task and integration worktrees | `%APPDATA%\NEXUS\worktrees\<run>\<task>\` |
| Electron profile data | `%APPDATA%\NEXUS\` |
| Claude session transcripts | Written by the Claude runtime itself under `~\.claude\projects\` |

This is Electron's `userData` directory; the exact path is reported by the app (`app.info` returns
`dataDir`, `dbPath`, `worktreesDir`) and the app can open it. Set the environment variable
`NEXUS_DATA_DIR` before launching to use a different directory instead (used by tests).

## Removing local data completely

1. Uninstall NEXUS from Windows Settings. The installer is configured with
   `deleteAppDataOnUninstall: false`, so the data directory survives uninstalling.
2. Delete the data directory (`%APPDATA%\NEXUS`, or your `NEXUS_DATA_DIR`). This removes the database
   and all worktree directories.
3. In every repository you used with NEXUS, drop the dead worktree registrations and the branches:

   ```powershell
   git worktree prune
   git branch --list "nexus/*" --format="%(refname:short)" | ForEach-Object { git branch -D $_ }
   ```

   `-D` is needed for branches whose commits you never merged. Skip this if you want to keep results.
4. Optional: Claude session transcripts under `~\.claude\projects\` belong to the Claude runtime,
   not NEXUS. Delete them with the runtime's own tooling or by hand if you want them gone.

## Scripts

| Script | Runs |
|---|---|
| `pnpm dev` | `electron-vite dev` |
| `pnpm build` | `electron-vite build` |
| `pnpm start` | `electron-vite preview` |
| `pnpm typecheck` | `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` |
| `pnpm lint` | `eslint .` |
| `pnpm format` | `prettier --write .` |
| `pnpm test` | `vitest run` (unit, integration and scenario projects) |
| `pnpm test:unit` | `vitest run --project unit` |
| `pnpm test:integration` | `vitest run --project integration` (includes `tests/scenarios`) |
| `pnpm test:e2e` | `electron-vite build && playwright test` (Electron UI tests, see [TESTING](docs/TESTING.md)) |
| `pnpm stress` | `vitest run -c vitest.stress.config.ts`: seeded orchestration stress campaign with scripted agents (no Claude usage). See [TESTING](docs/TESTING.md). |
| `pnpm smoke:claude` | Manual test against the real Claude runtime. Consumes Claude usage. |
| `pnpm package` | `electron-vite build && electron-builder --win nsis` |

Automated tests never call the real Claude API; they use `FakeAgentRuntime`.

Real-mission scripts (not part of any test run; each starts the app, drives it through its IPC bridge
with the **real Claude runtime**, consumes Claude usage, and writes evidence to `docs/acceptance/`):

| Command | Mission |
|---|---|
| `node scripts/adversarial-mission.mjs [path-to-NEXUS.exe]` | Four tasks (three modules and a report task that depends on them), fast-tier workers, a controlled app restart mid-run. Uses the default planning and review modes. |
| `node scripts/v02-acceptance-mission.mjs [path-to-NEXUS.exe]` | The same mission with `planningMode: consensus` and `reviewMode: dual`, plus a repository convention that needs a task no one planned, to provoke a graph proposal. Also restarts the app mid-run. |

Without an argument both launch the dev build (run `pnpm build` first). `scripts/acceptance-mission.mjs` is the
earlier single-mission acceptance script.

## Current limitations

- Packaging targets Windows x64 only; the macOS and Linux Claude binaries are excluded from the
  installer. Other platforms are not supported.
- No automatic merge into your branch and no approval-gated merge action. The `git` and `merge`
  approval kinds exist in the type definitions but nothing creates them. You run `git merge` yourself.
- Memory is a keyword index (SQLite FTS5 with bm25). There is no vector or embedding memory.
- Shell command classification is heuristic. Inline interpreter code (`python -c`, `node -e`) and
  script files are not inspected, and writing roles can run such commands without approval. There is
  no OS-level sandbox on native Windows: agents run with your user's permissions. See
  [SECURITY](docs/SECURITY.md).
- NEXUS itself runs the dependency install (`pnpm install`, `yarn install`, `bun install` or
  `npm ci`) in each new worktree and the project's check commands. These run project code and are
  not passed through the agent policy engine.
- MCP support is basic: a list of servers (stdio, http, sse) with per-role enablement. No tool-level
  permissions, no connection test, no discovery UI.
- Quota detection depends on signals from the SDK (`rate_limit_event` with status rejected, assistant
  `rate_limit` or `billing_error`, or the SDK's usage-limit message prefixes). A quota pause is never
  resumed automatically; you resume the run. NEXUS has no spending cap of its own: bounds are turns
  per agent, retries, repair iterations and run duration.
- A task interrupted while its checks were running restarts at the implement stage (the task state
  `running` does not record the stage), consuming a new attempt.
- Orphan worktree cleanup helpers exist in `WorktreeManager` (`findOrphans`, `cleanupOrphans`) but the
  application does not call them. Startup recovery only reconciles worktrees it has records for, and
  NEXUS never deletes branches.
- The planner, reviewer and verifier outputs are schema-checked, but the quality of plans and reviews
  is whatever the model produces. A passing verification means the verifier agent judged the criteria
  met, not that the software is correct.
- Single window, single instance.

### Limitations of 0.2 features

- Graph proposals are rate limited. A task may submit at most 5 proposals in total (rejected and malformed
  ones count; retries, resumes and repair sessions of the same task share the allowance), one proposal adds at
  most 8 tasks, and a proposal adding more than 3 tasks needs your approval. Run-wide, once 20 proposals have been
  applied, or 25 tasks have been added by proposals, a proposal that adds tasks no longer applies on its own
  and waits for your approval.
- Anything that touches another agent's task needs your approval: cancelling it, adding or removing a
  dependency of it, changing its priority. So does `REPLAN`. A running task other than the proposer's own can never be
  given or lose a prerequisite, and completed, failed and cancelled tasks cannot be changed at all.
- An agent whose proposal is held for approval is told to carry on and not wait. It is not notified when you
  decide; an approved change is applied to the graph when you approve it and takes effect through the scheduler.
- Repair tasks (children created by the pipeline) cannot be changed or depended on through proposals.
- Measured performance changes routing only for a (role, model, task category) group with at least 5
  outcomes whose first-pass rate is below 50%, and then promotes by one tier. Below 5 samples the Performance view
  marks the row as insufficient and routing ignores it. Outcomes are recorded only for top-level `implement` and
  `repair` tasks that completed or failed.
- Repository analysis is static: manifests, file names and sizes, regular-expression import extraction
  (JavaScript/TypeScript, Python, Go, Rust) and Git history. It is bounded (4000 files, 5 seconds, 200 000 bytes read
  per file, 200 commits of history) and never reads secret-looking files. It does not understand code semantics.
- Freshness fingerprints hash each supporting file's path, size and modification time (at most 50 files per fact),
  not content. A change that keeps size and mtime is not detected; a touched but unchanged file is reported stale.
- Facts that agents recorded (`decision` facts) are the agents' own claims; they are marked as such in the
  fact text and in the prompt. Orchestration evidence shown to verifiers contains agent-written text (subjects,
  titles) that is not proof of anything.
- There is no vector or embedding search: facts are selected by shared paths, modules and terms; memory by SQLite FTS5.
  Full-text search over facts is used only by the Intelligence view.
- Consensus planning and dual review multiply the number of Claude sessions for planning and review. Consensus
  planning starts again from scratch after a pause or restart during planning.
- A dual review whose arbiter returns no valid decision falls back to a fixed rule (see
  [ORCHESTRATION](docs/ORCHESTRATION.md)), so confident critical and high findings stand and other findings are dropped.
- Results are still merged manually: NEXUS never merges the integration branch into your branch.
