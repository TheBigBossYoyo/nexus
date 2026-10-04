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
  shared/            pure TS shared by main and renderer: domain types, zod schemas, events, IPC contract
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
      ipc/           validated IPC handlers and read-model services
  preload/           narrow typed bridge (CJS, sandboxed)
  renderer/          React UI
tests/
  unit/ integration/ scenarios/ stress/ smoke/   (Playwright E2E is run by `pnpm test:e2e`)
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
   session id, and leaves the run resumable.

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

## Data location

`%APPDATA%/NEXUS/` (Electron `userData`): `nexus.db` (SQLite, WAL) and `worktrees/<run>/<task>/`,
where `<run>` is the first 8 hex characters of the run id. Overridable with `NEXUS_DATA_DIR` for tests. Claude session transcripts are stored by the
Claude runtime itself under `~/.claude/projects/`.
