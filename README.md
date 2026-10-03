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
[AUTHENTICATION](docs/AUTHENTICATION.md), [TESTING](docs/TESTING.md).

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
3. In the project, write the mission, choose a mode and a preset, and start the run.

Constraints enforced by the code:

- BUILD, SWARM, REPAIR, MISSION and LOOP need a Git repository with at least one commit.
- ASK and AUDIT also work on a folder that is not a Git repository.
- Agents work from the commit that is `HEAD` when the run starts. Uncommitted changes are not
  visible to writing agents, and the UI warns about a dirty repository.

Ctrl+K opens the command palette; Ctrl+1 to Ctrl+5 switch between Projects, Run, Agents, Memory and
Settings.

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
| `pnpm smoke:claude` | Manual test against the real Claude runtime. Consumes Claude usage. |
| `pnpm package` | `electron-vite build && electron-builder --win nsis` |

Automated tests never call the real Claude API; they use `FakeAgentRuntime`.

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
