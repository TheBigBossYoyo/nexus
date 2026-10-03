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
      task-graph/    DAG validation, cycle detection, readiness
      scheduler/     concurrency, leases, priorities, file-overlap serialization
      state/         task / agent / run state machines
      agent-runtime/ AgentRuntime interface, ClaudeSdkRuntime adapter, FakeAgentRuntime
      policies/      role tool policies, command classification, path boundaries, approvals
      git/           GitService (spawn with arg arrays), worktree manager
      planner/       planner invocation, plan validation and repair
      context/       ContextBuilder (context packs), handoff / session rotation
      messaging/     inter-agent message bus and routing
      memory/        global / project / run memory with FTS5
      verification/  check-command runner, review and verification records, failure objects
      orchestrator/  run lifecycle, task pipeline, repair loop, recovery
      profile/       read-only project discovery (ProjectProfile)
      ipc/           validated IPC handlers
  preload/           narrow typed bridge (CJS, sandboxed)
  renderer/          React UI
tests/
  unit/ integration/ scenarios/ e2e/ smoke/
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
   `ask` reaches `canUseTool`, which creates an `ApprovalRequest` and awaits the user. Nested
   subagents are disabled (`Agent`/`Task` are never in `tools`).

6. **Agents talk to NEXUS through an in-process MCP server** (`createSdkMcpServer`), exposing
   `send_message`, `report_blocker`, `record_decision`, and `propose_memory`. Planner, reviewer, and
   verifier return data through `outputFormat: { type: 'json_schema' }`, validated again with zod.

7. **Git model.** The user's working tree is never written to. A run gets an integration branch
   `nexus/<run>/integration` with its own worktree under the NEXUS data dir. Each writing task gets
   a branch `nexus/<run>/<task>` and worktree created from the integration tip once its dependencies
   are merged. A task that passes verification is merged into the integration branch under a mutex;
   a conflict aborts the merge, emits `git.conflict`, and creates a repair task. Bringing the
   integration branch into the user's branch is an explicit approval-gated action.

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

## Data location

`%APPDATA%/NEXUS/` (Electron `userData`): `nexus.db` (SQLite, WAL), `worktrees/<runId>/<task>/`,
`logs/`. Overridable with `NEXUS_DATA_DIR` for tests. Claude session transcripts are stored by the
Claude runtime itself under `~/.claude/projects/`.
