# NEXUS Architecture

NEXUS is a local-first Windows desktop control plane that coordinates multiple independent
Claude agent sessions over a Git repository. Orchestration is deterministic application code;
Claude is used only for reasoning and engineering work.

## Stack (versions verified 2026-10-03)

| Concern | Choice | Notes |
|---|---|---|
| Shell | Electron 44 (Node 24, ABI 149) | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| Build | electron-vite 5 + Vite 7 | Vite 8 is not supported by electron-vite 5 |
| UI | React 19, Tailwind 4, zustand, TanStack Query, @xyflow/react, react-diff-view | |
| Language | TypeScript 6 strict | typescript-eslint does not yet support TS 7 |
| DB | better-sqlite3 13 | N-API prebuilt binary in the tarball; loads in Electron 44 with no rebuild and no MSVC |
| Agent runtime | @anthropic-ai/claude-agent-sdk 0.3.288 | V1 `query()` API only; no V2 session API exists in this version |
| Validation | zod 4 | SDK peer dependency; also used for IPC and planner schemas |
| Tests | vitest 5 (unit, integration), Playwright (Electron E2E) | |
| Packaging | electron-builder 26, NSIS | `claude.exe` and better-sqlite3 are asar-unpacked |

## Layout

Single package (no pnpm workspace) to keep electron-builder packaging simple.

```
src/
  shared/            pure TS shared by main and renderer: domain types, zod schemas, events, IPC contract;
                     v0.3: v3.ts (all 0.3 contracts: usage, Arena, policy, speculation; zod), v3-read.ts (read models)
  main/
    index.ts         v0.7: picks the role of this process (window or runtime) and starts it
    desktop.ts       v0.7: the window role (BrowserWindow, preload bridge, a client of the runtime)
    runtime-electron.ts  v0.7: the runtime role in Electron (no window): tray, notifications, key store, power-save blocker
    runtime-node.ts  v0.7: the same runtime core hosted by plain Node (tests; not what the app ships)
    runtime/core.ts  v0.7: the composition root (it was `index.ts`'s `bootstrap` until 0.6); imports nothing from Electron
    worker.ts        v0.7: the worker role: one agent session at a time under a lease
    tray.ts          v0.7: the runtime's tray icon
    modules/
      persistence/   SQLite open, migrations, repositories
      events/        typed event bus: persist to run_events, then fan out
      task-graph/    DAG validation, cycle detection, readiness; v0.2: proposals.ts (graph proposal validation,
                     operations, snapshots and diffs)
      scheduler/     concurrency, leases, priorities, file-overlap serialization
      state/         task / agent / run state machines
      agent-runtime/ AgentRuntime interface, ClaudeSdkRuntime adapter, FakeAgentRuntime
      policies/      role tool policies, command classification, path boundaries, authorizer
      git/           GitService (spawn with arg arrays), worktree manager
      process/       runProcess / runCommandLine (no shell), process-tree kill
      context/       context packs, role prompts, stage prompts (planner, review, verifier, repair, handoff);
                     v0.2: context-engine.ts (composeContext with per-entry provenance), render.ts (orchestration evidence)
      orchestrator/  run lifecycle, planner loop, task pipeline, repair loop, recovery, approvals,
                     inter-agent messaging, project memory service; v0.2: graph-service.ts (apply proposals,
                     revisions, yield markers), consensus.ts (consensus planning), routing.ts (ModelRoutingService),
                     outcomes.ts (task outcome recording), arbitration.ts (arbiter output storage),
                     evidence.ts (orchestration evidence), intelligence.ts (fact refresh)
      routing/       v0.2, pure: routeModel (tier rules and reasons), aggregatePerformance, buildTaskOutcome
      review/        v0.2, pure: dedupeFindings, applyArbitration
      planning/      v0.2, pure: planner lenses, recommendPlanningMode
      intelligence/  v0.2: repository analysis (manifests, bounded walk, regex imports, Git history), fingerprints,
                     refresh/reconcile, fact selection for a task
      profile/       read-only project discovery (ProjectProfile)
      ipc/           validated IPC handlers and read-model services; v0.3: v3-handlers.ts (usage.*, arena.*, policy.*);
                     v0.7: v7-handlers.ts (control.*, runtime.*), v7-security-handlers.ts (security.decisions)
      usage/         v0.3: classify.ts (pure), machine.ts (pure status machine, quota-wait planner), service.ts
                     (UsageIntelligenceService, the dispatch gate), recovery.ts (QuotaRecoveryController), probe.ts
      strategy/      v0.3: strategies.ts (five strategies as engine configuration), tournament.ts (pure ranking)
      policy/        v0.3: profiler.ts, stats.ts, engine.ts, learning.ts (pure); service.ts, snapshots.ts, simulator.ts
      arena/         v0.3: case-format.ts, fixtures.ts, evaluator.ts, scoring.ts, metrics.ts, campaign.ts (ArenaService)
      overnight/     v0.2.1: supervisor, report, tray model; v0.3: AutonomousWorkload, MissionWorkload, ArenaCampaignWorkload; v0.4: ProgramWorkload; v0.5: WorkspaceMissionWorkload
      program/       v0.4: engine.ts (ProgramEngine), reasoning.ts (prompts, parsing), memory.ts, background.ts
      workspace/     v0.5: engine.ts (WorkspaceEngine), contracts.ts (contract surface readers), discovery.ts (manifests)
      control-plane/ v0.7: service.ts (ControlPlane: queue, allocation, schedules, health), adapters.ts (workload adapters),
                     notifier.ts (notifications outside the queue)
      runtime/       v0.7: the local protocol: server.ts, client.ts, framing.ts, endpoint.ts, tray-model.ts
      workers/       v0.7: manager.ts (WorkerManager, leases), protocol.ts (runtime and worker messages), hosted-runtime.ts,
                     probe-script.ts
      policies/      (above) v0.7 adds execution-policy.ts, interpreters.ts, package-scripts.ts, content-inspector.ts,
                     provenance.ts, capabilities.ts, security-log.ts (see SECURITY.md)
  preload/           narrow typed bridge (CJS, sandboxed)
  renderer/          React UI; v0.7: views/control (Control Center, Runtime diagnostics), views/security, app/ConnectionGate.tsx
tests/
  unit/ integration/ scenarios/ stress/ smoke/   (Playwright E2E is run by `pnpm test:e2e`)
arena/
  cases/<id>/        v0.3: the twelve built-in Arena cases (case.json, fixture/, evaluator/, README.md)
```

Dependency direction: `renderer → preload bridge → ipc → orchestrator/services → domain
(task-graph, scheduler, state, policies) → adapters (agent-runtime, git, persistence)`. Since 0.7 the arrow between the
preload bridge and `ipc` crosses a process boundary: the window's main process forwards the call over a local named
pipe to the runtime process, whose dispatcher validates it (see "Process model (0.7)").
`src/shared` depends on nothing but zod. Domain modules never import Electron, the SDK, or SQLite.

## Process model (0.7)

Until 0.6 the database, the engines, the agent sessions and the window all lived in the Electron main process; quitting
NEXUS stopped the work. Since 0.7 (branch `nexus-0.7`, not released: `V0_7_RELEASE_REPORT.md`) the same executable has
three roles. The authoritative design text is `V0_7_DESIGN.md`.

```
 nexus-desktop                 the window. A client. Owns nothing durable.
      |  named pipe, authenticated, versioned, one closed set of channels
 nexus-runtime                 the control plane. Owns the database, the queue, the scheduler,
      |                        the engines, schedules, the overnight supervisor, power control, the tray.
      |  process channel (fork), one per worker
 nexus-worker-N                one agent session at a time, under a lease. Decides nothing.
      |
 provider process              claude.exe (Agent SDK) or `codex exec`, as before
```

| Role | How it is started | Source |
|---|---|---|
| `nexus-desktop` | `NEXUS.exe` | `src/main/desktop.ts` |
| `nexus-runtime` | `NEXUS.exe --nexus-runtime`, started detached by the window when none answers | `src/main/runtime-electron.ts` hosting `src/main/runtime/core.ts` |
| `nexus-worker-N` | `NEXUS.exe` run as Node (`ELECTRON_RUN_AS_NODE`) on `out/main/worker.js`, forked by the runtime | `src/main/worker.ts` |

`src/main/index.ts` only chooses the role from the arguments. The electron-vite build has three entry points: the app
(`index`), `worker` and `runtime-node`. The runtime core imports nothing from Electron; the Electron host gives it the
tray, native notifications, the user-bound key store (Electron's `safeStorage`, DPAPI on Windows) and the power-save
blocker. A second host, `src/main/runtime-node.ts`, runs the same core under plain Node: tests use it to start, kill and
restart a real runtime process without a window. It has no tray and no notifications, and keeps its signing key in
memory. No WSL, no Docker, no Windows service, no administrator rights: every process runs as the signed-in user.

### Lifecycle

- **Start.** The window reads `<data>/runtime/endpoint.json`. If a runtime answers there it connects; if not, it starts one
  and waits for a new endpoint. The window shows `STARTING RUNTIME`, `CONNECTING`, `RECOVERING` and `READY`.
- **Closing the window** ends the window's process. The runtime, and every run, schedule and agent session it owns,
  continues. During an overnight mission the window asks first (hide to the tray, cancel the mission, or return), as since
  0.2. A crash of the window changes nothing in the runtime.
- **Opening NEXUS again** connects to the running runtime. The window keeps no state of its own: it reads everything
  again after a reconnect.
- **The runtime stops** when you choose "Stop NEXUS" (tray, or Runtime diagnostics, channel `runtime.stop`), which asks
  first when work is active; when Windows signs out or asks the process to quit (no question is asked); or by itself
  after two minutes in which no window is connected, no run is working, nothing is on the queue and no schedule is
  switched on. `runtime.status` says why a runtime stays.
- **Nothing starts the runtime at Windows sign-in.** It starts when NEXUS is opened.
- **One runtime per data directory.** The Electron host takes the single-instance lock of its own profile directory
  (`<data>/runtime-profile`); the window takes the lock of the data directory itself, so a second start of NEXUS
  focuses the first window.
- **A runtime of another NEXUS version** that is still running is asked to stop by the window (any version different from
  the window's), which then starts its own. A runtime that speaks another protocol version is not talked to; the window
  says so (`INCOMPATIBLE`).

### The local protocol

`src/shared/runtime-protocol.ts` (the frames), `src/main/modules/runtime/` (`server.ts`, `client.ts`, `endpoint.ts`,
`framing.ts`).

- **Transport.** One Windows named pipe, `\\.\pipe\nexus-runtime-<hash of the data directory>-<16 random hex digits>`. No
  TCP socket is opened anywhere. The server listens with `exclusive`, so a name that is taken is noticed. NEXUS sets no
  access list on the pipe itself; the handshake below is what keeps others out.
- **Discovery.** `<data>/runtime/endpoint.json` holds the pipe name, a 32-byte random token, the runtime's pid, boot id,
  version and protocol version. It is written whole (a temporary file, then a rename). Afterwards its access list is
  narrowed with `icacls` to the user, SYSTEM and administrators; until that finishes, and if it fails, the file has the
  access list it inherits from the data directory. `runtime.status` reports `endpointAcl` as `restricted` or `inherited`.
- **Handshake.** Mutual, by HMAC-SHA-256 over a role and both sides' nonces with the token as the key. The runtime proves
  itself first and the client checks that proof before it sends its own. The token never crosses the pipe. A connection
  that has not completed the handshake within five seconds is closed; before the handshake no frame longer than 4 KB is
  read and nothing but `hello` and `auth` is accepted.
- **Frames.** One JSON object per line, validated with zod on both sides (`ClientFrameSchema`, `ServerFrameSchema`), at
  most 32 MB.
- **Requests.** `{t:'req', id, channel, input}`. The runtime hands them to the dispatcher the window used before 0.7: the
  channel must be one of the closed contract in `src/shared/ipc.ts` and the input must pass that channel's strict schema
  before a handler runs. No channel takes a command line, a file path to read or write, or code.
- **Events.** After the handshake a client receives every push message.
- **Questions to the user.** A confirmation (authorizing overnight power control, trusting an Arena case, a settings
  change that starts a program or widens what agents may do unasked, stopping while work runs) is shown by the runtime
  process itself in a native dialog and never travels over the pipe, so a client of the pipe cannot answer the question
  it caused. Picking a folder and opening the data directory carry no authority; they are sent to the connected window
  as `ui.req` frames (`pickDirectory`, `openDataDir`) and shown by the window's main process, or by the Electron host of
  the runtime when no window is connected. Under the Node host a confirmation fails. A question nobody can see is never
  answered yes.
- **Reconnect.** The client reconnects with backoff. While it is disconnected every request fails at once with
  `runtime_unavailable`; nothing is queued and nothing old is shown as current. The window marks the page stale and
  inert, then reads everything again.
- **Slow readers.** A client with more than 64 MB unsent is dropped. The runtime never waits for a window.

#### What the protocol protects against, and what it does not

It protects against another Windows user on the machine, against a process that takes the pipe's name (it cannot prove
that it holds the token, and the client checks the runtime's proof first), and against a process that can reach the pipe
but cannot read the user's files.

It does **not** protect against a process running as the same user that reads the endpoint file. Such a process holds
the token and can call every channel the window can. Windows offers no boundary between processes of one user that NEXUS
could rely on here; the same process could as well drive the window. What stays out of reach even then: provider
credentials (NEXUS never holds them), a channel that executes a command, and raw power control. Power actions exist only
as typed operations of the overnight supervisor, which checks the persisted, signed authorization and asks in a native
dialog (a unit test checks that the window process, the worker and the protocol cannot import the power module).

The wider trust statement is the one in `SECURITY.md`: **NEXUS is not a sandbox.** It classifies and decides what an agent
asks to execute, including what an interpreter or a package script would run and who wrote it; code that NEXUS allows
to run, runs as the user. OS-level containment is the subject of `V0_8_PROPOSAL.md` and `WINDOWS_EXECUTION_ISOLATION.md`.

### Database ownership

The runtime is the only process that opens `nexus.db`. The window reads and writes through the protocol. Workers open no
database. The database stays in WAL mode with `synchronous = NORMAL`; the runtime checkpoints on a clean stop and before
the overnight supervisor's power step. Migrations 010 (`workers`, `worker_leases`, `worker_events`, `schedule_firings`,
`scheduler_decisions`) and 011 (the security decision log and file provenance) are additive; databases of 0.1 to 0.6 open
as before.

### Workers

`src/shared/workers.ts`, `src/main/modules/workers/`. A worker runs one agent session at a time under a lease stored in
`worker_leases`; two partial unique indexes make "one active lease per agent session" and "one active lease per worker" a
property of the database. A worker decides nothing: every tool call is sent back to the runtime, which runs the policy
engine. A worker never outlives its runtime. A lost worker is ended with its process tree and its session ends as
`crashed`. The details are in `WORKERS.md`.

### Where each module lives now

| Concern | Process | Where |
|---|---|---|
| Window, preload bridge, native dialogs the runtime asks for, the overnight close question | window | `desktop.ts`, `src/preload`, `src/renderer` |
| Database, repositories, event bus | runtime | `runtime/core.ts`, `modules/persistence`, `modules/events` |
| Orchestrator, planner, pipelines, approvals, recovery | runtime | `modules/orchestrator` |
| Global queue, allocation, schedules, health, notifications | runtime | `modules/control-plane` |
| Usage intelligence, quota recovery | runtime | `modules/usage` |
| Programs, workspaces, Arena, policy engine, background jobs | runtime | `modules/program`, `modules/workspace`, `modules/arena`, `modules/policy` |
| Overnight supervisor and power control | runtime | `modules/overnight`, `modules/power` |
| Tool authorization (the policy engine for agent tools) | runtime | `modules/policies` |
| Provider detection and routing | runtime | `modules/providers` |
| The local server and the tray | runtime | `modules/runtime`, `runtime-electron.ts`, `tray.ts` |
| Provider sessions (`claude.exe`, `codex exec`) | worker | `worker.ts`, `modules/agent-runtime`, `modules/providers/codex-runtime.ts` |

With the scripted runtime (`NEXUS_FAKE_RUNTIME=1`, UI tests, unpackaged builds only) sessions run inside the runtime
process; `NEXUS_FAKE_WORKERS=1` puts them into workers.

## Key decisions

1. **The database is the source of truth.** Every state transition goes through a state machine,
   is written in a transaction together with its `run_events` row, and only then is broadcast to
   the renderer. The renderer holds a query cache invalidated by events; it is never authoritative.

2. **Scheduler is deterministic code.** A tick function reads tasks from the DB, computes the ready
   set (deps completed, approvals granted, not cancelled, no file-overlap with a running writer,
   free concurrency slot), acquires a lease, and dispatches. No orchestration state lives in a prompt.

3. **One SDK `query()` per agent session.** Each is a separate `claude.exe` child process with its
   own context. Follow-ups use streaming-input mode (an `AsyncIterable<SDKUserMessage>` queue).
   Cancellation: `interrupt()` for the turn, `close()` for the process. Recovery: `resume: sessionId`.

4. **Isolation from global Claude configuration.** Sessions start with `settingSources: []`,
   `strictMcpConfig: true`, `skills: []`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and an explicit
   `permissionMode: 'default'` (since 0.3.286 an omitted mode defers to user settings). The
   `claude_code` system-prompt preset is kept and the role prompt is appended, because an omitted
   system prompt drops the safety text. A per-project opt-in adds `'project'` to load CLAUDE.md.

5. **Tool policy is enforced in code, twice.** `tools` restricts which built-ins a role can see
   (`allowedTools` only auto-approves, it does not restrict). A `PreToolUse` hook, which the runtime
   evaluates before rules and modes for every call, runs the NEXUS policy engine: hard `deny` for
   out-of-boundary paths and forbidden tools, `allow` for in-policy calls, `ask` for gated actions.
   `ask` reaches `canUseTool`, which calls the session's `requestApproval`; the orchestrator creates an
   `ApprovalRequest` and awaits the user. Nested
   subagents are disabled (`Agent`/`Task` are never in `tools`).

6. **Agents talk to NEXUS through an in-process MCP server** (`createSdkMcpServer`), exposing
   `send_message`, `report_blocker`, `record_decision`, `propose_memory` and, for the work roles that may
   change the plan, `propose_graph_change`. Planner, reviewer, and
   verifier return data through `outputFormat: { type: 'json_schema' }`, validated again with zod.

7. **Git model.** The user's working tree is never written to. A run gets an integration branch
   `nexus/<run>/integration` with its own worktree under the NEXUS data dir. Each writing task gets
   a branch `nexus/<run>/<task>` and worktree created from the integration tip once its dependencies
   are merged. A task that passes verification is merged into the integration branch under a mutex;
   a conflict aborts the merge, emits `git.conflict`, and sends the task through the repair loop (a
   child debugger task). NEXUS never merges the integration branch into the user's branch: the user
   runs `git merge` themselves (see GIT_WORKTREES.md).

8. **Authentication is delegated.** NEXUS never reads tokens or credential stores. Status comes
   from the SDK's `initializationResult().account` / `accountInfo()` and the init message's
   `apiKeySource`. In Subscription Mode the child `env` (which the SDK documents as replacing the
   process environment) is built without `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`. Login is
   the official `claude auth login`. See AUTHENTICATION.md for the policy caveat.

9. **Quota is not failure.** `rate_limit_event` with `status: 'rejected'` or an assistant
   `error: 'rate_limit'` pauses the affected task and the run (`paused`, reason `quota`), keeps the
   session id, and leaves the run resumable. Since 0.3 the run is also resumed automatically: the
   `QuotaRecoveryController` records the pause in `quota_pauses`, closes the orchestrator's dispatch gate, waits
   for the reset the runtime reported (or probes on a conservative schedule when none was reported), checks
   availability, and resumes through the existing `resumeRun` path. A pause by the user is never resumed by
   it. See QUOTA_RECOVERY.md.

10. **Windows native.** All process spawning uses `spawn` with argument arrays and `windowsHide`.
    No shell interpolation, no WSL, no Git Bash requirement (the runtime uses its PowerShell tool
    when Git Bash is absent). Paths are canonicalized with `fs.realpath` and compared
    case-insensitively.

## v0.2 decisions

11. **The graph is data that agents propose to change, never write.** `propose_graph_change` input is validated by
    pure code (`validateProposal`) into a list of operations; `GraphService` executes them in one transaction
    with a `graph_revisions` snapshot, so every change is persisted, ordered and diffable. The orchestrator
    remains the only writer of task and dependency rows. The scheduler is unchanged. A task that waits for a
    new prerequisite yields (`running -> queued`) and restarts in a worktree that has merged the integration branch.
    Changes that touch someone else's work, or that exceed run-wide bounds, wait for user approval (kind `graph`).
12. **One router decides every model.** `routeModel` is pure and total; the concrete model is looked up in
    settings only when the session starts. The decision and its reasons are stored per agent. Measured
    outcomes influence it only above a minimum sample count.
13. **Outcomes are measurements, not estimates.** A `task_outcomes` row is derived from durable records
    (reviews, verifications, attempts, repair children, events); token figures stay null unless the SDK reported them.
14. **Facts carry provenance.** Repository facts have a source, confidence, supporting files and a fingerprint of
    those files (path, size, mtime); analysis is static and bounded; agent-recorded facts are marked as unverified.
15. **Context is explainable.** `composeContext` records every candidate source with an inclusion flag and a reason
    in `context_packs` / `context_pack_entries`; repair, resume and rotation prompts are recorded the same way.
16. **Consensus planning and dual review reuse the agent runner.** They run extra
    sessions through the same agent runner; their merge rules (plan validation, `dedupeFindings`, `applyArbitration`)
    are deterministic, with documented fallbacks when a session produces nothing usable.
17. **Migration 002 is additive.** `002-v0-2.ts` only creates tables (`graph_revisions`, `graph_proposals`,
    `planning_candidates`, `planning_critiques`, `routing_decisions`, `task_outcomes`, `repository_facts` with an
    FTS5 mirror, `context_packs`, `context_pack_entries`); no v0.1 table is altered. `RunConfig` gains the optional
    `planningMode` and `reviewMode`, stored in the existing `runs.config` JSON.

The v0.2 renderer additions are the Performance and Intelligence views, the Plan inspector and revision bar in the
Run view, a Context tab in the task inspector, and a routing section in the Agent detail. v0.2 IPC channels:
`graph.revisions`, `graph.proposals`, `planning.candidates`, `planning.recommend`, `routing.list`,
`performance.summary`, `intelligence.list`, `intelligence.refresh`, `context.packs`. Design: V0_2_DESIGN.md.

## v0.3 decisions

18. **A strategy is configuration of the one engine.** `strategy/strategies.ts` maps a strategy to planning mode, review
    mode, agent limit and candidate count. `SINGLE` and `SPECULATIVE` skip the planner and materialize one worker
    task; the other three plan as before. There is no second scheduler. `ADAPTIVE` is resolved to one of the five when
    the run is created and the choice is fixed for that run (`runs.config.strategy`). See ORCHESTRATION.md.
19. **Pure modules decide, services persist.** `usage/classify`, `usage/machine`, `strategy/tournament`,
    `policy/profiler`, `policy/stats`, `policy/engine`, `policy/learning` and `arena/scoring` import only `src/shared`.
    Their services (`UsageIntelligenceService`, `PolicyService`, `ArenaService`) own the database access and the clock.
20. **Every usage value carries its provenance.** A `Measured<T>` has a value, a source and a confidence. A percentage
    exists only with confidence `EXACT`; NEXUS never invents a remaining-quota figure. See USAGE_INTELLIGENCE.md.
21. **Claude availability is a gate, not a failure.** `Orchestrator.setDispatchGate` takes the usage service. While it
    is closed no session starts and nothing is failed; checks and merges in flight finish. The durable state of a
    wait is the `quota_pauses` row, so a restart during a wait loses nothing. See QUOTA_RECOVERY.md.
22. **The usage report is optional.** `getUsageReport` on `AgentRuntime` wraps an SDK method declared experimental. It
    returns null on any failure and callers treat null as UNKNOWN; recovery then falls back to a minimal session probe.
23. **Arena trials are ordinary runs in isolated repositories.** Each trial has its own repository under
    `<data>/arena/`, its own project row (found through `arena_trials.project_id`; `ProjectRepository.list()`
    and the Home and Activity queries exclude it; Arena runs and events are filtered out in SQL) and its own memory, facts and outcomes. The hidden evaluator is copied in only after the run ends. See
    ARENA.md and BENCHMARK_METHODOLOGY.md.
24. **Ranking is lexicographic and versioned.** `score-v1` orders trials by correctness first; the convenience score
    cannot hide a failed hidden evaluation. The version is stored with every result.
25. **Evidence is labelled, never pooled.** Arena trials are controlled evidence; mission outcomes are observational
    and weighted lower. Displayed counts keep them apart. Statistics use Wilson intervals and no p-values.
26. **Policy changes only by explicit promotion.** `PolicyService` writes immutable snapshots; promotion, rollback and
    pin move or add snapshots and are user actions. Learning proposes candidates and never edits NEXUS source code.
    See ADAPTIVE_POLICY.md.
27. **The speculative tournament uses objective checks only.** No model opinion and, in an Arena trial, no hidden
    evaluator is an input. Candidates are separate clones of the repository (own refs and objects, no remote), not
    worktrees, and a speculative run moves `running`, `decided`, `adopted`. See SPECULATIVE_EXECUTION.md.
28. **Migration 004 is additive.** `004-v0-3.ts` creates tables and indexes only; no existing table is altered (the
    design planned a `projects.kind` column; the code identifies Arena projects through `arena_trials.project_id`
    instead). New tables: `usage_events`, `usage_windows`, `quota_pauses`, `quota_resumes`, `arena_cases`,
    `arena_case_versions`, `arena_campaigns`, `arena_trials`, `arena_trial_metrics`, `arena_evaluations`,
    `task_profiles`, `mission_outcomes`, `policy_snapshots`, `policy_decisions`, `policy_candidates`,
    `policy_promotions`, `strategy_statistics`, `speculative_runs`, `candidate_results`, `tournament_decisions`. Columns added by the audit: `arena_trials.block_kind`,
    `strategy_statistics.distinct_units`; index `idx_arena_trials_project`. Indexes
    cover the aggregation keys (run, day, model, strategy, campaign, agent, task). `RunConfig` gains the optional
    `strategy` object, stored in the existing `runs.config` JSON.

29. **Commands NEXUS runs on project code carry no Claude credentials.** Dependency installs, check commands and every Arena
    command use `projectCommandEnv()` (no `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
    `NODE_OPTIONS`, `NODE_PATH`); the Arena removes every `ANTHROPIC_*` variable as well.
30. **Unattended Arena trials answer approvals by rule.** Tool requests are denied; plan, task and graph approvals are
    granted unless a high-risk task would start. Every strategy gets the same rule.
31. **A trial's outcome says what it measured.** `blockKind` (`infrastructure`, `run`, `timeout`) separates a harness
    failure, which is excluded from statistics and policy evidence, from a failure of the strategy, which counts.
32. **The previous database is kept.** Before a schema upgrade `openDatabase` copies `nexus.db` to `nexus.db.v<old>.bak`
    (once per old version, never overwritten), because an upgraded database cannot be opened by the older NEXUS.
33. **A finished Arena campaign triggers learning, never promotion.** `learnOnCampaignEnd` (`policy/wiring.ts`) calls
    `PolicyService.learn()` once when a campaign completes.

### Composition root order (`src/main/runtime/core.ts`, `startRuntimeCore`)

Until 0.6 this was `bootstrap` in `src/main/index.ts` and ended with the window; the window is now `desktop.ts` and
is no part of it. The order in `core.ts`:

1. Database, repositories, event bus, `GitService`; the push channel (to every connected window, and to the notifier).
2. Runtime: `ClaudeSdkRuntime`, or `FakeAgentRuntime` in an unpackaged build with `NEXUS_FAKE_RUNTIME=1`.
3. The worker manager, and at once `recoverOnBoot()`: workers and leases of the earlier start are stale. Real provider
   runtimes are wrapped so that their sessions run in workers (`hostInWorkers`).
4. `ProviderService` and its router, which is the `AgentRuntime` every later module sees.
5. `UsageIntelligenceService` and `RuntimeAvailabilityProbe`.
6. `PolicyService` (`ensureDefault()`, `attachOutcomeRecording`).
7. `Orchestrator` (with `strategies: policy`), `setDispatchGate(usage)`, then `recoverOnStartup()`: runs that were active
   are paused with reason `recovery`.
8. `QuotaRecoveryController` (test timing overrides read only in an unpackaged build), then `recover()`.
9. Power controller and `OvernightSupervisor` (receives the same `probe`; keep-awake goes through the host).
10. `ArenaService` (its push is wrapped by `learnOnCampaignEnd`), `syncBuiltinCases()`; the workload registrations of the
    supervisor; `ProgramEngine`, `BackgroundEngineering`, `WorkspaceEngine`.
11. `ControlPlane`, then `RuntimeNotifier`, then the dispatch gate again, now asking the control plane per run.
12. The recovery chain, started in the background: Arena, background jobs, programs, workspaces, then the control plane
    (`recoverOnBoot`), then the overnight supervisor's recovery. The phase becomes `READY` when it finishes.
13. The IPC handlers: the base handlers and `createV3Handlers` to `createV7Handlers`.
14. The local server starts listening, the endpoint file is written and its access list narrowed, and the idle timer starts.

At a stop (`stop()` in `core.ts`) the overnight finalization in flight finishes first (at most 30 seconds), then the control
plane, engines and quota controller are disposed, the orchestrator stops its sessions, the worker manager stops its workers,
the server closes, the endpoint file is removed and the database is checkpointed and closed. An armed Windows failsafe is
left alone: it belongs to Windows.

### Provider abstraction

What exists is the `AgentRuntime` interface (`agent-runtime/types.ts`) with two implementations: `ClaudeSdkRuntime`
and `FakeAgentRuntime`. The interface has session start, resume, message, interrupt and stop, capabilities, account
information, the optional `getUsageReport` and `shutdown`. No other provider is implemented and no provider registry
or provider-selection setting exists. Everything that mentions Claude limits, plans or models is written for the
Claude runtime. Adding a provider would need a new implementation of the interface and new classification rules in
`usage/classify.ts`; neither exists.

The v0.3 renderer replaces the 0.2 shell (navigation in three groups, a contextual page header, a Ctrl+K palette) and
adds Home, Arena, Policy and Usage views. v0.3 IPC channels are in ARENA.md, ADAPTIVE_POLICY.md and
USAGE_INTELLIGENCE.md. Design: V0_3_DESIGN.md.

## v0.6: providers

`src/shared/provider.ts` holds the provider model, the provider policy schema and the pure routing decision
(`routeSession`). `src/main/modules/providers/` holds `ProviderService` (discovery, policy, health, the record of
provider sessions) and its router, which implements `AgentRuntime`: the main process hands the router to the
orchestrator, the usage service, the Arena, programs and workspaces in place of the Claude runtime, so none of
them changed. `ClaudeAgentRuntimeProvider` wraps the Claude SDK runtime; `CodexRuntimeProvider` and
`CodexCliRuntime` drive the Codex command line tool through the process runner, read-only;
`GeminiRuntimeProvider` only detects. `provider_sessions` (migration 008) records which provider ran each
session and why. Design and use: PROVIDERS.md.

## v0.5: the workspace module

`src/shared/workspace.ts` holds the data, the zod schemas and the pure decisions (`dependencyOrder`,
`validateWorkspacePlan`, `compareSurfaces`, `planRelease`, the mission state table). `src/main/modules/workspace/`
holds `WorkspaceEngine` (it owns the database access and the clock), `contracts.ts` (reads a contract file into a
surface; local and deterministic) and `discovery.ts` (reads manifests; no install, no network). IPC channels are
`workspace.*` in `src/main/modules/ipc/v5-handlers.ts`. Design and use: WORKSPACES.md,
MULTI_REPO_ORCHESTRATION.md, CONTRACTS.md, RELEASE_TRAINS.md.

34. **A cross-repository task is an ordinary mission.** The engine does not schedule agents. It asks the orchestrator
    (through the same `ProgramRunHost` interface the program engine uses) for one `mission` run per task in that
    task's project, and for one read-only `ask` run to plan. Worktrees, review, verification and repair stay the
    orchestrator's. The engine decides the order, the base of each run and what the whole verification says.
35. **A plan is validated against the workspace and always approved by the user.** `validateWorkspacePlan` checks
    repositories, the policy, task dependencies and the organization graph; a valid plan waits in
    `AWAITING_APPROVAL`. The engine runs one writer per repository and at most `maxParallelRepositories` at once.
36. **Edges have provenance.** Every dependency is stored with its source (`manifest`, `contract`, `user`), the file
    that shows it and a sentence. Manifest edges are recomputed on discovery; the others are kept.
37. **Contract versions are recorded for verified work.** A mission compares the provider's contract at its own base
    and at its result, during verification, and stores a version only when the whole mission passed. `unknown` is
    treated as breaking.
38. **NEXUS prepares releases and never publishes.** `publishing` is the literal `never` in the policy schema,
    `ReleaseTrain.publishAuthorized` is the literal `false`, and `workspace.publishRelease` always refuses and
    records the request.
39. **A workspace mission is an overnight workload.** `WorkspaceMissionWorkload` implements `AutonomousWorkload`; the
    engine owns the mission, the supervisor owns the deadline, the failsafe and the power decision. The engine
    subscribes to run events, observes the usage dispatch gate and recovers its open missions at startup
    (`workspaces.recover()` runs after the program engine's recovery).
40. **Migration 007 is additive.** `007-workspaces.ts` creates `workspaces`, `workspace_repositories`,
    `workspace_services`, `workspace_dependencies`, `workspace_contracts`, `workspace_contract_consumers`,
    `workspace_contract_versions`, `workspace_missions`, `workspace_tasks`, `workspace_programs`,
    `workspace_release_trains`, `workspace_memory` and `workspace_decisions`, with indexes. No existing table is
    altered.

## Data location

`%APPDATA%/NEXUS/` (Electron `userData` of the window): `nexus.db` (SQLite, WAL) and `worktrees/<run>/<task>/`,
where `<run>` is the first 8 hex characters of the run id. Overridable with `NEXUS_DATA_DIR` for tests; the window passes
its data directory to the runtime it starts. Since 0.7 the runtime also keeps there: `runtime/endpoint.json` (the pipe name
and the token; its access list is narrowed to the user), `runtime/runtime.log` (one earlier file is kept; lines carry no
prompt text), `runtime-profile/` (the runtime's own Chromium profile and single-instance lock), `overnight.key` (the
sealing key, see `OVERNIGHT_MODE.md`) and `reports/`. Claude session transcripts are stored by the Claude runtime itself
under `~/.claude/projects/`.
