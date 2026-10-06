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
The check is lexical, on the host name in the URL: a public name that resolves to a private address, a DNS
rebinding answer, and a redirect from a public URL to a private one are not seen.

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
to the roles you tick. NEXUS gates them by server and role only (`allowedMcpServers` and `allowedMcpTools` in the
authorizer, and the per-run server list): a server you enabled for a role can be called with any of its tools and
any arguments, and NEXUS does not review what those tools do.

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

- **NEXUS's own git commands are not driven by what a repository configures for hooks, pager and fsmonitor.**
  NEXUS overrides fsmonitor, hooks, pager and the ext transport, takes the git directory of its worktrees from its
  own record instead of the worktree's `.git` file, and reads no replacement objects; filter, textconv and merge
  drivers are taken from the repository's own configuration, which agents cannot write without approval.
  They run without the Claude credentials and Node options NEXUS withholds from project commands.
  Before 0.6, a hook or an exec-capable configuration key that an agent left in the shared repository ran inside
  NEXUS's own git calls, with NEXUS's environment.
- **In its own worktrees NEXUS does not read the `.git` pointer at all** (0.7). For a worktree NEXUS created, every
  git command of NEXUS's names the Git directory explicitly (`--git-dir`, `--work-tree`): the entry the repository
  has for that worktree, found from NEXUS's own record of which repository the worktree belongs to. Rewriting,
  replacing or removing the `.git` file in the worktree therefore redirects nothing, for a read as for a write.
  A worktree NEXUS knows whose repository has no entry for it is refused. A Git service that has no record (the
  worker process that snapshots a working directory for another provider) verifies the pointer before every
  command and refuses a Git directory that lies inside the working tree, that is not at
  `<common dir>/worktrees/<name>` of its repository, or whose back-pointer names another worktree.
  The check of 0.6 compared only the back-pointer, and only before a command that changes something. The
  independent review of 0.7 showed that a Git directory an agent made itself inside the worktree passed it, and
  NEXUS's own commit then moved the user's branch. **0.6.0 has this defect.**
- **`git config` is checked word by word.** A dangerous key behind an option that takes a value
  (`git config --type bool core.fsmonitor ...`) used to pass.
- **A command but git that names a `.git` path in a form the classifier recognises asks first, and one that writes,
  moves or deletes the worktree's own top-level `.git` entry is refused** (0.7). "Names" means: a path segment that
  Windows reads as `.git` (any case, trailing dots and spaces, `::$DATA`/`:stream`, the 8.3 name `GIT~1`), as a
  word of the command or as a redirect target, for the commands the classifier knows write (`Set-Content`,
  `Out-File`, `Copy-Item`, `Move-Item`, `Rename-Item`, `New-Item`, `Remove-Item`, `cp`, `mv`, `rm`, `tee`, `dd`,
  `mklink`, `>` ...). Reading it, or touching something inside it (`.git\hooks`, `.git\config`), asks. It is not
  caught when the path is built at run time inside a program (`node -e`, a script), which is judged by what the
  script text shows; see "0.7: execution security".
- **A provider's command line tool is found on PATH only** and started by its absolute path (see PROVIDERS.md).

Open findings of the same review, by severity:

- HIGH, narrowed in 0.7: a writing agent can write a script and run it, and the script was not inspected.
  0.7 inspects scripts, inline code, encoded PowerShell and package scripts and refuses power commands in them
  (see "0.7: execution security"). It remains true that code NEXUS cannot read (a compiled binary, a command
  built at run time, a test file a test runner executes) can do what the user can do, including `shutdown` and
  `shutdown /a`. See "Not a full OS sandbox".
- MEDIUM: `git branch -f`, `git tag -f` and `git update-ref` on refs outside `nexus/` do not ask; agent-written
  text is rendered into other agents' prompts under headings without a fence (message types cannot be forged);
  with "respect the project's Claude configuration" on, a repository's `.claude/settings.json` can carry hooks;
  overnight approves plan and graph changes by default; a trial's code can read the hidden evaluator at
  evaluation time; bare `git` is resolved by the system's search.

## 0.7: execution security (trust, provenance, interpreters, package scripts)

Before 0.7 the classifier saw only the first word of `powershell foo.ps1`, `python foo.py`, `node foo.js` or
`pnpm test`. An agent could write a file and run it. 0.7 looks through the interpreter at what will run and
judges that. This is static inspection, a defence layer: it makes the obvious and the careless visible and
gateable. It is not a sandbox, and nothing below should be read as one (see "Not a full OS sandbox").

The code is in `src/main/modules/policies/`: `execution-policy.ts` (the decision), `interpreters.ts`,
`package-scripts.ts`, `content-inspector.ts`, `provenance.ts`, `capabilities.ts`, `security-log.ts`; shared
vocabulary in `src/shared/security.ts`. It runs inside `createAuthorizer` after the 0.2 command classifier and
can only make a decision stricter, never weaker.

### Trust model

Every judged thing gets one of five classifications (shown in the decision log):

| Classification | Meaning |
|---|---|
| `TRUSTED_NEXUS_INTERNAL` | NEXUS's own commands (its git calls, its verification runner). They do not pass through the agent authorizer. |
| `TRUSTED_PROJECT_COMMAND` | A command you configured: a run check command, a "safe command prefix", a project script in the profile, as long as the script text is unchanged from the base commit. |
| `UNTRUSTED_AGENT_AUTHORED` | A file, script body or inline code an agent wrote or changed. |
| `UNTRUSTED_REPOSITORY_CODE` | Code in the repository's base commit, unchanged. Written by someone else; inspected like everything else, but not assumed hostile. |
| `SYSTEM_SENSITIVE` | Touches the machine or NEXUS: power, registry, services, scheduled tasks, credentials, security tooling, NEXUS's database. |

### Execution provenance

A file counts as agent-authored when either source says so:

1. **Recorded writes.** `Write`, `Edit` and `NotebookEdit` calls, and the targets of shell redirections and the
   common file-writing commands (`Out-File`, `Set-Content`, `Add-Content`, `tee`, `New-Item`, `cp`, `mv` ...) that
   the classifier sees. Each record keeps path, sha256 (when the content was known), creating and modifying agent,
   task, run, time, worktree and trust. They are kept in memory and in the `file_provenance` table, so they
   survive a restart.
2. **Difference from the run's base commit.** The file is compared with `git show <base>:<path>` (line endings
   normalised). New or different means agent-authored or agent-modified. This survives restarts and also catches
   files that a program an agent ran produced, which no tool call announced. The comparison is against the
   run's base commit, not the task worktree's, so what an earlier task merged is still "changed by an agent".
   `node_modules` is treated as installed dependency code unless a write there was recorded.

A tool call's record is made when the call is authorised, before it runs.

### Interpreter policy

Interpreters are recognised by resolved executable name, so `.exe` suffixes, full paths, case and trailing dots
do not matter: `powershell`, `pwsh` and any variant of them (`pwsh-preview`, `powershell7`, `pwsh_lts` ...),
`cmd`, `python`, `python3`, `python3.x`, `py`, `node`, `bash`, `sh` (and zsh, dash, ksh, fish), `wscript`,
`cscript`, `mshta`, `deno`, `bun`, `tsx`, `ts-node`, `ruby`, `perl`, `php`, `lua`, `Rscript`, `tclsh`, `groovy`,
`julia`, `java`, `go`, `dotnet`, `wsl`. A script run directly (`.\build.cmd`, `./run.sh`, `tools\gen.ps1`),
`source x.sh`, `Import-Module x.psm1`, `Start-Process powershell -ArgumentList '-File','x.ps1'`, `cd dir && node
x.js`, `npx tsx x.ts` and `node -r ./pre.js x.js` are resolved the same way.

Words are read the way Windows reads them before they are judged: quotes removed, trailing dots and spaces
dropped (`evil.cmd.`), an alternate data stream suffix removed (`evil.cmd::$DATA`, `evil.ps1:zone`), and a
missing extension resolved through PATHEXT against the worktree (`.\evil2` is `evil2.bat`; `cmd /c foo` is
`foo.cmd`). There is also a general rule for launchers NEXUS has no model of (`explorer`, `Invoke-Item`,
`Start-Job -FilePath`, `forfiles /c`, `git bisect run`, `git rebase --exec`, `mystery-tool x`): any argument that
names an existing script or executable file inside the worktree is evaluated like a script reference, and an
executable-type file (`.cmd .bat .ps1 .exe .vbs .sh ...`) that an agent wrote or changed and passed to such a
launcher always needs approval, because NEXUS cannot know what the launcher does with it. Arguments of commands
that only read, search, format or copy files (`git`, `rg`, `cat`, `eslint`, `vitest`, `cp` ...) are not treated
as launches, so `git add foo.cmd` and `eslint foo.js` are unaffected. An unrecognised program given inline-code
looking flags (`-c`, `-e`, `-Command`, `/c`) has that text inspected, and RESTRICTED asks.

The whole text of every shell tool call is also inspected, minus the same exemptions the classifier makes (git
commit messages, inert heredocs) and minus commands that only print or search their arguments (`echo`, `rg`,
`grep`, `git`, `cat` ...): a power command with no recognised wrapper around it (`[scriptblock]::Create('shutdown
/s').Invoke()`) is `DENY`, and the other system-sensitive categories below get their usual outcome.

| What is run | STANDARD | RESTRICTED |
|---|---|---|
| Version probe, interactive start, `python -m pytest` and the like | allowed | allowed |
| A script unchanged from the base commit, clean | allowed (not logged) | allowed |
| A script an agent wrote or changed, clean | `ALLOW_WITH_AUDIT` (allowed, logged) | `REQUIRE_APPROVAL` |
| Any script containing a finding below | per finding | per finding (dangerous ones become `DENY`) |
| Inline code (`python -c`, `node -e`, `deno eval`, `perl -e` ...) | inspected; clean is `ALLOW_WITH_AUDIT`; one that starts processes needs approval | `DENY` |
| `powershell -Command`, `cmd /c`, `/k`, `bash -c` payload | its commands are judged as if typed directly | `DENY` |
| `-EncodedCommand` | decoded (UTF-16LE base64) and inspected; power inside is `DENY`; otherwise always approval | `DENY` |
| Program text from standard input (`python -`, `bash -s`, `powershell -Command -`, a pipe or heredoc into a bare interpreter) | a heredoc or `echo`/`printf` pipe is inspected with the command and logged; `< file` judges the file; anything else asks | `DENY` |
| `java Foo.java`, `go run x.go`, `dotnet script x.csx` | the named source file is read and judged like a script | same, agent-written files need approval |
| A binary or compiled program an agent produced | approval (cannot be inspected) | approval |
| A script outside the worktree, a path computed at run time, `wscript`/`mshta` | approval | approval |
| A script too large to inspect (over 2 MB; 1 MB for the pattern scan), or one that references more than 10 files to follow | approval | approval |

The table is the 0.7 layer's own result. The 0.2 classifier still asks first when a shell is started on a script
file (`powershell -File x.ps1`, `bash x.sh`), whatever the file contains; the stricter of the two wins.

Libraries a script loads are followed one level at a time (relative `require`/`import`, Python sibling imports,
dot-sourced PowerShell, other scripts a shell script calls, up to 40 files): an unchanged entry point that loads
an agent-written module is judged by that module. When a script references more than 10 relative files, only 10
are followed and the call needs approval rather than being passed with the rest unread. Large files inside
`node_modules` that are not recorded as written by an agent (a bundled `tsc.js`) are installed dependency code and
are not read.

### Package-manager indirection

For `npm`, `pnpm`, `yarn`, `bun` run and the lifecycle (`test`, `start`, `install`/`ci`/`add` and their
`pre`/`post` hooks, `preinstall`, `install`, `postinstall`, `prepare` ...), `npx`, `pnpm exec`/`dlx`, `npm
create`: the script text is read from `package.json` (in the working directory, `--prefix`/`--dir`, or every
workspace package for `-r`/`--filter`), compared with the base commit's `package.json` script by script (the one
named and its hooks), and the body is judged recursively. The body may call an interpreter, a script file or
another package script. An unchanged project script stays usable; a changed one is `ALLOW_WITH_AUDIT` when
clean (`REQUIRE_APPROVAL` in RESTRICTED, and for roles without `WRITE_WORKTREE`) and is refused or put to you
when it contains a finding. A package that is not installed locally and would be downloaded (`npx x`, `dlx`,
`create`) needs approval; known developer tools (vitest, tsc, eslint, ...) do not.

The sub-command is found with a known list of flags. A flag the parser does not know (`--otp 1`,
`--use-node-version 20`) may or may not take the next word, so the sub-command is found by scanning for a known
one (`run`, `test`, `install` ...); when none can be found the call needs approval (`pnpm --new-flag x lint`).
Unknown flags after the script name belong to the script and are ignored (`pnpm lint --fix`).

`--script-shell`, `script-shell` in a config file, `npm config set script-shell` and an `npm_config_script_shell`
environment prefix name a program every script runs through: that file is read and judged as a script and the
call needs approval. Any other `npm_config_*`, `pnpm_config_*`, `yarn_*` or `bun_config_*` environment setting on
a command line needs approval. A package-manager configuration file (`.npmrc`, `.pnpmfile.cjs`, `.yarnrc.yml`,
`.yarnrc`, `bunfig.toml`) that an agent wrote or changed makes the next package-manager run need approval (and
the files it points at, such as `yarnPath` and plugin paths, and a `.pnpmfile`, are judged as scripts and refused
when they contain a power command). An unchanged `.npmrc` whose `script-shell` names a file in the worktree has
that file judged too.

### What inspection looks for

| Finding | Result |
|---|---|
| Power: `shutdown`, `Stop-Computer`, `Restart-Computer`, `ExitWindowsEx`/`SHExitWindowsEx`, any `InitiateSystemShutdown*`/`InitiateShutdown*` spelling (`...ExW`), `NtShutdownSystem`, `NtSetSystemPowerState`, `SetSystemPowerState`, `rundll32` with a `powrprof` export or a power export of user32/shell32/advapi32, `psshutdown`, `wmic os ... shutdown`, `.Shutdown()`/`.Reboot()`/`.Win32Shutdown()` on a WMI/CIM operating-system object, `logoff`, `tsdiscon`, `rwinsta`, `reset session`, `WTSShutdownSystem`/`WTSLogoffSession`/`NtRaiseHardError`, `nircmd exitwin`, `init 0|6`, `shutdown -l`, `shutdown/s` and the other forms in which cmd.exe ends a command name at `/`, `,`, `=`, `;` or a quote (`shutdown.exe/r/t 0`, `shutdown"/s"`, `call shutdown/s`), `.InvokeMethod('Reboot')`, `where shutdown`/`Get-Command shutdown`, `systemctl poweroff`, a power word next to a process-starting API (including `ctypes`, `Add-Type`, `[scriptblock]::Create`), in any wrapper or after quote/caret splitting | `DENY`, in both profiles, never approvable |
| Security tooling (`Set-MpPreference`, `netsh advfirewall`, `bcdedit`, `Set-ExecutionPolicy`), Claude credential stores, NEXUS's database, key files and runtime endpoint (see below) | `DENY` |
| Registry writes, services (`sc`, `New-Service`), scheduled tasks (`schtasks`, `Register-ScheduledTask`), `setx` and machine/user environment changes, system package installs (`winget`, `choco`, `msiexec`, `npm -g`) | approval (RESTRICTED: `DENY`) |
| Credential locations (`.ssh`, `.aws`, `cmdkey`, `vaultcmd`, Credential Manager, browser profiles) | approval |
| Destructive filesystem (`rm -rf /`, `Remove-Item -Recurse` on a root or home, `format`, `diskpart`) | approval |
| Download and execute (`iwr \| iex`, `curl \| sh`) | approval |
| Encoded or assembled commands (`-EncodedCommand`, `$env:x + ...`, `%a%%b%`, `!a!` delayed expansion in command position, `& ($a+$b)`, decode-then-eval) | approval |
| Starting processes (`child_process`, `subprocess`, `os.system`, `Start-Process`, `Invoke-Expression`, `WScript.Shell`), nested shells, network calls | logged; approval for inline code; RESTRICTED turns network use into `DENY` unless web tools are allowed |

`shutdown` as an identifier in program code (`gracefulShutdown()`, `server.shutdown()`) is not a power command.
The power patterns have one source (`power-patterns.ts`) that both the command classifier and the content
inspector use, and the classifier's per-word name match applies the same cmd.exe rule (`cmdCommandName`: a name ends
at `/`, `,`, `=`, `;` or a quote when a short switch follows, so `shutdown/index.ts` is not a power command).
`cmd /c call file` runs any file as a batch whatever its extension, so a `call` of a file that is not named like a
script is judged as a script and needs approval. `regsvr32` (a DLL or a remote scriptlet with `/i:http://...`) asks.

### NEXUS's runtime endpoint

NEXUS's own database, overnight key and runtime endpoint are refused to agents: `nexus.db`, `overnight.key`,
`runtime\endpoint.json`, the `runtime` directory under the NEXUS data directory, `runtime.log`, the named pipe
`\\.\pipe\nexus-runtime-*` (connecting to it, reading it, or listing pipes with a nexus filter), and the data
directory spelled `%APPDATA%\NEXUS`, `%LOCALAPPDATA%\NEXUS`, `$env:APPDATA\NEXUS` or `${env:APPDATA}\NEXUS`. The
refusal applies in shell command text (the classifier and the whole-text inspection), in scripts and inline code
(the content inspector), and in the paths and patterns of `Read`, `Write`, `Edit`, `Grep` and `Glob`. A worktree
below the data directory is not NEXUS data. This is a deny-list for obvious access. Code that NEXUS allows to run
can still read that file: it is the same user, and a program can compute the path or read it in a way no pattern
sees. That is why operating-system isolation is a requirement for 0.8, not an improvement.

Codex sessions are not covered by any of this per tool call. NEXUS does not authorise their tool calls
(`codex-runtime.ts`): the boundary is the Codex CLI's own read-only sandbox (`-s read-only`) and NEXUS's after-the-fact
check that the working directory did not change. Power commands from a Codex session are **not verified by NEXUS**.

### The power boundary

Agents never control the operating system's power state. Direct commands, wrappers and the obvious script
wrappers above are `DENY` with no approval path. Only `WindowsPowerController` does power, and the Overnight
supervisor is its only caller in the main process (plus the runtime process's composition code). A test scans the
agent path (`policies`, `agent-runtime`, `orchestrator`, `providers`, `context`, `git`, ...) and the IPC handlers
and fails if any imports the power controller. This is a boundary in NEXUS's code. It does not stop a program an
agent runs from calling `shutdown.exe` by a route NEXUS did not see (next section).

### Capabilities

`READ_PROJECT`, `WRITE_WORKTREE`, `GIT_LOCAL`, `RUN_TESTS`, `RUN_BUILD`, `NETWORK`, `PACKAGE_INSTALL`,
`INTERPRETER_EXEC`, `SYSTEM_CHANGE`.

| Role | Capabilities |
|---|---|
| `worker`, `debugger` | all but `SYSTEM_CHANGE` (`NETWORK` is withdrawn in RESTRICTED unless web tools are allowed) |
| `reviewer`, `verifier` | `READ_PROJECT`, `RUN_TESTS`, `RUN_BUILD`, `PACKAGE_INSTALL`, `INTERPRETER_EXEC`; no `WRITE_WORKTREE`, so agent-authored scripts need approval for them even when clean |
| `planner`, `architect`, `researcher`, `security_reviewer` | `READ_PROJECT` (plus `NETWORK` when web tools are allowed); no interpreter runs |

`SYSTEM_CHANGE` is granted to no role. The decision consults the set: a role without `INTERPRETER_EXEC` cannot
run an interpreter, one without `PACKAGE_INSTALL` cannot install, one without `NETWORK` cannot fetch a package.

### Execution profile (Settings, Execution)

`settings.execution.profile`, `STANDARD` (default) or `RESTRICTED`. Old stored settings read as `STANDARD`.

- **STANDARD** keeps developer flows: project tests and builds run, unchanged scripts run, the hardening and the
  audit trail above apply.
- **RESTRICTED** refuses inline interpreter code, nested-shell payloads and programs read from standard input,
  requires approval for any script an agent wrote and for any package script an agent changed (and refuses
  dangerous ones), refuses network use unless web tools are allowed, asks before every install, and asks when a
  package script cannot be compared with the base commit. Its filesystem narrowing is exactly this: the `Read`,
  `Glob` and `Grep` tools may read the worktree and read roots you added but not the project root, and the shell
  scope of roles that cannot write (reviewer, verifier, planner ...) is the worktree plus those read roots. For
  roles that write, the shell scope is the worktree in both profiles, so RESTRICTED does not narrow what a
  writing agent's shell commands may name; it only asks or refuses more of what it can see.

Neither profile is a sandbox. RESTRICTED makes NEXUS ask more and refuse more of what it can see; it does not
stop a program from doing what the program does.

### Filesystem boundary (0.7 additions)

Paths are compared canonically (resolved through links and 8.3 names, case-insensitively), never by string
prefix. New in 0.7: drive-relative paths (`C:foo`) and Windows device names (`CON`, `NUL`, `COM1`, `aux.txt`)
are refused; and a shell word that is relative and has no `..` but resolves outside the worktree through an
existing junction or symlink (`cat link\secret.txt`) now asks, where it used to pass. Covered by tests with real
junctions: `..` traversal, junction and symlink escape, UNC (`\\server\share`, `\\?\UNC\`), device (`\\.\`),
extended-length (`\\?\C:\`) spellings, alternate data streams (`file::$DATA`, `file:stream`,
`.git::$INDEX_ALLOCATION`), alternate casing, trailing dots and spaces, 8.3 short names (`GIT~1`), a sibling
directory that shares a name prefix, `.git` pointer rewriting and nested-repository metadata. `src\..\x` is
resolved lexically, as Windows does. A link that is created or retargeted after the check is not seen (see below).

### Shell paths with variables

In a write position (a redirect target, `dd of=`, the path of `Set-Content`/`Out-File`/`Copy-Item`/`Move-Item`/`New-Item`/`cp`/
`mv`/`rm` ..., the path argument of `[IO.File]::Write*`/`Copy`/`Move`/`Delete`, `[IO.Directory]::*`, `StreamWriter`)
a word with a variable is expanded where that can be done statically (`$PWD`, `.`, the home directory, TEMP, and
literals assigned in the same command such as `$f = 'src\x.ts'`) and then checked like any other path. A word that
stays unknown (any other variable, `$(...)`, a backtick, `$PROFILE`, `$PSScriptRoot`, a provider prefix such as
`FileSystem::` or `Registry::`) asks. Reads with an unexpanded variable keep today's behaviour in both profiles.
Content arguments (`Set-Content a.txt "total $total"`) are not paths and are not affected.

### Git commands that write shared state

A linked worktree shares its repository's configuration, remotes, refs, notes and object store with the user's
original repository, so a command that writes them changes the user's repository. These ask for every role: any
`git config` write (set, unset, add, rename/remove-section, edit; `--worktree` is not shared and stays allowed),
`git remote add|remove|rename|set-url|set-head|prune`, `git branch -m|-M|-c|-C|-u|--set-upstream-to|--unset-upstream|
--edit-description`, `git notes add|append|edit|copy|merge|remove|prune`, `git replace`, `git gc`, `repack`,
`pack-refs`, `commit-graph`, `maintenance`, `reflog expire|delete`, `lfs install|uninstall|update|migrate|track`,
`daemon`, `instaweb`, `difftool`, `mergetool`, `hook`, `submodule add|update|init|sync|foreach|deinit` and `worktree
lock|unlock|repair`. Reads stay allowed: `git config --get|--list`, `git config <key>`, `git remote -v`, `git branch
--list|--show-current|-vv`, `git notes list|show`, `git worktree list`, and the everyday commit/diff/log/status/add/
restore/stash/switch/merge/cherry-pick commands. Nothing the role prompts tell agents to run is affected: NEXUS sets
the commit identity itself, so an agent has no reason to run `git config user.*`.

### The security decision log

Every refusal, approval request and `ALLOW_WITH_AUDIT` is written to `security_decisions` (migration 011):
timestamp, run, task, agent, a redacted one-line action (the same summary the activity feed uses, with values
after secret-looking names, `--password`/`--token` options, `curl -u user:pass`, `sshpass -p`, `mysql -pX`,
authorization and cookie headers, bearer tokens, URL credentials, secret-named query values (`sig=`, `token=`,
`key=`) and long opaque strings replaced; the command is redacted first and only then shortened to 300
characters, so a cut token leaves no fragment), classification,
provenance, decision, reason and the policy version. A plain allow of a read-only call is not stored. The log is
bounded: every 25 inserts the run's rows beyond 2,000 and the table's rows beyond 20,000 are pruned, oldest
first. The renderer reads it through the read-only `security.decisions` channel (optional run id, limit at most
200, cursor) and shows it in the "Why was this blocked?" panel. An approval request is logged as
`REQUIRE_APPROVAL`; whether you then approved is in the approval record, not here.

### Not a full OS sandbox

Can arbitrary agent-authored code still execute a child process outside NEXUS's semantic understanding? **Yes.**
NEXUS reads text and compares it with patterns. Anything that does not reveal itself to that reading runs as
your user with your rights. In particular:

- **A compiled or downloaded binary.** An agent can build `tool.exe` (or `go build`, `cargo build`, `dotnet
  build`) and run it. NEXUS asks about an executable that is new since the base commit and is named in the
  command (by path, through PATHEXT, or as an argument to a launcher), but cannot see what it does, and a build
  step that produces and runs it inside one command is a build, which the project's own scripts do.
- **Compiled-language launchers.** Only the source file named on the command line is read, and only for
  `go run x.go`, `java Foo.java` (source-file mode), `dotnet script x.csx` and the like, and only for the process
  and power patterns. Nothing reads the sources behind `go run .`, `cargo run`, `dotnet run`, `mvn`, `gradle`,
  `make` or a `build.rs`, nor the classes a `java Foo` loads.
- **A dynamically built command.** Code that assembles the command from pieces, reads it from a file, an
  environment variable, a network response or a database, or applies a transformation NEXUS does not know,
  passes the pattern checks. Decode-then-eval and variable-name tricks are flagged where the pattern is
  recognisable; a transformation NEXUS has not seen is not.
- **A test file the legitimate test runner executes.** `pnpm test` is allowed because the project's test script is
  unchanged, but `vitest`, `pytest` and `jest` execute whatever test files are in the tree, including ones an
  agent just wrote, and a test may spawn any process. NEXUS does not read test files. The same holds for build
  configuration (`vite.config.ts`, `jest.config.js`, `conftest.py`, `setup.py`, `build.rs`, `.csproj` targets),
  git hooks, `node_modules` lifecycle scripts of dependencies, native module builds and anything a plugin loads.
- **Modules a script imports that are not relative files**, installed packages an agent modified, `PYTHONPATH`
  and loader hooks.
- **Check then use.** A script is read when the call is authorised and run afterwards. A file or link changed in
  between (by another process, or by a command that runs first in the same line) is not seen. A script created
  by an earlier command in the same line that NEXUS cannot see being created (a `git checkout` of another
  branch, an archive extraction) is put to you for approval only when the line has several parts.
- **Program text in languages NEXUS does not read for commands.** The content patterns are language-neutral
  (process-start names and power names), so Go, Rust, Java and C# files are only as well covered as those names.
- **Unrecognised programs.** A launcher NEXUS has no model of is judged only by the files it names among its
  arguments. A program that reads a script path from somewhere else (a config file, an environment variable, its
  own defaults) is not seen.
- **Codex sessions** are not authorised per tool call (see "NEXUS's runtime endpoint" above).
- **Anything you approve.** An approved call runs with no further inspection.

The controls that are not static inspection: the folder confinement of the file tools (canonical paths), the
refusal to let any agent path reach power control, your approval gate, and the separation of NEXUS's own git
calls from repository configuration. The real fix is an operating-system boundary (a restricted token,
AppContainer, job object, VM or container); NEXUS does not provide one.

## Known gaps

- **No OS sandbox.** Native Windows has none for this design. Agents and everything they launch run as
  your user. A forbidden or gated command is stopped by the classifier, not by the OS.
- **The classifier and the 0.7 inspection are heuristic.** Since 0.7 inline interpreter code, script files an
  agent wrote or changed and package scripts are inspected (see "0.7: execution security"); a clean agent-written
  script is allowed with an audit entry in STANDARD, and a program run this way can read or write anywhere your
  user can. They cannot see compiled programs, commands built at run time, or what a build tool or test runner
  does with files in the tree. Restricted roles are denied commands that are not recognised as read-only,
  verification or install.
- **Writes are only controlled for the file tools.** `Edit` and `Write` are confined to the worktree by
  canonical path. Shell commands rely on the classifier's path checks: a path word that is outside the worktree,
  resolves outside through a junction, or contains a variable that cannot be expanded (`$PROFILE`, `$env:X`,
  `$(...)`, a provider path such as `FileSystem::`) asks when it is in a write position of a command or redirect the
  classifier knows writes, and the .NET file APIs (`[IO.File]::Write*`, `[IO.Directory]::*`, `StreamWriter`) are
  checked the same way. A program that computes the path itself (a script, `node -e`) can still write anywhere
  your user can.
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
