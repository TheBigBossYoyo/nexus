# Agent runtime

`src/main/modules/agent-runtime/` is the only code that imports `@anthropic-ai/claude-agent-sdk`
(version pinned in `package.json`: **0.3.288**, V1 `query()` API). The orchestrator sees only the
interfaces in `types.ts`.

| File | Role |
|---|---|
| `types.ts` | `AgentRuntime`, `SessionSpec`, `AgentSessionHandle`, `AgentEvent`, `TurnResult`, `NexusToolHandlers` |
| `claude-sdk-runtime.ts` | `ClaudeSdkRuntime`: the real adapter, policy gate, in-process MCP server, auth and model discovery |
| `translate.ts` | `translateSdkMessage`: SDK message to `AgentEvent` |
| `resolve-executable.ts` | `resolveClaudeExecutable`: finds `claude.exe` in the SDK's platform package, rewriting `app.asar` to `app.asar.unpacked` |
| `fake-runtime.ts`, `demo-script.ts` | `FakeAgentRuntime` for tests and UI end-to-end runs |
| `async-queue.ts` | `AsyncQueue`, the single-consumer FIFO used for input and events |

## The `AgentRuntime` interface

```ts
interface AgentRuntime {
  startSession(spec: SessionSpec): AgentSessionHandle
  resumeSession(spec: SessionSpec, sdkSessionId: string): AgentSessionHandle
  sendMessage(handle, text): void
  interruptSession(handle): Promise<void>
  stopSession(handle): Promise<void>
  getCapabilities(): Promise<RuntimeCapabilities>   // models, supportsResume, sdkVersion, ...
  getAccountInfo(o: { subscriptionMode: boolean }): Promise<AuthStatus>
  shutdown(): Promise<void>
}
```

`SessionSpec` carries everything a session needs: `cwd`, `model`, `maxTurns`, `systemPromptAppend`
(the role prompt), the first `prompt`, the `tools` list, the `authorize` and `requestApproval`
callbacks, an optional `outputSchema`, `nexusTools`, external `mcpServers`, `resumeSessionId`,
`loadProjectSettings` and `subscriptionMode`.

An `AgentSessionHandle` exposes `events` (single consumer, always ends with exactly one
`session.ended` whatever happens), `send`, `interrupt`, `end` and `stop`. `stop()` is idempotent. A
crash of one session does not affect others.

## SDK options NEXUS sets

`ClaudeSdkRuntime.startSession` builds these `query()` options:

| Option | Value | Why |
|---|---|---|
| `prompt` | An `AsyncIterable<SDKUserMessage>` queue | Streaming-input mode: follow-up messages (user instructions, routed agent messages) can be pushed to a live session. |
| `cwd` | `spec.cwd` (task worktree for writing roles) | Isolation: writes happen in the worktree. |
| `model` | Resolved from the tier via settings; omitted when empty | Alias such as `opus`, `sonnet`, `haiku`, resolved by the runtime. |
| `effort` | Only if `spec.effort` is set. The orchestrator does not set it. | Left to the runtime default. |
| `maxTurns` | `spec.maxTurns` | Bounded agents; also triggers session rotation. |
| `includePartialMessages` | `true` | Streams `text.delta` to the UI. |
| `permissionMode` | `'default'` | Since SDK 0.3.286 an omitted mode defers to user settings; NEXUS sets it explicitly. |
| `tools` | `spec.tools` (from `toolsForRole`) | Restricts which built-in tools exist for the model. `allowedTools` would only auto-approve, not restrict. |
| `disallowedTools` | `['Agent', 'Task']` | No nested subagents. |
| `systemPrompt` | `{ type: 'preset', preset: 'claude_code', append: role prompt }` | Keeps the runtime's own safety text; adds the role policy. |
| `settingSources` | `[]`, or `['project']` when the project opted in | Isolation from `~/.claude` and project settings (see SECURITY.md). |
| `strictMcpConfig` | `true` | Only the MCP servers NEXUS passes are used. |
| `skills` | `[]` | No ambient skills. |
| `mcpServers` | The `nexus` server plus the enabled external servers for the role | See below. |
| `outputFormat` | `{ type: 'json_schema', schema }` when `outputSchema` is set | Structured output for planner, reviewer, verifier and handoff. |
| `resume` | `spec.resumeSessionId` when resuming | Session resume. |
| `hooks.PreToolUse`, `canUseTool` | The `PolicyGate` | Policy enforcement. |
| `env` | `buildAgentEnv(process.env, { subscriptionMode })` | The SDK replaces the child environment, so the full environment is copied, minus `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` in Subscription Mode (case-insensitive on Windows), plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_AGENT_SDK_CLIENT_APP=nexus`. |
| `pathToClaudeCodeExecutable` | Settings override, else `resolveClaudeExecutable`; omitted if neither is found | The SDK's own lookup applies when omitted. |
| `stderr`, `debug` | Only when Settings, Advanced, "debug SDK" is on | Logging. |

## Policy gate

`PolicyGate` wraps `spec.authorize`, which the orchestrator builds with `createAuthorizer` (see SECURITY.md).

- The `PreToolUse` hook runs before any permission rule or mode, so it is the primary gate. Decisions:
  allow, deny (with reason) or ask.
- `canUseTool` handles the ask path (it reuses the decision the hook made, so `authorize` runs once per
  tool call) and any call the hook did not see. For ask it calls `spec.requestApproval`, which waits for
  the user, raced against the SDK's abort signal.
- Any throw, unknown decision or failed approval becomes a deny.
- Every deny emits a `tool.denied` event.
- `mcp__nexus__*` tools are always allowed without calling `authorize`.

## Event translation

`translateSdkMessage(msg, state)` is a pure mapping to `AgentEvent`s:

| SDK message | Event |
|---|---|
| `system` init | `session.started` (once; init repeats every turn) with session id, model, tools, `apiKeySource` |
| Assistant text block | `text` (persisted as agent output) |
| Partial stream text | `text.delta` (UI only, never persisted) |
| Tool use / tool result | `tool.started` / `tool.completed` (result preview capped at 500 characters) |
| Rate-limit event | `rate_limit` with status, `resetsAt`, `limitType` |
| Status | `status` |
| Result | `turn.completed` with a `TurnResult` |

Dropped on purpose: thinking blocks (hidden reasoning is never stored) and subagent traffic
(`parent_tool_use_id` set). An assistant message that carries an error emits no text.

`TurnResult.outcome` is classified from the result message:

| Outcome | When |
|---|---|
| `success` | Normal success (and structured output present when one was requested) |
| `max_turns` | `error_max_turns` |
| `structured_output_failed` | Retries exhausted, or a successful result without the schema output |
| `aborted` | Aborted terminal reason, or an error after `interrupt()` |
| `auth` | An authentication error was seen on the turn |
| `quota` | A `rate_limit_event` with status `rejected`, an assistant `rate_limit` or `billing_error`, or result text starting with one of the SDK's `USAGE_LIMIT_ERROR_PREFIXES` |
| `error` | Anything else that failed |

Usage is taken from the result's `modelUsage` (input, output, cache read and creation tokens, cost,
context window with 0 mapped to null). Nothing is estimated; values the SDK does not report stay null.

## Structured output

Planner, per-task reviewer and verifier, the mission verifier and the handoff request pass a JSON
Schema (draft-07, generated from the zod schemas by `z.toJSONSchema` in `context-builder.ts`:
`missionPlanJsonSchema`, `reviewOutputJsonSchema`, `verifierOutputJsonSchema`, `handoffJsonSchema`).
The SDK enforces the schema; NEXUS validates the returned object again with the zod schema before
using it. Review and verification gates retry once on invalid output (`TaskPipeline.gate`).

## In-process `nexus` MCP tools

`createNexusMcpServer` builds an in-process server (`createSdkMcpServer`, name `nexus`; the name is
reserved and rejected for external servers). Tools, handled by `AgentRunner.buildSpec`:

| Tool | Effect |
|---|---|
| `send_message` | Persists and routes a message (types from `MESSAGE_TYPES`) to a task, a role, or the sender's dependants. |
| `report_blocker` | Records a `blocker` message; if the agent's turn then succeeds, the task becomes `blocked` (`task.blocked`) instead of continuing to checks. |
| `record_decision` | Inserts a `decisions` row, visible to dependants and architect-informed context. |
| `propose_memory` | Creates a `proposed` memory entry. |

Tool handler errors are returned to the model as error results, never thrown into the SDK.

External MCP servers come from Settings; a server is passed to a session only if it is enabled, lists
the agent's role, and is enabled in the run's `enabledMcpServers`. A stdio server needs a `command`,
http and sse need a `url`.

## Session resume, rotation and handoff

Three different mechanisms (`AgentRunner.run`, `TaskPipeline.implement`):

- **Resume** (`resume: sdkSessionId`): used when the task's last implementing agent ended for a
  resumable reason (`paused`, `quota`, `auth`, `app_restart`, `shutdown`). The same Claude session
  continues with the prompt "Continue the task from where you stopped. Check `git status` and `git log`
  first". It does not consume an attempt.
- **Fresh session**: after any failure (error, crash, `max_turns`, user stop), a new session starts with a
  new context pack that includes the previous error. This consumes an attempt.
- **Rotation and handoff**: for implement and repair agents, a session's `maxTurns` is
  `min(sessionRotationTurns, remaining turns)` (default 60 of 80). When a session ends with `max_turns`
  and turns remain, NEXUS resumes that session with no tools, `maxTurns: 3` and the handoff schema to get
  a structured `Handoff` (completed work, commits, files changed, unresolved issues, findings, next
  steps), marks that session record `rotated` and stores the handoff, emits `agent.rotated`, and starts a
  fresh session with `buildResumeFromHandoffPrompt`. If the handoff cannot be obtained, a fixed fallback
  handoff pointing to `git log` and `git status` is used. `sessionRotationTurns: 0` disables rotation.

Session ids and states are persisted in `agent_sessions` (`sdkSessionId`, `endReason`, `handoff`).
Claude's own transcripts are stored by the runtime under `~/.claude/projects`.

## Cancellation

- `SessionControl.stop(reason)` (reasons `paused`, `cancelled`, `user_stop`, `shutdown`) marks the
  control and calls `stop()` on every live handle: input is closed, `query.close()` terminates the
  `claude.exe` process, and the handle waits for its pump to finish.
- A stop requested while a session is still being created takes effect as soon as it exists.
- `interrupt()` aborts the current turn and keeps the session; the resulting error result is classified
  `aborted`. The orchestrator itself uses `stop()`.
- A pending tool approval is raced against the abort signal and is expired when the agent finishes.
- `runtime.shutdown()` stops every live session (application quit).

## Authentication and models

`getAccountInfo` starts a streaming-input query whose prompt never arrives (no model call), reads
`initializationResult()` (account and supported models, 20 second timeout), and closes it with
`persistSession: false`. The account is mapped to `AuthStatus` by `authStatusFromAccount`; errors become
`runtime_unavailable` or `sdk_error` via `authStatusFromError`. See AUTHENTICATION.md.
`getCapabilities` returns the discovered models and the SDK version.

## FakeAgentRuntime

`FakeAgentRuntime` implements `AgentRuntime` with a script per session. It is the only runtime used by
automated tests.

- A `FakeScript` is `(spec, ctx) => Promise<void>`. `ctx` offers `emitText`, `useTool(name, input,
  run?)` (goes through the real `spec.authorize` and `requestApproval`, emits `tool.started`, and
  `tool.denied` plus an error `tool.completed` on a denial), `completeTurn({ text, structuredOutput,
  outcome })`, `nextMessage()` for follow-ups, `rateLimit(...)`, `sleep(ms)`, `fail(error)` and `signal`.
- `scriptsByRole({ planner, worker, reviewer, ... }, fallback)` picks a script by `spec.role`;
  `completeWith(...)` is a script that completes with a fixed result.
- `session.started` is emitted synchronously from `startSession`. A script that returns ends the
  session `completed`; a throw or `fail()` ends it `crashed`; `stop()` ends it `stopped` and force-ends
  after 2 seconds if the script ignores its signal. Session ids are `fake-session-N`; on resume the id
  equals the requested one.
- `mcp__nexus__*` tools bypass `authorize`, as in the real runtime.
- It records `sessions` (the specs it received) and `handles`, so tests can assert on prompts and tools.
- `createDemoScript()` (`demo-script.ts`) is a scripted three-task plan used by UI tests. The main
  process uses it only when `NEXUS_FAKE_RUNTIME=1` and the app is not packaged.
