# Security model

NEXUS is a local desktop tool that runs Claude agents with your user's permissions on your machine. The
controls below reduce what an agent can do by mistake or by prompt injection. They are policy checks in
application code, not an operating-system sandbox (see Known gaps).

## Process model

| Process | Privileges | Responsibilities |
|---|---|---|
| Main (Node, Electron) | Full user rights | SQLite database, Git, orchestration, the Agent SDK, IPC handlers, folder picker |
| Preload (CJS, sandboxed) | None beyond `contextBridge` | Exposes `window.nexus` with exactly `invoke(channel, input)` and `onPush(listener)` |
| Renderer (React) | Sandboxed web content | UI only; reaches the system only through the bridge |
| `claude.exe` (one per agent session) | User rights | Spawned by the SDK with `cwd` set to the agent's worktree and a controlled environment |

Window settings (`src/main/index.ts`): `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, `webSecurity: true`. Other hardening in the same file:

- New-window requests are denied; `http(s)` links are handed to the OS browser with `shell.openExternal`.
- `will-navigate` to any URL other than the app's own is prevented.
- A single-instance lock; a second launch focuses the first window.
- The scripted fake runtime can only be enabled when the app is not packaged.

Content Security Policy (`src/renderer/index.html`): `default-src 'self'; script-src 'self'; style-src
'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:*`
(the WebSocket entry serves the dev server). No remote scripts, images or fonts can load.

ESLint forbids the renderer from importing `node:*`, `electron`, `better-sqlite3`, `@anthropic-ai/*` and
`@main/*`, and forbids `src/shared` from importing adapters.

## IPC

One request channel (`nexus:invoke`) and one push channel (`nexus:push`), defined in
`src/shared/ipc-channels.ts`. In the main process:

1. The handler checks the sender: `event.senderFrame.url` must start with the dev server URL (unpackaged
   with `ELECTRON_RENDERER_URL`) or the file URL of the bundled `index.html`. Otherwise it returns
   `invalid_input: Untrusted sender`.
2. `dispatchIpc` requires the channel to be in the contract (`isIpcChannel`); unknown channels are refused.
3. The input is parsed with that channel's strict zod schema (`ipcInputs[channel]`, unknown keys rejected,
   string lengths and numeric ranges bounded) before any handler runs.
4. Errors are returned as typed results (`{ ok: false, error: { code, message } }`); handlers do not throw
   into the renderer.

The renderer never sends commands to run or Git arguments. `projects.open` takes an optional folder path (the
folder picker runs in main and is used when it is omitted). The path is checked before the filesystem is touched:
it must be an absolute local path (a drive letter such as `C:\` or `C:/` on Windows, a root on POSIX). UNC and
network paths (`\\host\share`, `//host/share`), device and extended-length paths (`\\?\`, `\\.\`), empty or
NUL-containing paths and relative paths are refused with `invalid_input`. A folder that passes is only read
(profiled and analysed), never written. Project removal deletes NEXUS records only.

## Role tool policies

Each agent is given a tool list by `toolsForRole` and a per-call authorizer from `createAuthorizer`
(`src/main/modules/policies/`).

| Role | Built-in tools | Shell |
|---|---|---|
| `worker`, `debugger` | Read, Glob, Grep, Edit, Write, NotebookEdit, Bash, PowerShell, TodoWrite | Any command not forbidden; gated ones need approval |
| `planner`, `architect`, `researcher`, `security_reviewer` | Read, Glob, Grep, Bash, PowerShell | Read-only inspection commands only |
| `reviewer`, `verifier` | Read, Glob, Grep, Bash, PowerShell | Inspection plus verification commands (tests, build, lint, typecheck, including the run's configured check commands and Settings, Permissions, "safe command prefixes") and plain installs |

WebFetch and WebSearch are added for non-writing roles only when Settings, Permissions, "allow network
tools" is on (default off). `Agent` and `Task` are never available (also in `disallowedTools`); a call to
them is denied. Unknown tools are denied.

The runtime evaluates the policy twice (SDK `tools` restriction, then the `PreToolUse` hook and
`canUseTool`); see AGENT_RUNTIME.md. Any exception inside the policy is a deny.

### Decisions

| Call | allow | ask (user approval) | deny |
|---|---|---|---|
| `Read` | Inside the worktree, project root or extra read roots | Looks like a secret (`.env*`, keys, `.npmrc`, `.netrc`, `.ssh`, `.aws`, credentials files) | Outside the read roots |
| `Edit`, `Write`, `NotebookEdit` | Inside the worktree, not inside `.git` | | Inside `.git`; elsewhere in the project root (with a message pointing to the worktree); anywhere else (no approval path) |
| `Glob`, `Grep` | Base path in the read roots and no escaping pattern | Secret base path | Base path or `..`/absolute pattern reaching outside the read roots, `~` |
| `Bash`, `PowerShell` | Classified `safe` or `write` and permitted for the role | Findings that need approval (below) | `forbidden` commands; commands the role may not run |
| `WebFetch` | http(s) public hosts | `localhost`, private ranges, `.local`, `.internal` | Non-http(s), invalid URL |
| `mcp__nexus__*` | Always | | |
| Other `mcp__*` | Server enabled for the role in Settings and the run | | Everything else |

## Path boundaries

`canonicalizePath` resolves a path against a base, applies `realpath` to the nearest existing ancestor
(so symlinks and junctions cannot be used to escape) and throws for UNC and device paths, alternate data
streams (`:`), wildcards, NUL and dangling links. `isPathInside` compares canonical paths
case-insensitively on Windows. Writing agents are confined to their own worktree; the project root is
readable but not writable for them. Shell commands are also checked for path arguments (and redirect
targets) that fall outside the worktree, which becomes an approval request.

## Command classification and approval gates

`classifyCommand(command, 'bash' | 'powershell', { roots, safeCommandPrefixes })` tokenizes the command
(pipelines, `&&`, `;`, redirections, substitutions, nested `bash -c` / `powershell -Command` / `cmd /c`
up to depth 6), classifies every sub-command, and returns a level.

| Level | Meaning |
|---|---|
| `safe` | Every sub-command is read-only inspection |
| `write` | Anything else that is not gated |
| `needs_approval` | At least one finding; carries a risk of low, medium or high and reasons |
| `forbidden` | Denied with no approval path |

Forbidden: anything referring to the Claude credential store (`.claude/.credentials*`), commands that disable
or modify security tooling (Defender preferences, firewall profiles, `bcdedit` integrity switches and the
like), and commands the analyzer cannot parse safely.

Read-only status is decided per command, not by name alone: options that run a program or write a file
(`git grep -O`/`--open-files-in-pager`, `--output`, `--ext-diff`, `--exec`, unique abbreviations of those,
`sort -o`/`--compress-program`, `tree -o`, `rg --pre`/`-z`, `uniq IN OUT`, `date -s`, PowerShell script-block
arguments) make a segment non-read-only, and a `GIT_*`/`PAGER`/`EDITOR`/`LD_*`/`PATH` assignment needs approval.
WebFetch treats loopback, private, link-local, CGNAT and unspecified addresses as private in every literal
spelling (trailing dot, IPv6 and IPv4-mapped forms, decimal/octal/hex IPv4) and single-label intranet names.

Needs approval (examples, the full list is in `command-classifier.ts`): elevation (`sudo`, `gsudo`, `-Verb
RunAs`); download-and-execute pipes; encoded PowerShell; shells without an inspectable command or running a
script file; WSL; destructive deletes and moves (recursive or forced, `find -delete`, `robocopy /mir`);
paths outside the worktree; secret-looking environment variable references; changing machine or user
environment variables or the registry; global or system package installs; publishing (npm, cargo, twine,
docker push, gem, nuget); Git operations that publish or destroy (`push`, `reset --hard`, `clean -f`,
`branch -D`, `rebase`, history rewriting, `worktree remove`, `reflog expire`, `config --global`); network
operations (`git fetch/pull/clone`, `gh`, certutil, .NET web clients); requests to run outside the tool
sandbox (`dangerouslyDisableSandbox`).

Approval flow: the authorizer returns `ask` with the reasons and the risk. `AgentRunner.requestToolApproval`
sets the agent `waiting`, creates an `approval_requests` row of kind `tool` containing the exact command, and
awaits your decision in the UI. Approving lets that one call run; denying returns a denial to the agent.
Pending tool approvals are expired when the agent ends, the run is cancelled, or the app restarts.

Restricted roles: for roles that are not `worker` or `debugger`, any sub-command whose kind is not allowed
for the role (see the role table) is denied outright, and redirection to files counts as not read-only.

## Subscription-mode environment sanitization

`buildAgentEnv` copies the NEXUS process environment for the agent, removing `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` (any letter case) when Subscription Mode is on, and adds
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. It never mutates `process.env`. The same stripping is applied to the
status probe. NEXUS never reads credential files or tokens; see AUTHENTICATION.md.

## Isolation from `~/.claude` and project configuration

Sessions start with `settingSources: []` (no user, project or local settings), `strictMcpConfig: true`,
`skills: []`, auto-memory disabled and an explicit `permissionMode: 'default'`. The runtime's
`claude_code` system prompt is kept and NEXUS appends the role prompt. Per project there is an explicit
opt-in (`respectProjectClaudeConfig`, default false) that adds `settingSources: ['project']`, loading the
project's `CLAUDE.md` and `.claude` settings into the agents' sessions. Treat enabling it as trusting that
repository's configuration: project settings can carry their own hooks and permission rules, which the
NEXUS policy does not review.

External MCP servers (Settings, MCP) are configured by you, run with your privileges, and are available only
to the roles you tick. NEXUS applies no per-tool policy to them.

## Markdown and untrusted text

Agent output, plans, review findings and user text are rendered with `react-markdown` and
`rehype-sanitize` (`src/renderer/src/components/ui/Markdown.tsx`). Only `http(s)` links are rendered as
links (opened in the OS browser); other schemes and relative links become plain text; images are never
loaded (the CSP also forbids remote images). Check output and diffs are shown as text.

## Data at rest

The SQLite database stores prompts, plans, agent output, tool inputs and 500-character output previews, and
check output in plain text under `%APPDATA%\NEXUS`. It is not encrypted. If an agent reads a file that
contains a secret, fragments may be stored there; secret-looking paths require approval to read.
Hidden reasoning is not stored. Claude's own transcripts are stored by the runtime under `~/.claude/projects`.

## Known gaps

- **No OS sandbox.** Native Windows has none for this design. Agents and everything they launch run as
  your user. A forbidden or gated command is stopped by the classifier, not by the OS.
- **The classifier is heuristic.** It cannot see inside inline interpreter code (`python -c`, `node -e`),
  script files or programs an agent writes and then runs, nor what a build tool or test runner does. For the
  `worker` and `debugger` roles such commands are not approval-gated, and a program run this way can read
  or write anywhere your user can. Restricted roles are denied commands that are not recognised as
  read-only, verification or install.
- **Writes are only controlled for the file tools.** `Edit` and `Write` are confined to the worktree;
  shell commands rely on the classifier's path checks.
- **NEXUS-run commands skip the policy engine.** The dependency install in new worktrees and the project's
  check commands are executed by NEXUS itself (`runCommandLine`, no shell, with a timeout and output cap).
  They come from the project's lockfile and scripts, but install scripts and tests are project code.
- **Commits skip Git hooks** (`--no-verify`) and signing.
- **Prompt rules are not enforcement.** Instructions such as "never push" are in the role prompts; only
  the classifier enforces them, and it can be overridden by your approval.
- **Approvals show the command, not a prediction of its effects.** Read the exact command before approving.
- **The IPC sender check is URL-based** and relies on Electron reporting the frame URL correctly.
- **Unsigned builds.** Nothing in the repository signs the installer.
- **Quota and billing signals come from the runtime**, so NEXUS cannot guarantee which credential an
  agent used beyond what the runtime reports (AUTHENTICATION.md).
