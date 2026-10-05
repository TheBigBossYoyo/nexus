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
[V0_2_DESIGN](docs/V0_2_DESIGN.md), [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md),
[SPECULATIVE_EXECUTION](docs/SPECULATIVE_EXECUTION.md), [V0_3_DESIGN](docs/V0_3_DESIGN.md),
[ARENA](docs/ARENA.md), [BENCHMARK_METHODOLOGY](docs/BENCHMARK_METHODOLOGY.md),
[ADAPTIVE_POLICY](docs/ADAPTIVE_POLICY.md), [USAGE_INTELLIGENCE](docs/USAGE_INTELLIGENCE.md),
[QUOTA_RECOVERY](docs/QUOTA_RECOVERY.md), [PROGRAMS](docs/PROGRAMS.md),
[LONG_HORIZON_AUTONOMY](docs/LONG_HORIZON_AUTONOMY.md), [BACKGROUND_ENGINEERING](docs/BACKGROUND_ENGINEERING.md),
[WORKSPACES](docs/WORKSPACES.md), [MULTI_REPO_ORCHESTRATION](docs/MULTI_REPO_ORCHESTRATION.md),
[CONTRACTS](docs/CONTRACTS.md), [RELEASE_TRAINS](docs/RELEASE_TRAINS.md), [PROVIDERS](docs/PROVIDERS.md).

## What's new in 0.6

The 0.6 feature set removes the assumption that an agent is Claude. Claude stays required and first-class; other
providers are optional, off until you enable them, and never needed. Released as 0.6.0. Details:
[PROVIDERS](docs/PROVIDERS.md).

| Feature | What it does |
|---|---|
| Provider discovery | NEXUS asks each provider's own command line tool for its version and sign-in state. It reads no credential and sends no prompt to do so |
| Providers page | Status, version, sign-in, models, capabilities, plan usage as the provider reports it, counts of recent sessions, an explicit test session |
| Codex provider | Sessions through `codex exec`, with the login that tool already has. Read-only in 0.6: it reviews, researches and criticises, and changes no file. NEXUS checks afterwards that nothing changed |
| Provider policy | Nothing is sent to a provider you have not enabled, and enabling one routes nothing by itself |
| Cross-model review | Claude implements, another provider reviews independently, Claude verifies. A reviewer's finding is a claim to check, never the verdict |
| Heterogeneous speculation | Candidate B of a speculative task written by another provider. Implemented and tested with scripted providers; not available with Codex, which is read-only |
| Fallback | When the chosen provider cannot be used, Claude does the session and the reason is recorded, or the session is refused if you switched fallback off |
| Evidence | The mission inspector shows the provider and model of every agent; mission outcomes and Arena trials record `provider:model`, so evidence is not pooled across providers |

Statements that hold for the 0.6 feature set:

- With no other provider enabled, every session runs on Claude exactly as before.
- NEXUS never handles another provider's credentials and implements no login for it.
- Usage is shown per provider as that provider states it. Different quota systems are not converted into one
  percentage, and another provider's limits never pause a run for Claude quota.
- Gemini is detected only.

## What's new in 0.5

The 0.5 feature set goes from "change one repository" to "change several related repositories for one goal".
Released as 0.5.0.

| Feature | What it does | Where to read more |
|---|---|---|
| Workspaces | A workspace is a set of related repositories you enroll explicitly. Each stays an ordinary NEXUS project; the workspace adds roles, an organization graph, contracts, a policy, memory about what lies between the repositories, and a decision trail. | [WORKSPACES](docs/WORKSPACES.md) |
| Organization graph | Which repository depends on which. Edges come from the repositories' own manifests (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`), from the consumers of a contract, or from you, and every edge shows where it comes from. A cycle is reported, never ordered. | [WORKSPACES](docs/WORKSPACES.md) |
| Cross-repository missions | One goal, planned by a read-only session into tasks that each change one repository, in dependency order. You approve the plan before anything runs. Each task is an ordinary mission run in its own repository, on its own branch and worktree; your checkouts are not changed. A later task is given what the tasks it depends on reported and the current content of the contracts it uses. | [MULTI_REPO_ORCHESTRATION](docs/MULTI_REPO_ORCHESTRATION.md) |
| Contracts | A contract is a file one repository provides and others consume (OpenAPI as JSON, JSON Schema, TypeScript declarations, Protobuf, SQL `CREATE TABLE`, event schemas). NEXUS reads its surface, keeps versions, and reports a change as `identical`, `compatible`, `breaking` or `unknown`. | [CONTRACTS](docs/CONTRACTS.md) |
| Global verification | When every task is done, each repository's checks, each contract the mission touched and each consumer's copy are verified together. A mission that fails verification is blocked, records no contract version and prepares no release. | [MULTI_REPO_ORCHESTRATION](docs/MULTI_REPO_ORCHESTRATION.md), [CONTRACTS](docs/CONTRACTS.md) |
| Release trains | After a verified mission NEXUS prepares an order and version bumps for releasing the repositories. It never publishes: the policy field `publishing` is fixed to `never`, and the publish channel always refuses and records the request. | [RELEASE_TRAINS](docs/RELEASE_TRAINS.md) |
| Workspace programs | An ordered series of cross-repository missions that you write, one per milestone. Each milestone's tasks start from the results of the earlier milestones in every repository they changed. | [WORKSPACES](docs/WORKSPACES.md) |
| Overnight workspace missions | A cross-repository mission can be an overnight workload under the same supervisor: authorization, deadline and failsafe first, a report, and the end action. A plan that waits for approval ends the night as a blocker. | [MULTI_REPO_ORCHESTRATION](docs/MULTI_REPO_ORCHESTRATION.md), [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md) |

Statements that hold for the 0.5 feature set:

- The application state machine owns the truth. Claude proposes one thing, a cross-repository plan, and it is validated against the workspace before it is stored.
- NEXUS does not publish, push, tag or merge. The result of each task stays on a branch in its repository.
- Only repositories the workspace policy allows are ever worked in.
- Compatibility is judged on the surface NEXUS can read from a contract file. `compatible` means no breaking change was seen in what is read, not that the contract is safe; a file that cannot be read is `unknown`.
- Dependency discovery reads the root manifest of each repository only. Other relationships are declared by you.
- The Workspaces view has no screen for workspace programs and no control to run a workspace mission overnight in this feature set; both are available through the IPC channels.

## What's new in 0.4

0.4 goes from "execute a mission" to "pursue an engineering goal across many missions and milestones".

| Feature | What it does | Where to read more |
|---|---|---|
| Programs | A program has a goal, a plan of at most 12 milestones, and a deterministic engine that plans, generates a mission per milestone, verifies the milestone, records backlog and memory, reassesses the plan and goes on. The accepted work accumulates on a program branch that is never checked out in your working tree. | [PROGRAMS](docs/PROGRAMS.md) |
| Milestone verification | A mission that reports success has not completed its milestone. Deterministic gates run first (mission completed, checks passed, no review requesting changes); then a verifier session judges each acceptance criterion on the evidence. A milestone is never accepted without a judgment. | [PROGRAMS](docs/PROGRAMS.md) |
| Replanning | After a milestone, a rejection or a failed mission the plan is reassessed. A revision can add, split, reorder, change, defer or drop remaining milestones; it is stored with a diff. You can ask for a reassessment yourself. | [PROGRAMS](docs/PROGRAMS.md) |
| Backlog and memory | Verifiers, failed missions and background jobs propose backlog items; proposals never become work by themselves. Validated long-horizon facts are kept as program memory, and a mission receives only the entries relevant to its milestone. | [PROGRAMS](docs/PROGRAMS.md) |
| Long-horizon operation | A usage limit is a wait: the program continues by itself at the reset. Work windows (for example 22:00 to 07:00) bound when a program works. A program can be an overnight workload with an end-of-window power action. | [LONG_HORIZON_AUTONOMY](docs/LONG_HORIZON_AUTONOMY.md) |
| Background engineering | Optional, off by default: read-only analysis jobs (dependency audit, test gaps, dead code and more) whose only output is backlog proposals. | [BACKGROUND_ENGINEERING](docs/BACKGROUND_ENGINEERING.md) |

Statements that hold for 0.4:

- The application state machine owns the truth. Claude proposes plans and judgments; every proposal is validated before it is stored or acted on.
- A program runs one mission at a time.
- The milestone verifier judges from the diff and the recorded evidence; it does not execute the result.
- A program's result stays on its branch. NEXUS does not merge it into your branch.

## What's new in 0.3

| Feature | What it does | Where to read more |
|---|---|---|
| Arena | Runs the same task under different strategies in controlled trials. Each trial has its own fresh Git repository and project; a hidden evaluator scores the finished trial after the agents are gone. Twelve built-in cases ship with NEXUS (they run with the Node.js on your `PATH`, version 20 or newer). Raw metrics are stored and a documented, versioned ranking (`score-v1`) puts correctness first. | [ARENA](docs/ARENA.md), [BENCHMARK_METHODOLOGY](docs/BENCHMARK_METHODOLOGY.md) |
| Adaptive policy | `ADAPTIVE` profiles the task and chooses a strategy from a versioned policy: a default table, an evidence override that exists only after you promote a candidate, and bounded exploration. Every decision stores its reason, its evidence and its seed. Candidates are proposed from stored evidence and never applied by themselves; promotion, rollback and pin are user actions. | [ADAPTIVE_POLICY](docs/ADAPTIVE_POLICY.md) |
| Strategies | `SINGLE`, `BUILD`, `SWARM`, `CONSENSUS`, `SPECULATIVE` and `ADAPTIVE` configure the one orchestration engine. `SINGLE` has no planner: one worker implements the mission. `SPECULATIVE` has two or three independent candidates implement the same task and picks one by objective checks. | [ORCHESTRATION](docs/ORCHESTRATION.md), [SPECULATIVE_EXECUTION](docs/SPECULATIVE_EXECUTION.md) |
| Usage intelligence | Records what NEXUS's own sessions used and what the runtime reports about limits and plan windows, each value with its source and confidence. A percentage is shown only when the runtime supplied it. | [USAGE_INTELLIGENCE](docs/USAGE_INTELLIGENCE.md) |
| Automatic quota resume | A usage limit pauses the mission, closes a dispatch gate, waits for the reset the runtime reported (or probes on a conservative schedule when it reported none), checks availability and resumes the run through the existing resume path. It survives a restart of NEXUS. | [QUOTA_RECOVERY](docs/QUOTA_RECOVERY.md), [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md) |
| Light UI | A new shell: grouped navigation (Workspace, Intelligence, System), a page header with global status, a light theme by default with a dark override, and new Home, Arena, Policy and Usage pages. A quota banner appears on every page while a wait is active. | [ARCHITECTURE](docs/ARCHITECTURE.md) |

Statements that hold for every 0.3 feature:

- NEXUS does not claim universal superiority of any strategy. Arena results describe the cases, models and versions that were run.
- Usage totals may not be exposed by Claude. Observed usage is what NEXUS's own sessions reported; it is not necessarily the account's full subscription usage, because other Claude clients use the same account.
- Quota reset behaviour depends on what the runtime reports. NEXUS never fabricates remaining quota; a percentage is shown only when the runtime supplied it.
- The runtime usage report is an SDK method declared experimental and unstable. NEXUS treats it as optional and falls back to conservative probing.
- Arena evidence is controlled; mission history is observational and weighted lower. Neither is pooled in displayed counts.
- Policy changes only by explicit promotion. Learning never rewrites NEXUS source code.

The design and its deviations from the implementation are in [V0_3_DESIGN](docs/V0_3_DESIGN.md).

## What's new in 0.2.1

| Feature | What it does | Where to read more |
|---|---|---|
| Overnight Mode | An unattended MISSION run with a wall-clock deadline and an end-of-run power action (shut down, sleep, hibernate or none) that you authorize for that run, in the composer and in a native Windows dialog. NEXUS itself performs the action, from deterministic main-process code, after the agents are stopped and the final report is saved. A Windows shutdown timer is armed as a failsafe before any agent starts. | [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md) |
| Power controller | `WindowsPowerController` runs `System32\shutdown.exe` (and Windows PowerShell for sleep) with argument arrays, no shell and fixed messages. Only the overnight supervisor holds it. Agents have no path to it, and power commands in an agent's shell are refused for every role. | [SECURITY](docs/SECURITY.md) |
| Tray and background | Closing the window during an overnight run asks whether to hide to the tray; the mission continues in the main process. The tray icon exists only while an overnight run is live. | [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md) |
| Quota waiting | In an overnight run, a usage limit whose reset time falls inside the mission time is waited out (`QUOTA_PAUSED`) and the run resumes by itself; otherwise the run ends as quota exhausted, which is not a failure. (0.3 adds a probe before the resume and probing when the reset time is unknown.) | [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md) |
| Evidence builder | One `TaskEvidenceBuilder` assembles everything reviewers, verifiers and debuggers are told that the repository cannot show: check results, commits, changed files, reviews, repair history, dependency handoffs, graph revisions, messages sent and received, decisions with their text, and the result the agent reported. Agent-written text is quoted and labelled. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Command classes | Shell commands are classified (`SAFE_READ`, `SAFE_PROJECT_WRITE`, `GIT_LOCAL`, `NETWORK`, `SYSTEM_CHANGE`, `DESTRUCTIVE`, `UNKNOWN`). Heredoc commit messages and `cat > file <<'EOF'` inside the worktree no longer need approval; `git config` of keys that can run code, Git redirected outside the worktree, and the NEXUS database are gated or refused. The project's own package scripts count as verification commands for reviewers and verifiers. | [SECURITY](docs/SECURITY.md) |

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
| Node.js 20 or newer on `PATH` | Needed only by the Arena: its built-in cases run `node --test`. NEXUS ships no Node. |
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
3. In the project, write the mission, choose a mode, a preset, a strategy, a planning mode and a review mode, and press Start mission. NEXUS opens on Home.

The strategy selector is shown for every mode except ASK and AUDIT (read-only) and for OVERNIGHT. It defaults to
`ADAPTIVE`. Strategies configure the same engine; they do not add a second one:

| Strategy | What it configures (`src/main/modules/strategy/strategies.ts`) |
|---|---|
| `ADAPTIVE` | Asks the policy engine, records the decision and its reason, then runs the chosen strategy. The choice is fixed for the run. With no policy evidence it follows the default table. |
| `SINGLE` | No planner. The mission becomes one worker task (strongest tier, balanced in ECO), one agent at a time. Checks, review, verification and merge still apply. |
| `BUILD` | Planning `single`, review `auto`, the preset's agent limit. |
| `SWARM` | As BUILD with the swarm planner guidance and the maximum preset's agent limit (the ECO cap in ECO). |
| `CONSENSUS` | Consensus planning (three planners, critic, synthesizer) and dual review. |
| `SPECULATIVE` | No planner. Two candidates by default (three at most) implement the same task, each in its own clone of the repository; objective checks pick one; it then goes through review and verification. Uses more Claude usage. |

Details: [ORCHESTRATION](docs/ORCHESTRATION.md) (Strategies), [ADAPTIVE_POLICY](docs/ADAPTIVE_POLICY.md).

Constraints enforced by the code:

- BUILD, SWARM, REPAIR, MISSION and LOOP need a Git repository with at least one commit.
- ASK and AUDIT also work on a folder that is not a Git repository.
- Agents work from the commit that is `HEAD` when the run starts. Uncommitted changes are not
  visible to writing agents, and the UI warns about a dirty repository.

Navigation is a left sidebar in three groups: Workspace (Home, Projects, Missions, Agents), Intelligence
(Arena, Policy, Usage, Performance, Repository) and System (Overnight, Activity, Memory, Settings). Ctrl+K opens
the command palette, Ctrl+B shows or hides the sidebar, Ctrl+1 to Ctrl+9 open the first nine entries in that order
(Home, Projects, Missions, Agents, Arena, Policy, Usage, Performance, Repository), and Esc closes an overlay
(`src/renderer/src/app/nav.ts`, `hotkeysModel.ts`).

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
| OVERNIGHT | Not a separate engine mode: the composer starts a MISSION run through `overnight.start`, without plan approval, attached to an overnight record (policy, authorization, failsafe). See [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md). |
| LOOP | Planner guidance only: objectively checkable mission criteria, first iteration planned as concrete tasks. The composer also sends a `maxIterations` override for LOOP. There is no separate outer loop for LOOP: iteration bounds are the repair bounds that apply to every mode (see [ORCHESTRATION](docs/ORCHESTRATION.md)). |

So BUILD, SWARM, REPAIR, MISSION and LOOP differ only in the planner prompt (and the `maxIterations`
override for LOOP). The one-line descriptions in the UI describe intent, not separate code paths.

Since 0.3 a run also has a strategy (see "Launching and opening a project"). The strategy sets the planning mode,
review mode and agent limit through the run configuration, and `SWARM` also sets the run mode to `swarm`. A run
created without a strategy (ASK, AUDIT, or a caller that sends none) behaves exactly as before 0.3.

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
| Database (SQLite, WAL) | `%APPDATA%\NEXUS\nexus.db` (plus `-wal` and `-shm` files while running). Before a schema upgrade NEXUS keeps `nexus.db.v<old>.bak` next to it |
| Arena trial repositories | `%APPDATA%\NEXUS\arena\<campaign>\<trial>\`; removed by `arena.cleanup` for a finished campaign |
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
| `pnpm smoke:power` | Manual test of the real `WindowsPowerController`: schedules a Windows shutdown one hour away, checks it was accepted, aborts it at once and checks nothing is left armed. Never part of `pnpm test`. |
| `pnpm smoke:usage` | Manual test against the real Claude runtime: account information and the experimental usage report. No prompt is sent and no model turn runs. Writes evidence to `docs/acceptance/usage-report-*.json`. |
| `pnpm accept:proposal` | `node scripts/dynamic-proposal-acceptance.mjs` (real Claude, see below) |
| `pnpm accept:rotation` | `node scripts/session-rotation-acceptance.mjs` (real Claude, see below) |
| `pnpm accept:arena` | `node scripts/arena-acceptance.mjs` (real Claude, consumes usage): a small Arena campaign |
| `pnpm accept:speculative` | `node scripts/strategy-acceptance.mjs speculative` (real Claude, consumes usage) |
| `pnpm accept:adaptive` | `node scripts/strategy-acceptance.mjs adaptive` (real Claude, consumes usage) |
| `pnpm package` | `electron-vite build && electron-builder --win nsis` |

Automated tests never call the real Claude API; they use `FakeAgentRuntime`.

Real-mission scripts (not part of any test run; each starts the app, drives it through its IPC bridge
with the **real Claude runtime**, consumes Claude usage, and writes evidence to `docs/acceptance/`):

| Command | Mission |
|---|---|
| `node scripts/adversarial-mission.mjs [path-to-NEXUS.exe]` | Four tasks (three modules and a report task that depends on them), fast-tier workers, a controlled app restart mid-run. Uses the default planning and review modes. |
| `node scripts/v02-acceptance-mission.mjs [path-to-NEXUS.exe]` | The same mission with `planningMode: consensus` and `reviewMode: dual`, plus a repository convention that needs a task no one planned, to provoke a graph proposal. Also restarts the app mid-run. |

| `node scripts/dynamic-proposal-acceptance.mjs [path-to-NEXUS.exe]` | A CSV export whose contract is only readable after a worker runs `npm run generate-schema` (it is packed in a vendor bundle a read-only planner cannot unpack). The contract demands a module no task of the plan delivers; the gate is a real `ADD_TASK` proposal, a graph revision, the new task executed and the original task resumed. |
| `node scripts/session-rotation-acceptance.mjs [path-to-NEXUS.exe\|-] [turns]` | One worker task with a low rotation threshold (`sessionRotationTurns`, default 8 here): the gate is a real session rotated with a structured handoff and a second real session finishing the task. |
| `node scripts/arena-acceptance.mjs [path-to-NEXUS.exe\|-] [caseIds] [strategies]` | A real Arena campaign: by default `bugfix-localized`, `feature-small` and `ui-state-bug` under `SINGLE` and `BUILD`, one repetition, ECO budget. Records what NEXUS measured; changes no threshold. |
| `node scripts/strategy-acceptance.mjs speculative\|adaptive [path-to-NEXUS.exe]` | One real SPECULATIVE task (two candidates, tournament, review, verification) or one real ADAPTIVE mission (profile, decision, reason, outcome). |
| `node scripts/packaged-validation.mjs <NEXUS.exe> <db-dir>...` | No Claude usage. Launches a packaged or installed build on copies of existing databases and checks the schema upgrade, old runs, auth status, project opening and the Overnight UI. |

These launch the window off-screen (`NEXUS_WINDOW_OFFSCREEN=1`); set `NEXUS_ACCEPT_SHOW=1` to see it.
Without an argument the first two and the acceptance scripts launch the dev build (run `pnpm build` first). `scripts/acceptance-mission.mjs` is the
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
  `rate_limit` or `billing_error`, or the SDK's usage-limit message prefixes). Since 0.3 a quota pause is
  resumed automatically after the reset the runtime reported, or after a probe finds Claude available again
  (see [QUOTA_RECOVERY](docs/QUOTA_RECOVERY.md)); you can still resume by hand. A pause you made yourself is never resumed
  automatically. NEXUS has no spending cap of its own: bounds are turns
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

### Limitations of 0.3 features

- No real usage limit, real Arena campaign, real speculative task or real ADAPTIVE mission had been run when this was written; see
  [V0_3_RELEASE_REPORT](docs/V0_3_RELEASE_REPORT.md). Their behaviour is covered by unit, integration, scenario and seeded
  stress tests with the scripted runtime (`FakeAgentRuntime`). The only 0.3 check against the real runtime that is
  recorded here is `pnpm smoke:usage` (2026-10-04, Claude Agent SDK 0.3.288, no prompt sent): the usage report answered in
  about one second with plan windows (`five_hour`, `seven_day` and a model-scoped bucket), each with a utilization
  percentage and a reset time, and the account mode was `subscription`. Evidence: `docs/acceptance/usage-report-*.json`.
- NEXUS has no figure for the tokens remaining in a subscription and shows none. Observed usage covers NEXUS's own sessions only.
- The usage report is an experimental SDK method that can change or disappear. When it is missing or fails, recovery
  probes with one minimal session per interval.
- Quota recovery depends on what the runtime reports. With no reset time NEXUS probes on a backoff schedule; an ordinary
  (non-overnight) run with no wait limit probes for as long as NEXUS runs. See [QUOTA_RECOVERY](docs/QUOTA_RECOVERY.md).
- Only the Claude runtime exists. `AgentRuntime` is an interface with `ClaudeSdkRuntime` and `FakeAgentRuntime`; no other provider is implemented.
- `ALWAYS_FOR_HIGH_RISK` speculation behaves as `AUTO`. Candidates are proposed for exact and category-level contexts, never global ones.
  Learning runs only when you ask for it. A run created without a strategy records no mission outcome.
- The ADAPTIVE decision is fixed when the run is created. An explicit strategy choice is used as given and records no decision.
- Arena needs Node.js 20 or newer on `PATH` (NEXUS ships none); without it a campaign cannot start. Every built-in case is a
  small JavaScript project, so results say nothing about other languages or large repositories. Creating a campaign from a
  user repository is not offered. A campaign can run under the overnight supervisor (Arena, New campaign, Run overnight); a real campaign with a real power action has not been run. Unattended trials deny every tool
  approval request. The `performance-optimization` evaluator decides by timing and runs on one machine.
  Pausing a campaign does not pause runs already running. Budgets are checked after each trial (the wall-clock budget on a timer),
  so the running trial can exceed them. Regression detection compares only the two newest (NEXUS version, model) groups.
  See [ARENA](docs/ARENA.md).
- Small samples: a preference is proposed only when its challenger has at least 5 Arena trials from 3 distinct cases and `MODERATE` evidence (12 weighted trials); missions alone never produce a candidate. No p-values are
  computed, and a table that says two strategies are not separated means exactly that. See [BENCHMARK_METHODOLOGY](docs/BENCHMARK_METHODOLOGY.md).
- Dependency installs, check commands and Arena commands run without your Claude credentials (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `NODE_OPTIONS`, `NODE_PATH`); other environment variables are passed on. The agent shell policy is still a lexical filter
  (see [SECURITY](docs/SECURITY.md)).
- A speculative task costs one extra implementing session per extra candidate and applies to a single-task run only; a
  planned task graph has no speculative tasks.

### Limitations of 0.2.1 features

- Overnight Mode needs Windows. Real sleep and hibernate have not been executed on a real machine, and no real
  shutdown was allowed to complete during development; the shutdown timer was exercised by `pnpm smoke:power` only.
- The failsafe is a Windows shutdown timer, and Windows closes applications without waiting whenever a timed
  shutdown fires, whether or not "force close" is ticked. A normal (non-forced) final shutdown can be stopped by an
  application with unsaved data; the PC then stays on.
- The agent shell policy is a lexical filter, not an operating-system sandbox. Plain and commonly obfuscated power
  commands are refused for every role, but a worker can run code it wrote, so a prompt-injected worker could still
  power the machine off or abort the failsafe through its own program. NEXUS guarantees only that none of its own
  mechanisms gives an agent the power controller or a valid authorization.
- The overnight authorization is sealed with a key kept encrypted for the Windows user. Code running as the same
  user with enough effort could recompute it; the seal defends against edits of the database, not against a
  compromised user account.
- Only one overnight run at a time. An overnight run always uses MISSION mode and skips plan approval.
- After NEXUS was not running for more than 10 minutes, or Windows restarted, an overnight run is ended without a
  power action on the next launch and has to be resumed by hand as a normal run.
- Budgets cover agent sessions and repair tasks. There are no token or cost limits.
- Checkpoints are a record for inspection; recovery reads the live tables, not the checkpoints.
- The cause of the one-off "run ended paused" scenario failure seen in 0.1 is still not proven.
- A rotated session is marked on the handoff session row, not on the session that reached its turn limit.

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
