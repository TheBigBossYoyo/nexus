# Claude Web Tools: Research

Research and recommendation. Date: 2026-10-11. Nothing in this document is implemented. No source code was changed
and no model was called for it: no inference was run and no subscription usage was spent. Statements about Anthropic
products come from the documentation pages listed at the end (fetched on the date above) and from the type
definitions of the installed SDK. Every claim that could not be confirmed without running inference is marked
**NOT VERIFIED**, and the cheap run-time check that would verify it is named.

## Summary

- The API server tools `web_search` and `web_fetch`, the `computer` toolset and the `browser` toolset are API
  features. They are billed through an API key (search at $10 per 1,000 searches plus tokens). NEXUS does not use
  an API key by default, so none of them is a route for NEXUS.
- The Agent SDK ships its own built-in tools `WebSearch` and `WebFetch`. They are Claude Code tools, not the API
  server tools. `WebSearch` calls Anthropic's search backend; `WebFetch` fetches the page on the user's machine and
  runs the extraction prompt through a separate model call. Whether either is available to, and accepted by, a
  Max-subscription session is **NOT VERIFIED** here; the SDK `init` message lists the tools the session actually
  has, and NEXUS should read that rather than assume.
- Anthropic's Agent SDK overview carries a note that, unless previously approved, third-party developers may not
  offer claude.ai login or rate limits in their products. NEXUS is a local tool that drives the user's own
  installed login. Whether that sits inside the note is a policy question this document cannot answer. It is
  recorded as a risk, not decided.
- "Claude in Chrome" is a browser extension connected to the Claude Code CLI or VS Code, with a direct Anthropic
  plan. Whether it is reachable from an SDK-spawned process is **NOT VERIFIED**. It uses the user's real, logged-in
  browser, which is the opposite of what NEXUS wants for untrusted content.
- None of Anthropic's prompt-injection defenses is described as a boundary. Anthropic says no browser agent is
  immune. NEXUS must not count on them (see `docs/UNTRUSTED_CONTENT_SECURITY.md`).

## 1. Claude API server tools (separately billed)

Source: platform.claude.com docs, web search tool and web fetch tool pages.

**web_search**

| Item | Value |
|---|---|
| Versions | `web_search_20250305` (basic), `web_search_20260209` (adds dynamic filtering), `web_search_20260318` (adds `response_inclusion`) |
| Pricing | $10 per 1,000 searches, plus standard token costs for the results (results count as input tokens in later turns too). A failed search is not billed. |
| Controls | `max_uses` (over the limit: result is an error `max_uses_exceeded`), `allowed_domains` or `blocked_domains` (not both, bare domains with optional path), `user_location`, `allowed_callers` |
| Citations | Always on. `web_search_result_location` with url, title, `cited_text` (up to 150 characters), `encrypted_index`. `encrypted_content` of results must be passed back unmodified in multi-turn use. |
| Dynamic filtering | From `web_search_20260209` on Claude 4.6 and later: Claude writes code that filters results before they enter context; runs through code execution, provisioned automatically, no extra charge beyond tokens. `allowed_callers: ["direct"]` turns it off. |
| Org controls | An administrator can disable it or restrict domains in the Console (Messages API). Disabled gives a 400. |
| Platforms | Claude API; Claude Platform on AWS; Microsoft Foundry; Google Cloud (basic only). Not Amazon Bedrock. |

**web_fetch**

| Item | Value |
|---|---|
| Versions | `web_fetch_20250910` (basic), `web_fetch_20260209` (dynamic filtering), `web_fetch_20260309` (adds `use_cache`), `web_fetch_20260318` (adds `response_inclusion`) |
| Pricing | No charge beyond tokens. A 10 kB page is about 2,500 tokens; a 500 kB PDF about 125,000. |
| Controls | `max_uses` (no default; failed fetches count), `allowed_domains` / `blocked_domains`, `citations.enabled` (off by default), `max_content_tokens` |
| Limits | URL at most 250 characters. Content types: text, HTML, PDF only. No JavaScript-rendered pages. |
| URL validation | Only URLs that already appeared in user messages, client-side tool results, or earlier search/fetch results may be fetched. URLs only in Claude's own output, or only in the system prompt, may not. A URL that looks like it contains a credential is refused unless the credential is in the system prompt or a user message. Private addresses and `robots.txt` are refused on Anthropic's side. |
| Anthropic's own warning | "Enabling the web fetch tool in environments where Claude processes untrusted input alongside sensitive data poses data exfiltration risks", and "there is still residual risk". Their suggestions: disable it, use `max_uses`, use `allowed_domains`. |

Both are server tools: Anthropic executes them. NEXUS does not see the network request, cannot apply its own
address checks to it, and cannot apply an authorizer between the model's decision and the fetch. That is a reason
to prefer a NEXUS-run fetch layer for anything security relevant.

## 2. Computer use and browser use (API client tools)

Source: platform.claude.com docs, computer use tool and browser use tool pages. The last 7,839 characters of the
browser page and 18,510 of the computer page were not read.

| | Computer use | Browser use |
|---|---|---|
| Current type | `computer_toolset_20260801` (17 member tools such as `screenshot`, `left_click`, `type`, `zoom`) | `browser_toolset_20260801` (27 member tools such as `navigate`, `read_page`, `left_click`, `screenshot`; `javascript_exec`, `file_upload`, `read_console`, `read_network` off by default) |
| Earlier types | `computer_20251124`, `computer_20250124`. Claude 5.5 and later on the Claude API and Google Cloud return an error for them. | none listed |
| Beta header | Current toolset: none. Earlier versions: a beta header (value not read). | None listed |
| Who runs it | Your application. Anthropic runs nothing. A sandboxed environment you control is required (the reference setup is a Docker container with Xvfb, Mutter, Firefox). | Your application runs the browser and the executor. Not available in Managed Agents. |
| Models (named) | Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5.5, Opus 5, Sonnet 5.5, Sonnet 5, Opus 4.8, Haiku 5.5 | Same list |
| Billing | API key, token cost, no tool surcharge stated | Same |
| Anthropic's stated precautions | Dedicated VM or container with minimal privileges; no sensitive data or credentials; allowlist of domains; human confirmation for consequential actions | Container or VM with a fresh profile; domain allowlist at the network layer re-checked after redirects; block loopback, link-local and private ranges; treat tab titles, URLs and download details as untrusted; only `http` and `https` schemes (refuse `javascript:`, `file:`, `data:`); parse URLs with a parser, not string prefixes; keep `javascript_exec` and `file_upload` off |
| Classifiers | Scan tool returns such as screenshots for likely injection; when one fires, Claude is steered to check that the instruction came from the user. Opt-out through support. Stated not to replace the precautions. | Same, for page text and screenshots |

These are client tools of the Messages API. They are not exposed as Agent SDK options. Using them means calling the
API with a key, which NEXUS does not do by default. The precaution lists above are, however, Anthropic's own
design guidance for any browser layer NEXUS builds, and they are used in `docs/UNTRUSTED_CONTENT_SECURITY.md`.

## 3. Claude in Chrome

Source: code.claude.com docs, "Use Claude Code with Chrome".

- A browser extension (version 1.0.36 or later) connected to Claude Code through `--chrome` or `/chrome`, and to
  VS Code. Works with Chrome and Edge, other Chromium browsers detected; not in WSL.
- Needs a direct Anthropic plan (Pro, Max, Team, Enterprise) and a `/login` sign-in. With an API key or a
  `claude setup-token` long-lived token, Chrome integration stays off.
- It opens new tabs in the user's own browser and shares its login state: it can reach every site the user is
  signed in to. Site permissions are inherited from the extension. It can read console, network, upload files
  (up to 10 MB, credential-named files refused) and record GIFs.
- A project's `.claude/settings.json` cannot turn it on (`CLAUDE_CODE_ENABLE_CFC` in project settings is ignored).
  This is a deliberate protection against a hostile repository.
- Windows: uses a native messaging host registered under `HKCU\Software\Google\Chrome\NativeMessagingHosts\`
  (or the Edge key) and a named pipe.
- **NOT VERIFIED:** that an SDK-spawned `claude.exe` (as NEXUS starts it) connects to the extension at all. The
  docs describe the CLI and VS Code. Check: start a session with the `claude-in-chrome` MCP server absent and read
  the `init` message's `mcp_servers` and `tools`; no inference is needed for that. Whether to use it at all is a
  separate question: it runs in the user's real browser profile and is the wrong tool for untrusted web content.

## 4. The Agent SDK's built-in WebSearch and WebFetch

Source: code.claude.com docs, tools reference; SDK type definitions (`sdk-tools.d.ts`).

**WebSearch**
- Input: `query`, optional `allowed_domains`, `blocked_domains` (not combined in one call).
- Runs against Anthropic's web search backend and returns titles and URLs only; it does not fetch pages. Up to
  eight backend searches per call. The backend is not configurable; another provider needs an MCP server.
- Permission rules take no specifier: bare `WebSearch` allow or deny only.
- Availability: stated for the Claude API, Claude Platform on AWS, Microsoft Foundry, Google Cloud; not Bedrock.
  The tools reference does not say what applies to a claude.ai subscription session. **NOT VERIFIED.**

**WebFetch**
- Input: `url`, `prompt`. Output: `bytes`, `code`, `codeText`, `result`, `durationMs`, `url`.
- Fetches the page (HTML converted to Markdown), then runs the prompt against the content in a separate model
  call; Claude receives that call's result, not the page. Documented as lossy by design. Reads up to 100,000
  characters per call. Caches 15 minutes (`CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS`). Five-minute deadline
  (`CLAUDE_CODE_WEBFETCH_DEADLINE_MS`).
- Refuses `localhost` and any hostname without a dot. A redirect to a different host is returned as text naming
  the target, not followed.
- Permission: prompts in Manual and `acceptEdits` modes except for allowed or denied domains and a built-in set of
  preapproved documentation domains. Rule form `WebFetch(domain:example.com)`; `WebFetch(domain:*)` allows all;
  an explicit rule beats the preapproved set. `auto` and `bypassPermissions` skip the prompt except for an
  explicit `ask` match.
- A "WebFetch domain safety check" runs first (see the data usage page for what it sends). Not read in detail:
  **NOT VERIFIED** what it sends and whether it applies to a NEXUS session.
- Can be turned off with `CLAUDE_CODE_DISABLE_WEB_FETCH=1` (Claude Code 2.1.285 or later). For Team and
  Enterprise accounts it also depends on organization policy fetched from `api.anthropic.com`; a session whose
  plan cannot be determined, "such as one running under a claude.ai token that another app supplied", may have
  WebFetch withheld until a policy loads.
- Because `WebFetch` fetches from the user's machine, the address that is contacted is decided by the local DNS and
  network. Two consequences for NEXUS: the existing `isPrivateHost` check sees only the literal hostname in the
  tool input, and the redirect handling and the safety check are Claude Code's, not NEXUS's.
- The extraction call means untrusted page text is read by a second model before the worker sees it. That is a
  filter, not a boundary (the second model can be injected too and its output is still model text).

## 5. Agent SDK use with a claude.ai subscription login

- The SDK overview page states: "Unless previously approved, Anthropic does not allow third party developers to
  offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the
  API key authentication methods described in the Quickstart instead."
- The SDK's `init` message has `apiKeySource`; the value `'none'` means "no API key in use - e.g. claude.ai OAuth
  login". So the SDK and the bundled CLI do run on an OAuth login technically.
- NEXUS strips API key variables in subscription mode (`buildAgentEnv`, `KEY_VARS`) and uses the login stored by
  the user's own installed Claude Code. NEXUS does not offer a claude.ai login to anyone else; it drives the
  user's own. Whether that is within Anthropic's terms is not decided here and the note above is the only stated
  limit found. **NOT VERIFIED** beyond that sentence. If a stricter reading applies, the fallback is an API key,
  which is separately billed and therefore not allowed by default.
- Other stated limits found: Chrome integration needs `/login` (no API key, no `setup-token`); Team and Enterprise
  accounts may have WebFetch gated by organization policy.

## 6. Installed SDK: exact option names

Package `@anthropic-ai/claude-agent-sdk` 0.3.288, bundling Claude Code 2.1.288 (`package.json`:
`claudeCodeVersion`). Types in `sdk.d.ts` (`Options`) and `sdk-tools.d.ts`. Names below are as declared.

**Process launch**
- `pathToClaudeCodeExecutable?: string`: the `claude` binary to run. NEXUS sets it from `resolve-executable.ts`.
- `spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess`: replaces the default local spawn "to run
  Claude Code in VMs, containers, or remote environments". `SpawnOptions` is `{ command, args, cwd?, env, signal }`.
  `signal` is a forwarded signal that aborts only after stdin EOF plus a grace window of about 2 seconds, so it is
  safe to hand to `spawn()`. `SpawnedProcess` needs `stdin: Writable`, `stdout: Readable`, `killed`, `exitCode`,
  optional `signalCode`, `kill(signal)`, and `on`/`once`/`off` for `'exit'` and `'error'`. A Node `ChildProcess`
  already satisfies it. Custom spawners "emit plain process exit" (no stderr-drain wait).
- This is the hook for launching the agent's process tree inside a Windows Job Object or restricted token:
  NEXUS's spawner starts `command args` itself (suspended, assign to job, resume, or via a helper that does so),
  and returns the child. Whether `stderr` can be captured through the same function is not in the type: the
  `stderr` option exists on `Options` (NEXUS passes it) but how it interacts with a custom spawner is **NOT
  VERIFIED**. Check: unit-test with a fake spawner that is a plain `child_process.spawn` of a stub script, no model.
- `executable?: 'bun' | 'deno' | 'node'`, `executableArgs?: string[]`, `extraArgs?: Record<string, string | null>`
  (arbitrary CLI flags), `cwd`, `additionalDirectories?: string[]`.
- `env?: Record<string, string>`: **replaces** the subprocess environment entirely; not merged with `process.env`.
  NEXUS builds the whole environment (`buildAgentEnv`) and also sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and
  `CLAUDE_AGENT_SDK_CLIENT_APP=nexus`.
- Also: `abortController`, `stderr`, `debug`, `enableFileCheckpointing`, `resume`, `continue`, `maxTurns`, `model`,
  `effort`, `systemPrompt` (preset `claude_code` with `append`, `excludeDynamicSections`), `outputFormat`.

**Tools and permissions**
- `tools?: string[] | { type: 'preset'; preset: 'claude_code' }`: the set of built-in tools offered. NEXUS passes
  an explicit list. (Native builds may do search through Bash `find`/`grep`; list `Grep`/`Glob` to get the tools.)
- `allowedTools?: string[]`: auto-approve rules. A bare entry approves every call to that tool before
  `canUseTool` is consulted. NEXUS does not set it.
- `disallowedTools?: string[]`: bare name removes the tool from the model's context; scoped rules such as
  `Bash(rm *)` deny matching calls in every mode. `"*"` and `"mcp__*"` globs are accepted in deny rules.
- `canUseTool?: CanUseTool`: runs last, only for calls no earlier step resolved.
- `permissionMode`: `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`. Since SDK
  0.3.286 omitting it no longer means `default`, so NEXUS passes `'default'` explicitly (it does).
- `allowDangerouslySkipPermissions?: boolean`, `permissionPromptToolName?: string`, and `permissionPrompts` (docs: `'none'`
  means `canUseTool` is not called at the last step and unresolved calls are denied; Claude Code 2.1.259 or later;
  it is declared in the installed `sdk.d.ts`).
- `toolConfig?: ToolConfig`, `agents?: Record<string, AgentDefinition>`, `plugins?: SdkPluginConfig[]`, `skills`.
- Evaluation order (docs): hooks, deny rules, ask rules, permission mode, allow rules, `canUseTool`. A hook
  `allow` does not skip deny or ask rules; a hook `deny` applies even in `bypassPermissions`. Auto-approved calls
  never reach `canUseTool`; the SDK warns with code `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` for the two configurations
  that shadow it.
- `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`. `HOOK_EVENTS` in this version: `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `UserPromptSubmit`, `UserPromptExpansion`,
  `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`,
  `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `PermissionRequest`, `PermissionDenied`, `Setup`,
  `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`,
  `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`,
  `MessageDisplay`. `PostToolUse` is the place for a tool-result envelope: its
  `hookSpecificOutput` has `updatedToolOutput?: unknown`, documented in the types as "Replaces the tool output
  before it is sent to the model" and as working for all tools (the older `updatedMCPToolOutput` is MCP only), and
  `additionalContext?: string`. That the CLI honors it for the built-in `WebFetch` result on 0.3.288 is **NOT
  VERIFIED** at run time (check: a stub session with a fake tool result; or one agreed real call).

**MCP**
- `mcpServers?: Record<string, McpServerConfig>` with stdio, sse, http, and in-process SDK servers.
- `createSdkMcpServer({ name, tools })` and `tool(...)` build an in-process server; `alwaysLoad?: boolean` on the
  server (and per tool) keeps tools out of deferred tool search. NEXUS uses this for its `nexus` server.
- `strictMcpConfig?: boolean`: only the MCP servers given in options. NEXUS sets it.
- MCP tool names appear as `mcp__<server>__<tool>`. Allow rules with globs are only accepted after a literal
  `mcp__<server>__` prefix. MCP tools whose server sets `_meta["anthropic/requiresUserInteraction"]` always fall to
  the callback.
- Tool search: when enabled, MCP tools are deferred and loaded by a `ToolSearch` tool; `alwaysLoad` overrides.

**Settings and sandbox**
- `settingSources?: ('user' | 'project' | 'local')[]`: `[]` is "SDK isolation mode"; omitted loads all sources;
  `'project'` is required to load CLAUDE.md files. NEXUS passes `[]`, or `['project']` when `loadProjectSettings`.
  That `['project']` setting is what lets a repository's CLAUDE.md and `.claude/settings.json` into a session; it
  is itself an untrusted-content channel (see the companion document).
- `settings?: string | Settings` (flag settings layer), `managedSettings?: Settings` (policy tier supplied by the
  parent).
- `sandbox?: SandboxSettings` (the Claude Code sandbox, with `network` allowlists such as `allowedDomains`,
  `allowLocalBinding`, `allowUnixSockets`). Whether this sandbox is implemented on Windows is **NOT VERIFIED**;
  the docs linked from the type are the macOS/Linux-first sandboxing page. Check: start a session on this machine
  with `sandbox: { enabled: true }` and read the `init`/status output; no inference needed if the CLI reports the
  failure at startup. Not relied upon in this design.

**Messages**
- `SDKSystemMessage` (`type: 'system'`, `subtype: 'init'`) carries `tools: string[]`, `mcp_servers`, `model`,
  `permissionMode`, `apiKeySource`, `claude_code_version`, `cwd`, `betas?`, `slash_commands`, `agents?`. It is
  emitted at the start of each turn.

## 7. How NEXUS uses it today

Files: `src/main/modules/agent-runtime/claude-sdk-runtime.ts`, `src/main/modules/policies/authorizer.ts`,
`src/main/modules/policies/tools.ts`, `src/main/modules/policies/capabilities.ts`,
`src/main/modules/orchestrator/agent-runner.ts`, `src/shared/settings.ts`.

**Session options** (`ClaudeSdkRuntime.startSession`): `permissionMode: 'default'`, `tools: spec.tools`,
`disallowedTools: ['Agent', 'Task']`, `settingSources: [] | ['project']`, `strictMcpConfig: true`, `skills: []`,
`mcpServers: buildMcpServers(spec)`, `includePartialMessages`, `systemPrompt` preset with append, `env` from
`buildAgentEnv`, and `pathToClaudeCodeExecutable` when one is resolved. `allowedTools` is not set. No
`spawnClaudeCodeProcess` and no `sandbox` option are used: the process is started by the SDK's default spawn, in
the user's context (consistent with `docs/WINDOWS_EXECUTION_ISOLATION.md`, "Position of 0.7").

**Which tools a worker gets** (`toolsForRole` in `policies/tools.ts`): `Read`, `Glob`, `Grep`, `Bash`,
`PowerShell` for every role; `Edit`, `Write`, `NotebookEdit`, `TodoWrite` for writing roles; `WebFetch` and
`WebSearch` only for non-writing roles and only when `settings.permissions.allowNetworkTools` is true (default
`false`, `src/shared/settings.ts`). `Agent` and `Task` are never offered. Plus the in-process `nexus` MCP server
(`createNexusMcpServer`: graph proposals, context tools, messages and memory proposals), whose tool names start
with `mcp__nexus__` and are allowed by prefix.

**How tool calls are authorized.** One `PolicyGate` per session (`claude-sdk-runtime.ts`):
1. A `PreToolUse` hook (`options.hooks`) is the primary gate. It calls `spec.authorize({agentId, toolName, input,
   toolUseId})`, and answers `allow`, `deny` (emits `tool.denied`) or `ask`. Any thrown error becomes a deny.
2. `canUseTool` handles the `ask` path: it reuses the hook's decision (kept in `pendingAsk`) so the authorizer runs
   once, otherwise calls the authorizer, and for `ask` calls `spec.requestApproval` raced against the abort signal.
3. The authorizer is `createAuthorizer` in `policies/authorizer.ts`, built per agent from role, worktree,
   execution profile and `allowNetworkTools`. A tool not in the role's set is denied with the list of available
   tools; a tool with no case in the `switch` is denied by default. Read, write, glob/grep and shell calls go
   through path, pattern and command classification (not covered here).
4. Network policy today: `WebSearch` is allowed if `query` is a string. `WebFetch` requires a parseable URL with
   `http:` or `https:`; a host that `isPrivateHost` calls private (any numeric spelling, IPv6 loopback, unique
   local, link-local, mapped, NAT64, 6to4, single-label names, suffixes such as `.local`, `.internal`) becomes an
   `ask` at medium risk; everything else is allowed. `isPrivateHost` is a check on the literal host text only: it
   does not resolve DNS. A public name that resolves to a private address, or that rebinds, is not seen, and
   redirects are Claude Code's.
5. No `PostToolUse` hook is installed. Tool results from `WebFetch`, `WebSearch` and `Read` reach the model
   unmarked and unscreened.

**Codex route** (`src/main/modules/providers/codex-runtime.ts`): `codex exec --json --skip-git-repo-check -m <model>
-c sandbox_mode=read-only [-s read-only --color never] -` with the prompt on stdin, one process per turn, started
through `runCli` (`providers/cli.ts`). NEXUS does not authorize Codex tool calls; the Codex sandbox does, and NEXUS
checks afterwards that the working directory is unchanged. No `--search` flag is passed. The installed
`codex-cli 0.130.0` documents a `--search` option: "Enable live web search. When enabled, the native Responses
`web_search` tool is available to the model" (`codex --help`, read without running inference). Whether web search
is on by default in `codex exec` for this version, and whether it is billed against the ChatGPT plan, is **NOT
VERIFIED**. Check: read the effective configuration from `codex exec --help` and `~/.codex/config.toml` keys (no
inference), then one tiny logged run only when the user agrees to spend usage.

## 8. Capability matrix

Columns: **API key** (Claude Messages API, separately billed, not allowed by default); **Max/SDK** (Agent SDK
session on the user's Max login); **Codex** (ChatGPT login through `codex exec`); **NEXUS layer** (a fetch and
browser layer NEXUS runs itself, no model involved).

| Capability | API key | Max via Agent SDK | Codex / ChatGPT | NEXUS layer |
|---|---|---|---|---|
| Web search | AVAILABLE (`web_search_*`, $10 per 1,000) but not allowed | NOT VERIFIED (built-in `WebSearch` exists in the tool types; presence and billing for a subscription session unconfirmed) | NOT VERIFIED (`--search` flag exists; default and billing unconfirmed) | NOT AVAILABLE as a search engine (needs a provider or an MCP search server); can be built as a tool that calls a search MCP |
| Web fetch | AVAILABLE (`web_fetch_*`, token cost only) but not allowed | NOT VERIFIED (built-in `WebFetch`; may be gated by org policy for Team/Enterprise) | NOT VERIFIED | AVAILABLE (NEXUS writes it; Section 4 of the companion document) |
| Dynamic filtering of search/fetch results | AVAILABLE (versions 20260209+) | NOT AVAILABLE as such (the SDK tools are different; the fetch tool runs an extraction model call) | NOT VERIFIED | Not applicable |
| Domain allow/block lists | AVAILABLE (`allowed_domains`, `blocked_domains`) | AVAILABLE for `WebSearch` inputs and `WebFetch(domain:...)` rules (docs); enforcement in NEXUS's hook is stricter and does not depend on it | NOT VERIFIED | AVAILABLE |
| Citations | AVAILABLE (always on for search; opt-in for fetch) | NOT VERIFIED (WebSearch returns titles and URLs; no citation blocks are documented) | NOT VERIFIED | AVAILABLE (NEXUS records source URL and hash itself) |
| Browser use (page interaction) | AVAILABLE as client tool `browser_toolset_20260801`; you must build the executor | NOT AVAILABLE through an SDK option; Claude in Chrome NOT VERIFIED | NOT AVAILABLE | AVAILABLE if NEXUS builds a browser executor (Electron or Playwright); separate sessions per companion document |
| Computer use | AVAILABLE as client tool `computer_toolset_20260801`; you build the sandbox | NOT AVAILABLE | NOT AVAILABLE | Not planned |
| Claude in Chrome | NOT AVAILABLE (needs `/login`, not an API key) | NOT VERIFIED (documented for CLI and VS Code only) | NOT AVAILABLE | NOT AVAILABLE |
| MCP tools (in-process or external) | AVAILABLE (MCP connector, client side) | AVAILABLE (`mcpServers`, `createSdkMcpServer`; already used) | NOT VERIFIED for NEXUS-supplied tools | AVAILABLE |
| Per-call authorization hook | Client loop is yours | AVAILABLE (`PreToolUse` hook and `canUseTool`; already used) | NOT AVAILABLE (Codex sandbox only) | AVAILABLE |
| Custom process spawn (Job Object) | Not applicable | AVAILABLE in the type (`spawnClaudeCodeProcess`); Windows behavior NOT VERIFIED | Possible through `runCli` (NEXUS starts it) | AVAILABLE |

## 9. Run-time discovery, not assumption

NEXUS should not hard-code "the Max route has web search". It should record what a session reports:

1. After starting a session, read the `init` system message: `tools` (is `WebSearch` or `WebFetch` present?),
   `mcp_servers` (names and `status`), `apiKeySource` (must be `'none'` in subscription mode; anything else means a
   key is in use and billing differs), `claude_code_version`, `permissionMode`. Persist it with the run (a
   capability snapshot) and let the director plan from the snapshot.
2. A cheap check that spends no usage: the `init` message is produced when a turn starts, so reading it costs a
   turn. Whether the SDK exposes the same data without a turn (for example the `Query` control methods such as
   `supportedCommands`/`mcpServerStatus`/`initializationResult`) is **NOT VERIFIED**; the types should be read for
   this (the `Query` interface in `sdk.d.ts`). `ClaudeSdkRuntime.initialize()` already calls such a path for
   models.
3. A tool being listed does not prove it works: it may be gated at call time (organization policy for `WebFetch`,
   backend availability for `WebSearch`). The honest check is one logged call in a validation run with the user's
   consent, recording the result type (`tool_result` or `tool.denied`) and `usage`. That check is the minimum
   inference needed and was **not** performed for this document.
4. A failed or missing capability must degrade to the NEXUS layer or to no web, never to an API key.

## 10. Prompt injection: what Anthropic says

Source: anthropic.com research post on prompt-injection defenses for browser use; the computer and browser tool
pages.

- Defenses named: reinforcement learning on simulated web content with embedded injections; classifiers over
  untrusted content entering the context; continuous red teaming and external challenges.
- Stated number: a 1% attack success rate for Claude Opus 4.5 against Anthropic's internal adaptive Best-of-N
  attacker with 100 attempts per environment, called "a significant improvement" but "still meaningful risk".
- Stated caveat: prompt injection is "far from a solved problem" and "No browser agent is immune".
- On the tool pages: classifiers scan screenshots and page text and steer Claude to check whether an instruction
  came from the user; they "don't replace the precautions" (isolation, allowlists, human confirmation).
- Whether these classifiers run in the Agent SDK's `WebFetch` and `WebSearch` is **NOT VERIFIED**; the pages
  describe them for the computer and browser tools.

## Recommendations

1. Treat the Max/SDK web tools as optional and discovered, never assumed. Default `allowNetworkTools` stays
   `false`.
2. Prefer a NEXUS-run fetch tool, exposed as an in-process MCP tool, over the built-in `WebFetch` for research
   roles, and deny the built-in `WebFetch` and `WebSearch` with `disallowedTools` in that case. The reasons: NEXUS
   then sees the connect-time address, controls redirects, bounds the response, labels the result and records the
   source. The built-in tool stays available as a fallback when the user turns it on.
3. Install a `PostToolUse` hook that uses `updatedToolOutput` to attach the trust label to built-in tool
   results where possible.
4. Use `spawnClaudeCodeProcess` for the Job Object work in `docs/WINDOWS_EXECUTION_ISOLATION.md` after a stub
   test; do not rely on the Claude Code `sandbox` option on Windows.
5. Do not use Claude in Chrome for research. It carries the user's logins.
6. Keep the claude.ai-login question open and visible to the user; do not silently fall back to an API key.

## NOT VERIFIED (consolidated)

| Claim | Check that would verify it (cheapest) |
|---|---|
| `WebSearch` / `WebFetch` appear in the `init` tools list of a Max-login SDK session on 0.3.288 | Read `init` of any one turn; or read `Query` control-method types |
| They work, and are covered by the subscription, not billed separately | One logged call in an agreed validation run; compare usage with the account page |
| The WebFetch domain safety check: what it sends, whether it applies | Read the data usage page section; observe network egress of a stub session |
| The CLI applies `updatedToolOutput` to a built-in `WebFetch` result (the type says it does) | Stub session with a fake tool result; no model if a stub tool can be forced, otherwise one agreed call |
| `spawnClaudeCodeProcess` works on Windows with a Job Object, stdio, stderr and graceful shutdown intact | Fake-spawner test with a stub child; no model |
| Claude in Chrome connects from an SDK-spawned process | `init` `mcp_servers` with the extension present |
| Claude Code `sandbox` option works on Windows | Start with it enabled and read startup status |
| Anthropic's terms for a local tool driving the user's own subscription login | Anthropic's terms or a written answer from Anthropic; not testable |
| Codex `exec` default for web search, and its billing | Read config defaults; one logged run with consent |
| Whether Anthropic's injection classifiers apply to the Agent SDK's web tools | Anthropic documentation or a staged benign-injection page in an agreed run |

## Sources

Fetched 2026-10-11 unless marked.

- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool (last 18,510 characters unread)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool (last 7,839 characters unread)
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/tools-reference
- https://code.claude.com/docs/en/chrome
- https://www.anthropic.com/research/prompt-injection-defenses
- Not fetched, referenced by link only: https://code.claude.com/docs/en/agent-sdk/hooks,
  https://code.claude.com/docs/en/data-usage#webfetch-domain-safety-check,
  https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md (the SDK changelog was not read).
- Local: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, `sdk-tools.d.ts`, `package.json`; `codex --help`
  output of `codex-cli 0.130.0`.
