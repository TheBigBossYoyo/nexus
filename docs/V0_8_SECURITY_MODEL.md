# NEXUS 0.8: security model

Status of this document: written while 0.8 is in development (2026-10-11). It describes what is built and
tested on the branch `nexus-0.8-isolation-autonomy`, names what is designed and not built, and states what
neither stops. Where a statement rests on a test, the test is named. Earlier documents (`SECURITY.md`,
`WINDOWS_EXECUTION_ISOLATION.md`, `V0_8_PROPOSAL.md`) describe 0.7 and the plan; where they and this one
differ, this one is the later.

## The claim, and its limits

Before 0.8 the boundary around an agent was a reading of its commands: a classifier, an inspection of scripts,
and a question to the user. Code that did not reveal itself to that reading ran as the user.

In 0.8 the boundary for an enrolled project is the operating system. What an agent runs, and what NEXUS runs on
its behalf, is started by one program (`nexus-launch.exe`) inside a job object, under a token with no
privileges at low integrity, and, in the stronger profile, as a different Windows account. The reading of
commands is still there. It decides which capability a command needs; it is no longer what keeps the command in.

The target statement is: *untrusted code may destroy its disposable worktree and its own process tree, but
cannot modify NEXUS, provider credentials, unrelated repositories, unrelated user data, or the runtime.* How far
each profile goes towards it is in the table below. The statement holds in full only for ISOLATED, and with the
exceptions listed under "What is not contained".

## Components and trust

| Component | Runs as | Trusted | Why |
|---|---|---|---|
| Runtime (`--nexus-runtime`) | the user, medium integrity | yes | owns the database, the engines, the pipe, the capability broker |
| Window (desktop) | the user, medium | yes | shows state, sends the user's decisions |
| Worker process | the user, medium | yes | hosts one provider session; decides nothing itself (`authorize` is a call to the runtime) |
| Provider process (`claude.exe`, `codex`) | the user, medium | as a provider adapter | holds the provider login; its file tools are held to the worktree by the authorizer; its shell tool is handed a contained launch, never the agent's command |
| `nexus-launch.exe` | the user, medium | yes | the only place a containment is made; 400 lines, one file, no network |
| Research fetch, filtering proxy | inside the runtime | yes | NEXUS's own code under a network policy |
| Agent-run commands, project scripts, tests, install hooks, the application under test | the sandbox account or the user, **low integrity, in a job** | **no** | repository code, agent-written code, dependencies |
| Web pages, search results, downloads, tool results from outside | data | **no** | read, screened, attributed; never an instruction |

A model is not a component of the boundary. A Director, the Task Compiler, a planner and a worker are all
callers of the capability broker; none of them can write a grant, a profile or a policy (see "Authority").

## Execution profiles

Chosen in Settings (`execution.containment`), for enrolled projects. A project that is not enrolled is not
contained at all: it has the behaviour of 0.7, approvals included.

| | ISOLATED | RESTRICTED | STANDARD |
|---|---|---|---|
| Identity | the machine's sandbox account (`NexusSandbox`) | the user | the user |
| Integrity | low | low | medium |
| Job object (kill on close, no breakaway, process limit, UI limits) | yes | yes | no |
| Privileges | none but traverse | none but traverse | the user's |
| Writes | its session directories and the worktree, in the sandbox root | directories NEXUS labeled low: the worktree, its temp, home and cache | anywhere the user can write |
| Reads of the user's profile | **none** (another account) | everything except what NEXUS marked protected | everything |
| Credential Manager, DPAPI, HKCU of the user | **not reachable** (its own, empty) | reachable | reachable |
| Network | **loopback only**; Windows Firewall blocks the account in and out; the way out is NEXUS's proxy | the user's | the user's |
| Environment | an allowlist; own HOME, TEMP, caches | the same | the same allowlist is not applied to STANDARD agent sessions |
| Needs | one elevated setup per machine | nothing | nothing |
| Verified at each start by | running a contained command and checking five things | running one and checking three | nothing to verify |

`STRONGEST` (the default) means ISOLATED when the sandbox account is set up and was verified at this start,
otherwise RESTRICTED. It never means STANDARD.

**No fallback.** A profile that was asked for and cannot be made runs nothing. The authorizer refuses the command
("Nothing is run outside the containment in this project"), the runtime records an `ISOLATION_FAILURE`, and one
notification is raised. Test: `tests/scenarios/v8-containment.test.ts`, "with the launcher gone, nothing is run".

### How a command is contained

1. The authorizer decides that the command may run (policy, then capability broker).
2. The execution broker writes the command to a script in the session's temporary directory, builds the
   environment from the allowlist, and writes a spec file (profile, working directory, command line, the whole
   environment, limits) in a directory of NEXUS's own.
3. The provider's shell tool is handed `nexus-launch.exe --spec <file>` in place of the agent's text
   (`PreToolUse` hook, `updatedInput`). The agent's command never reaches a shell uncontained.
4. The launcher creates the job, creates the token, starts the process **suspended**, assigns it to the job,
   verifies the assignment, and only then resumes it. Under ISOLATED it first logs the sandbox account on
   (`CreateProcessWithLogonW`) and starts its own copy as that account inside the job; the copy lowers its own
   token to low integrity and starts the command.
5. When the command ends, the launcher terminates the job: nothing the command started survives it. When the
   launcher itself dies, the job handle closes and the kernel does the same.

NEXUS's own project commands (the dependency setup in a fresh worktree, the check commands) take the same path
(`ExecutionBroker.runProjectCommand`). They are project code: an install hook, a test.

### What was tested against Windows

`tests/integration/isolation/containment.test.ts` (22 tests, each profile; ISOLATED runs when the account
exists) runs harmless hostile programs and asserts what Windows did:

- writes outside the worktree refused eleven ways: a sibling directory, the user's profile, the Windows
  directory, the parent, through `cmd`, through PowerShell, through a junction, to `HKCU`;
- a protected file unreadable seven ways: read, list, stat, copy, `type`, hard link, alternate stream;
- a detached grandchild ends with the command; a fork loop stops at the process limit; a time limit ends the tree;
- the environment holds none of the planted secrets, and HOME is not the user's;
- under ISOLATED: the process is another account at low integrity; nothing in the user's profile can be read
  or listed (`.claude`, `.ssh`, `%APPDATA%`, this repository); no TCP, HTTP, DNS or UDP answer from outside;
  the loopback works; the account's credential vault is empty;
- under RESTRICTED, stated as a test so that nobody claims otherwise: an unprotected file of the user **is**
  read, and the network **is** reached.

## Filesystem

| Place | ISOLATED | RESTRICTED |
|---|---|---|
| Task worktree | read, write (in `C:\ProgramData\NexusSandbox\worktrees\…`) | read, write (labeled low) |
| Session temp, home, project cache | read, write | read, write |
| Tool copies (Node, the MSYS runtime of Git) | read | read (labeled medium explicitly) |
| System directories, Program Files | read | read |
| NEXUS data directory (`%APPDATA%\nexus`: database, endpoint and token, credentials, logs) | no access | no read, no write (labeled protected) |
| `~/.claude`, `~/.codex`, `~/.ssh`, `~/.aws`, `~/.azure`, `~/.gnupg`, `~/.docker`, `~/.config/gh`, `.npmrc`, `.netrc`, `.git-credentials` | no access | no read, no write (labeled protected) |
| Browser profiles, Documents, Desktop, Downloads, other repositories | no access | **read**; no write |
| The enrolled project's own repository | no access; git commands run as the user at low integrity (below) | read; no write except the parts below |

**Labels.** "Protected" is a mandatory integrity label on the directory (medium, no-read-up, no-write-up,
no-execute-up, inherited). Only the label is set; the owner and the access list are untouched; `nexus-launch
label clear` removes it. The list above is what the user approved for this machine on 2026-10-11. Browser
profiles and personal folders are not on it, and are named in "What is not contained".

**Git.** A linked worktree keeps its data in the user's repository. A command that is `git` and nothing else,
with no finding of the classifier, runs as the user at low integrity even in an ISOLATED session, with hooks,
the file-system monitor, the pager, the editor, the external diff and the `ext` transport switched off in its
environment (which outranks the repository's configuration). To let it commit, NEXUS labels low exactly: the
worktree's own entry (`.git/worktrees/<name>`), the object store, and the directory of the task's branch among
the refs and their logs. The paths come from NEXUS's record of the worktree, never from the `.git` file an agent
can rewrite. The user's branches, tags, configuration and hooks stay medium: a contained git cannot write them
(`v8-containment.test.ts`, "commits on its own branch"). The object store is writable by contained code, so an
object can be added or damaged; NEXUS's own git (trusted, medium) does the merging.

**Junctions and links.** A low-integrity process cannot create a junction or a symbolic link to a directory it
cannot write (tested); a link that exists is followed by Windows with the caller's own rights, so it gives
nothing the caller did not have.

## Processes

Every contained process tree is one job object: kill on close, no breakaway, an active-process limit (512 by
default), optional job memory, die on unhandled exception, and the UI restrictions (no desktop switching, no
display or system-parameter changes, no `ExitWindows`, no global atoms, no handles of other processes' windows,
no clipboard). A contained process at low integrity cannot open a medium process of the user for reading
(probe D3) and cannot send input to a medium window.

**Error dialogs.** The launcher sets the process error mode before creating anything, so a program that cannot
start under a restricted identity fails with a code. (During the probes a .NET test target raised a dialog on
the user's screen; that is where this rule comes from.)

## Runtime pipe and credentials

- The runtime's pipe needs a token that is in `<data dir>/runtime/endpoint.json`. Under ISOLATED the file is in
  another account's profile. Under RESTRICTED the data directory is labeled protected. Either way contained code
  cannot read the token.
- Independently, a low-integrity process cannot open the pipe for writing (the pipe's default label refuses
  write-up), and the handshake needs a write. Probe 6.
- NOT YET BUILT: an explicit DACL on the pipe (user SID only) with a no-read-up label, and per-kind dispatch
  (`desktop` and `tool` clients may call the same channels today). The two points above do not depend on it.
- Provider credentials: the Claude login is the provider's own file under `~/.claude` (protected or
  unreachable); the ChatGPT tokens are a DPAPI blob in the data directory (the same). No credential is put in
  the environment of a contained process: the environment is an allowlist (`process/contained-env.ts`), tested
  with sentinels in every place a secret is known to sit.
- The sandbox account's password is generated at setup, stored as a DPAPI blob only the user can open, read by
  the launcher at the moment of the logon, and never printed, logged or put on a command line.

## Network

| Traffic | Policy | Enforced by |
|---|---|---|
| Research (search, read, download) | public addresses only, http and https, ports 80 and 443, GET only, no cookie, no credential, budgets per mission | NEXUS's own fetch (`network/fetch.ts`): the name is resolved once, every answer is checked, and the socket connects to the address that was checked; every redirect is judged again |
| A research or application browser | by purpose: PUBLIC_RESEARCH reaches the public Internet and nothing local; LOCAL_APP_TEST reaches the registered endpoints of the project and nothing public | the filtering proxy (`network/proxy.ts`), which the browser has no way around; NOT YET WIRED to a browser |
| Project code installing dependencies | the approved package registries | the same proxy with the registry policy. **Under ISOLATED it is the only network the code has** (firewall). Under RESTRICTED it is advice: the code can open any socket |
| Project code otherwise | none, under ISOLATED | Windows Firewall rule on the sandbox account, both directions |

Addresses refused to a public session: every range of `docs/UNTRUSTED_CONTENT_SECURITY.md` 4.4, IPv4 and IPv6,
including mapped, NAT64, 6to4 and Teredo forms, in every spelling a URL allows (`tests/unit/network`). Rebinding,
a redirect to the local host, the LAN, the metadata address or `file:`, a name that answers differently the
second time: `tests/integration/network`.

## Authority

1. What the user said, and the policy the user confirmed (a profile, a grant).
2. NEXUS's deterministic security policy (this document).
3. The compiled task specification.
4. Director and worker instructions.
5. Verified project facts.
6. Repository, web and tool content.

Nothing at a lower level changes anything at a higher one. Concretely: a grant row can be created by the
broker's `resolve` only, which only the window's `autonomy.resolve` channel calls; an enrollment and a grant for
a whole project are confirmed by a native dialog the runtime itself shows; a capability of kind NEVER has no
scope that could be granted (`allowedScopes` returns none). Research text reaches a model inside a block whose
marker was made for that one result, after instruction-like passages and markup-hidden text were taken out; a
page that is not caught by that screening has gained a reader and nothing else, because the session's
capabilities do not depend on what it reads (`tests/scenarios/v8-research.test.ts`).

## What is not contained

Stated plainly, by profile.

**ISOLATED**
- Loopback. Windows Firewall does not filter it, so contained code can reach any service listening on
  `127.0.0.1` on the machine (a local database, another development server), not only NEXUS's proxy.
- Whatever every local account may read: Program Files, `C:\ProgramData` where it is open, `C:\Users\Public`,
  world-readable files on other drives.
- The project itself. Contained code can read and destroy its worktree, and can send it anywhere its allowed
  network reaches: to a package registry, in the form of a request.
- A kernel or service vulnerability, and anything an administrator's process does.
- Other tasks of the same machine under the same account: two ISOLATED sessions are the same Windows identity.
  They have separate session directories; nothing but convention keeps one out of the other's.
- The object store of the enrolled repository (see Git).

**RESTRICTED** (all of the above, and)
- The network, entirely.
- The user's Credential Manager, DPAPI and `HKCU` (read).
- Every file of the user that is not on the protected list: browser profiles, documents, other repositories.
- The clipboard is blocked by the job; a window of the same integrity is not protected from it.

**STANDARD**: nothing is contained.

**Both contained profiles**: the provider's own process is not contained. Its file tools are confined by the
authorizer (canonical paths), as in 0.7. Codex sessions rely on Codex's own read-only sandbox, as in 0.7.

## Not yet built (2026-10-11)

Browser sessions and application automation (the proxy and policies exist; no browser uses them yet); the
pipe's explicit DACL and per-kind dispatch; the hostile repository corpus as a permanent suite beyond the
containment tests; fault injection; the isolation and research panels in the UI; removal of the protected
labels when the last project is unenrolled. The release report will say which of these exist at the end.
