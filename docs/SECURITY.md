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
| `mcp__nexus__*` | Always (what each tool may do is enforced in its handler, see Agent-to-NEXUS tools) | | |
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

### Command classes (0.2.1)

`classifyCommand` also returns `commandClass` (the most severe class seen) and `classes` (all of them), derived
from the parsed executable and arguments, not from string prefixes. The existing `level`/`risk` fields are
unchanged in meaning.

| Class | Examples | Writing roles in their worktree |
| --- | --- | --- |
| `SAFE_READ` | `git status/diff/log/show`, `pnpm test/lint/typecheck`, `ls`, `rg` | allowed |
| `SAFE_PROJECT_WRITE` | `mkdir`, `touch`, file redirection or `rm` of a file inside the worktree, plain `pnpm install` | allowed |
| `GIT_LOCAL` | `git add`, `git commit` (plain, `--amend`, `-F file`, `-F -` with a quoted heredoc, `-m "$(cat <<'EOF' ... EOF)"`), `git branch`, `git worktree list/add`, `git stash`, `git switch/checkout`, `git merge`, `git tag` | allowed |
| `NETWORK` | `git push/fetch/pull/clone`, `curl`, `npm/pnpm publish`, `docker push`, `gh` | approval |
| `SYSTEM_CHANGE` | registry writes, services, `schtasks`, `powercfg`, global installs, machine env vars, `sudo` | approval |
| `DESTRUCTIVE` | `git reset --hard`, `git clean -fd`, `git push --force`, `git branch -D`, `git worktree remove/prune`, `git rebase`, `rm`/`Remove-Item` outside the worktree or recursive | approval |
| `UNKNOWN` | anything unrecognised | unchanged from 0.2.0 (not gated for writing roles; denied for restricted roles) |

Heredoc commit messages: Claude's habitual `git commit -m "$(cat <<'EOF' ... EOF\n)"` used to be parsed as shell,
so prose in the message (`<noreply@...>` trailers, paths, `$TOKEN`, "rm -rf") raised approval requests that were
denied in unattended runs. The message body is now treated as inert text, but only when the whole substitution is a
single `cat` reading a heredoc with a quoted delimiter, nothing else is on the opener line, the terminator is a line
of its own, the substitution closes right after it, and it is the value of `-m` on `git commit`. An unquoted
delimiter (the body would expand), extra commands, pipes, nested substitutions or any other host command fall back to
ordinary analysis, so a smuggled command is still classified and gated.

Power commands are forbidden for every role, not approval-gated: `shutdown`, `psshutdown`, `Stop-Computer`,
`Restart-Computer`, `rundll32 powrprof.dll,SetSuspendState`, `wmic os ... shutdown/reboot`, `Invoke-WmiMethod -Name
Shutdown`, `Win32Shutdown`, `systemctl poweroff/reboot/suspend` and similar are denied with no approval path, including
through `cmd /c`, `powershell -Command`, `bash -c`, `Start-Process`, `&`/call operator, `Invoke-Expression`,
`schtasks /tr`, `sudo`, full paths and `.exe` suffixes. Detection works on parsed executables and launcher
arguments; a command that is built dynamically at run time (for example from a variable) is still approval-gated as
uninspectable but cannot be proven to be a power command.

Hardening (0.2.1 audit): command words are matched after undoing trivial obfuscation (`shut^down`, `sh\utdown`,
`'shut''down'`, `"shut"+"down"`, `%COMSPEC% /c`), inline interpreter code (`node -e`, `python -c`, `perl -e`,
`ruby -e`, `php -r`, `awk`) is scanned for power names and APIs, PowerShell/.NET/COM spawn calls
(`[Diagnostics.Process]::Start`, `WScript.Shell.Run`, `Shell.Application`) combined with a power name are forbidden,
and `pnpm exec`/`npx`/`busybox <power command>` is forbidden. A command word that is a variable or command
substitution in bash (`$s /s`, `$(echo x) /s`) and `& $x` in PowerShell need approval (high). `rundll32` always needs
approval. `git config` writing a key that makes git run programs (`alias.*`, `core.editor/fsmonitor/hooksPath/sshCommand/pager`,
`credential.*`, `include*`, `url.*`, `filter.*`, `diff.*`, `merge.*`, `gpg.*`, `sequence.*` ...) needs approval in every
scope; reads and harmless keys are unchanged. `git -C/--git-dir/--work-tree` must resolve inside the worktree and may
not be computed at run time, and assigning or exporting any `GIT_*` variable needs approval. Any command text that
names `nexus.db` (including `-wal`/`-shm`) or `overnight.key` is forbidden for every role, except inside a `git commit`
message.

This is a best-effort lexical filter, not an OS sandbox. A writing agent can run code it wrote (tests, scripts), so a
determined or prompt-injected agent could still run a power command, or abort a failsafe with `shutdown /a`, from its
own program; a script written in one command and run in another is not caught. NEXUS's guarantee is narrower and
holds regardless: no NEXUS mechanism (tool, message, proposal, IPC) gives an agent the power controller or the stored
authorization, and the plain and commonly obfuscated command forms above are refused.

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

## Agent-to-NEXUS tools (v0.2)

The in-process `mcp__nexus__*` tools skip the command policy, so their handlers carry the trust decisions.

**`propose_graph_change`.** A proposal is data, not a capability. The model's input is parsed by `GraphProposalInputSchema`
and then validated by `validateProposal` against the graph as it is; an agent cannot widen its own tools, paths or approvals
through it, and new tasks take the policy of their role like any planned task. Trust boundaries:

- Only sessions with a task and a work role (`worker`, `debugger`, `architect`, `researcher`) in an implement, diagnose or
  research purpose get the tool; planners, reviewers, verifiers, the critic, the synthesizer and the arbiter never do.
- Completed, failed and cancelled tasks and repair tasks cannot be changed. A running task of another agent can neither gain
  nor lose a prerequisite. Cancelling another agent's task, rewiring or reprioritising it, replanning, and adding more than 3
  tasks need user approval (approval kind `graph`); so do task-adding proposals past the run-wide limits (20 applied proposals,
  25 added tasks). At most 5 proposals per task and 8 new tasks per proposal. Exact numbers and rules: ORCHESTRATION.md.
- A graph approval shows the exact operations. When you approve, the proposal is validated again against the current graph
  before it is applied.
- ASK and AUDIT runs stay read-only: a proposal cannot add a task with a writing role there.
- Rejections tell the agent why and not to work around them. The rejected proposal is stored with its reasons.

**`send_message`.** An agent can send only the types in `AGENT_MESSAGE_TYPES`. `user_instruction` and `review_finding` are
authoritative message types written by the user and by NEXUS; an agent that claims one is stored as `information`. Subjects
are whitespace-flattened and cut to 200 characters. Messages are still agent-written text: recipients treat them as input,
not as instructions from the user.

**Sanitized orchestration evidence.** Verifiers get records of messages, decisions and graph proposals from the database. Each
record is one line built by NEXUS (`- record <kind> <id>: ...`); agent-written fields (subjects, titles) have control
characters and all whitespace replaced by a space and are cut to 120 characters, so an agent cannot start a record of its own
or fake one with a newline. The existence, sender, recipient, type and time of a record are authoritative; the quoted text is
not, and the section says so. Decision bodies and proposal reasons are never shown to a verifier, and review findings and user
instructions are left out of the message records. See ORCHESTRATION.md.

**Agent-recorded decision facts.** When a task passes verification, the decisions its agents recorded (`record_decision`)
become repository facts of kind `decision` with source `agent` and confidence `medium`. They are marked as unverified in two
places: the stored statement starts with "Agent-recorded decision (not independently verified)", and the prompt that includes a
fact shows its source and confidence for facts from agents, verifiers or users. Refreshing repository analysis never overwrites
or deletes them; they are marked stale when the files that supported them change.

**Repository analysis.** `intelligence/` reads file names, sizes, manifests and bounded file prefixes (at most 200 000 bytes per
file, 4000 files, 5 seconds). It skips secret-looking files (`.env*`, `id_rsa`-style keys, `.pem`, `.key`, `.p12`, `.pfx`,
`credentials`), never follows symbolic links or junctions, and treats paths outside the root as missing. It never writes to the
project. `projects.open` accepts only absolute local paths (see IPC).

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

## 0.3: Arena, candidates and command environment

| Area | What NEXUS does | Where |
|---|---|---|
| Arena case trust | Built-in cases are trusted on registration. An imported case is untrusted and executes nothing at import. `arena.trustCase` shows a native Windows confirmation that lists every setup, check and evaluation command; a script in the renderer cannot click it. `createCampaign` refuses untrusted cases | `ipc/v3-handlers.ts`, `arena/case-format.ts` |
| Case pinning | The evaluator hash covers the evaluator files, command, timeout and the whole `case.json`. The stored definition is what runs; a changed case under the same version is refused, and every provisioning and evaluation re-hashes | `hashCaseEvaluator`, `loadVerifiedCase` |
| Case content | A `.git` entry in a fixture or evaluator is refused; symbolic links are refused; a case is capped at 5000 files and 50 MB | `listFilesRecursive` |
| Hook-free Git on case content | Every Git command the Arena runs on a trial repository uses `core.hooksPath` set to an empty directory, `core.fsmonitor=false`, no system or global Git configuration, `--template=` on init and clone, and `--no-verify` on the baseline commit | `arena/fixtures.ts` (`gitGuard`) |
| Evaluator isolation | The evaluator lives outside every trial and worktree and is copied into a throw-away export only after the agents are done. A result commit that already contains a top-level evaluator path fails the trial as tampering and nothing runs. The copy never overwrites and never follows a link; the export is cloned with `core.symlinks=false` | `arena/evaluator.ts` |
| Credential-free command environment | Dependency installs and check commands run by NEXUS (`runOne` in `orchestrator/core.ts`) and every Arena command (setup, evaluator, Node preflight) run with `projectCommandEnv()`: no `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `NODE_OPTIONS` or `NODE_PATH`. Arena commands also lose every `ANTHROPIC_*` variable and `NODE_TEST_CONTEXT` (`arena/env.ts`) | `process/run-process.ts` |
| Candidate isolation | Each speculative candidate works in its own clone (own object store and refs, no remote), so no Git command in one candidate can show another's commits; its path boundary is its own clone | `orchestrator/speculation.ts`, SPECULATIVE_EXECUTION.md |
| Unattended trials | The Arena answers approval requests with the unattended rule: tool requests denied, plan, task and graph approvals granted, a high-risk task start denied. Nobody is asked | `ArenaService.answerApproval` |
| Usage probes | No scraping, no private endpoint, no credential read. The usage report query and the minimal probe session use no tools | USAGE_INTELLIGENCE.md |
| Power isolation | Unchanged: only the overnight supervisor holds the power controller; no 0.3 module imports it | OVERNIGHT_MODE.md |
| Database copy before an upgrade | `openDatabase` keeps `nexus.db.v<old>.bak` once per old schema version before migrating | `persistence/database.ts` |

Limits of these measures:

- Arena cases run `node`, which must be on `PATH` (version 20 or newer). NEXUS ships none and resolves `node` the way `runCommandLine`
  does; a hostile `node` earlier on `PATH` would run with your user's permissions.
- The agent shell policy is still a lexical filter. A worker can run code it wrote, in its own clone or worktree or elsewhere
  your user can write. Trial isolation holds for NEXUS's own mechanisms (paths, projects, prompts, Git), not against a
  program an agent writes and runs.
- Case commands run with your user's permissions and without an operating-system sandbox; the trust confirmation is the
  control for imported cases.
- The environment filter removes the variables named above. Other secrets in the process environment are passed on.

## Hardening of 2026-10-05 (0.6)

Found by an adversarial review of the boundaries and fixed, each with a test that fails without the fix:

- **NEXUS's own git commands run nothing a repository configures.** Every git call passes
  `core.fsmonitor=false`, `core.hooksPath=<an empty directory NEXUS owns>`, `core.pager=cat` and
  `protocol.ext.allow=never`, and runs without the Claude credentials and Node options NEXUS withholds from
  project commands. Before this, a hook or an exec-capable configuration key that an agent left in the shared
  repository ran inside NEXUS's own git calls, with NEXUS's environment.
- **NEXUS does not write through a worktree whose `.git` pointer was changed.** Before any git command that
  changes something, the worktree's `.git` file is checked against Git's own back-pointer in the repository. A
  pointer that names the user's repository or another task's worktree is refused.
- **`git config` is checked word by word.** A dangerous key behind an option that takes a value
  (`git config --type bool core.fsmonitor ...`) used to pass.
- **Any command but git that names a `.git` path asks first**, in bash and PowerShell: the worktree pointer,
  the repository's configuration and its hooks.
- **A provider's command line tool is found on PATH only** and started by its absolute path (see PROVIDERS.md).

Open findings of the same review, by severity:

- HIGH, by design: a writing agent can write a script and run it, and the script is not inspected. Through it
  an agent can do what the user can do, including `shutdown` and `shutdown /a`. See "No OS sandbox" below. The
  statement "an agent cannot trigger or cancel the overnight shutdown" holds against commands the classifier
  recognises, not against an agent that hides them in a file.
- MEDIUM: `git branch -f`, `git tag -f` and `git update-ref` on refs outside `nexus/` do not ask; agent-written
  text is rendered into other agents' prompts under headings without a fence (message types cannot be forged);
  with "respect the project's Claude configuration" on, a repository's `.claude/settings.json` can carry hooks;
  overnight approves plan and graph changes by default; a trial's code can read the hidden evaluator at
  evaluation time; bare `git` is resolved by the system's search.

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
  They come from the project's lockfile and scripts, but install scripts and tests are project code. Since 0.3 they run
  without Claude credentials and without `NODE_OPTIONS` or `NODE_PATH` (see "0.3" above).
- **Commits skip Git hooks** (`--no-verify`) and signing.
- **Agent-written text is not evidence.** Message subjects, decision text and proposal reasons come from agents. NEXUS marks them as such where it shows them to other agents, but a verifier or reviewer model can still be influenced by them.
- **Prompt rules are not enforcement.** Instructions such as "never push" are in the role prompts; only
  the classifier enforces them, and it can be overridden by your approval.
- **Approvals show the command, not a prediction of its effects.** Read the exact command before approving.
- **The IPC sender check is URL-based** and relies on Electron reporting the frame URL correctly.
- **Unsigned builds.** Nothing in the repository signs the installer.
- **Quota and billing signals come from the runtime**, so NEXUS cannot guarantee which credential an
  agent used beyond what the runtime reports (AUTHENTICATION.md).
