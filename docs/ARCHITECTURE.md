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
    index.ts         Electron bootstrap, window, composition root
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
      ipc/           validated IPC handlers and read-model services; v0.3: v3-handlers.ts (usage.*, arena.*, policy.*)
      usage/         v0.3: classify.ts (pure), machine.ts (pure status machine, quota-wait planner), service.ts
                     (UsageIntelligenceService, the dispatch gate), recovery.ts (QuotaRecoveryController), probe.ts
      strategy/      v0.3: strategies.ts (five strategies as engine configuration), tournament.ts (pure ranking)
      policy/        v0.3: profiler.ts, stats.ts, engine.ts, learning.ts (pure); service.ts, snapshots.ts, simulator.ts
      arena/         v0.3: case-format.ts, fixtures.ts, evaluator.ts, scoring.ts, metrics.ts, campaign.ts (ArenaService)
      overnight/     v0.2.1: supervisor, report, tray model; v0.3: AutonomousWorkload, MissionWorkload, ArenaCampaignWorkload; v0.4: ProgramWorkload
      program/       v0.4: engine.ts (ProgramEngine), reasoning.ts (prompts, parsing), memory.ts, background.ts
  preload/           narrow typed bridge (CJS, sandboxed)
  renderer/          React UI
tests/
  unit/ integration/ scenarios/ stress/ smoke/   (Playwright E2E is run by `pnpm test:e2e`)
arena/
  cases/<id>/        v0.3: the twelve built-in Arena cases (case.json, fixture/, evaluator/, README.md)
```

Dependency direction: `renderer → preload bridge → ipc → orchestrator/services → domain
(task-graph, scheduler, state, policies) → adapters (agent-runtime, git, persistence)`.
`src/shared` depends on nothing but zod. Domain modules never import Electron, the SDK, or SQLite.

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

### Composition root order (`src/main/index.ts`, `bootstrap`)

1. Database, repositories, event bus, `GitService`, push channel to the renderer.
2. Runtime: `ClaudeSdkRuntime`, or `FakeAgentRuntime` in an unpackaged build with `NEXUS_FAKE_RUNTIME=1`.
3. `UsageIntelligenceService` and `RuntimeAvailabilityProbe`.
4. `PolicyService` (`ensureDefault()` creates the default snapshot; `attachOutcomeRecording` subscribes to run events).
5. `Orchestrator` (with `strategies: policy`), then `setDispatchGate(usage)`, then `recoverOnStartup()`.
6. `QuotaRecoveryController` (test timing overrides read only in an unpackaged build), then `recover()`. At shutdown the
   controller is disposed and awaited (`idle()`) before the database closes.
7. Power controller and `OvernightSupervisor` (receives the same `probe`).
8. Window, tray and quit handling.
9. `ArenaService` (its push is wrapped by `learnOnCampaignEnd`), then `syncBuiltinCases()`, then `recover()` in the background.
10. IPC handlers, with the 0.3 handlers (`createV3Handlers`) built from the usage service, recovery controller, Arena and policy.

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

## Data location

`%APPDATA%/NEXUS/` (Electron `userData`): `nexus.db` (SQLite, WAL) and `worktrees/<run>/<task>/`,
where `<run>` is the first 8 hex characters of the run id. Overridable with `NEXUS_DATA_DIR` for tests. Claude session transcripts are stored by the
Claude runtime itself under `~/.claude/projects/`.
