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
| `nexus-launch.exe` | the user, medium | yes | the only place a containment is made; one file of about 630 lines, no network |
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
| Network | **loopback only** for its own traffic; Windows Firewall blocks the account in and out; the way out is NEXUS's proxy. A name it asks Windows to look up is answered all the same (see "What is not contained") | the user's | the user's |
| Environment | an allowlist; own HOME, TEMP, caches | the same | the same allowlist is not applied to STANDARD agent sessions |
| Needs | one elevated setup per machine | nothing | nothing |
| Verified at each start by | running a contained command and checking what it could and could not do; the check for a route to the Internet first needs the account to reach NEXUS on the loopback, and if it cannot the answer is "could not be established", not "no route" | running one and checking three | nothing to verify |

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
4. The launcher creates the job, makes a desktop of its own for the command, creates the token, starts the
   process **suspended** with a list of the three standard handles as the only ones it inherits, assigns it to
   the job, verifies the assignment, and only then resumes it. Under ISOLATED it first checks that the stored
   account is the one NEXUS verified (by its SID), logs the sandbox account on (`CreateProcessWithLogonW`) and
   starts its own copy as that account inside the job, on the command's desktop. The copy is named after its
   hash and is not started if it no longer is what its name says; NEXUS checks the same before it hands the
   copy over. The copy checks which SID it runs as, lowers its own token to low integrity and starts the
   command.
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
- every command runs on a desktop the launcher made for it, cannot make a desktop, and inherits no file handle
  of the runtime (`ui-probe.cs`, test "runs on a desktop of its own..."); under ISOLATED it cannot open the
  desktop the user sees ("Default") or the input desktop, so it cannot read the screen; under RESTRICTED it
  can, and the test records that;
- under ISOLATED: the process is another account at low integrity; nothing in the user's profile can be read
  or listed (`.claude`, `.ssh`, `%APPDATA%`, this repository); no TCP, HTTP, DNS packet of its own over UDP, or
  UDP answer from outside; the loopback works; the account's credential vault is empty. A name looked up
  through Windows' resolver (`dns.lookup`) is answered: the test ("has no route to the Internet") records
  that result and does not assert it, and "What is not contained" states it;
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
| The enrolled project's own repository (its `.git`) | read; add objects; write the task's own worktree entry and the refs of its own mission (an access grant, below) | read; no write except the parts below |

**Labels.** "Protected" is a mandatory integrity label on the directory (medium, no-read-up, no-write-up,
no-execute-up, inherited). Only the label is set; the owner and the access list are untouched; `nexus-launch
label clear` removes it. The list above is what the user approved for this machine on 2026-10-11. Browser
profiles and personal folders are not on it, and are named in "What is not contained".

**Git.** A linked worktree keeps its data in the user's repository, which is in the user's profile. Revised
2026-10-11 after the first real acceptance, in which sessions under ISOLATED met "not a git repository" in every
command that was more than git, and reported themselves blocked.

- *Under ISOLATED, the sandbox account is given access to the Git data of the enrolled project* (`icacls`, by
  the user's own right as owner; no elevation): read on `.git`; and in the object store, in the worktree's own
  entry (`.git/worktrees/<name>`) and in the directory of the task's branch and of its log, the right to add
  files and directories and nothing else. Who creates a file may finish it and remove it; nothing that was
  there can be written, deleted, renamed or replaced. Two files are the account's to rewrite: the task's own
  branch (and its log), and the entry's `index`, which it stages into. So an existing object, a sibling task's
  branch, and the entry's `HEAD`, `commondir`, `gitdir` and `config.worktree` stay as NEXUS left them.
  The right to add is inherited by directories only. Measured while fixing the third review, and the reason for
  this form: a right to write that files inherit lets every existing object and branch be overwritten in place;
  and a mandatory label does not keep a file from being replaced (code at low integrity deleted, renamed and
  replaced a file labeled medium in a directory labeled low, through the directory's own rights; only writing
  into the file was refused). `tests/integration/isolation/containment.test.ts` ("it adds and never replaces")
  runs every one of these attempts as the sandbox account. The
  paths come from NEXUS's record of the worktree, never from the `.git` file an agent can rewrite. Each grant is
  on record and is taken back when the project is no longer enrolled. The enrollment confirmation says so.
  With it, `git status`, `log`, `diff`, `show`, `add` work in any contained command, as the sandbox account.
- *A commit cannot be made by that account.* Before git changes a ref it looks at every directory above it, and
  the account can see none of the user's above the repository ("cannot lock ref 'HEAD': unable to create
  directory"). A junction from the sandbox root does not help: git resolves it. Giving the account rights on
  the user's own folders above the repository is not something NEXUS does.
- *So a command that is git alone still runs as the user at low integrity*, in an ISOLATED session too. This is
  the one place where an agent's text decides what runs as the user, so what qualifies is a closed list
  (`policies/git-pipeline.ts`; `tests/unit/policies/git-user.test.ts`), and the text is
  never what runs: it is parsed into git invocations, each a list of arguments, and NEXUS writes the script
  (`renderUserGitScript`), quoting every argument itself:
  - every program is git. Nothing else qualifies: no pipe, no filter program (`git log | head -3` runs as the
    sandbox account), no redirection but `2>&1` and `2>/dev/null`; invocations are joined by `&&`, `||` or `;`;
  - every git names a subcommand from a fixed list as its first word (`status`, `log`, `diff`, `show`, `add`,
    `commit`, `checkout`, `reset`, `stash`, `merge` and the like). Nothing stands between `git` and it: no
    `-c`, `-C`, `--git-dir`, `--exec-path`. `grep`, `rebase`, `config`, `worktree`, `submodule`, the commands
    that reach a remote, and everything unknown (an alias, a program beside git) are not on the list;
  - each subcommand has the options it may take, spelled in full; a shortened spelling is not accepted. Where
    an option's value stands is fixed, because git and the validator must agree on it: a long option takes its
    value after `=` and never as the next word (git reads `--format --output=x` as two options, the second
    of which writes a file); a short option takes the next word; `-U` takes its number attached only (`-U5`);
  - no argument makes git run a program, read or write a file somebody names, or look at another repository
    (`-O`, `--open-files-in-pager`, `--exec`, `-x`, `--output`, `--ext-diff`, `--textconv`, `--no-index`, `-F`,
    `-S`, `--strategy`, `--template`, `--continue`, `--abort`, interactive modes);
  - the shell is given nothing to expand, substitute, redirect or group. The one substitution taken is a commit
    message as a quoted here-document, only as the word right after `-m`, which the shell reads literally.
  Anything else runs as the sandbox account.
  A command written for PowerShell qualifies when it is git invocations joined by `;`, in printable ASCII,
  with nothing PowerShell would expand, and it runs as the same bash script: PowerShell 5.1 re-quotes an
  argument that holds a `"`, so it is never the one that hands arguments to git. A `"` or a `\` anywhere in the
  command, an empty word, or `--%` do not qualify. A command is treated as git alone only when NEXUS has all
  three of the script, the Git directory it recorded for the worktree, and a Git Bash to run the script;
  without the Git directory git would take the repository from the `.git` file the task can rewrite.
  What that git looks at is fixed by NEXUS, not by the worktree: `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE`
  from NEXUS's record (the worktree's `.git` file decides nothing); a home, a temporary directory, an empty
  hooks directory and the command's script in a directory of the user's that the sandbox account cannot write;
  an empty user-level configuration; hooks, the file-system monitor, the pager, the editor, automatic
  housekeeping and the `ext` transport switched off.
  *It changes no branch but the worktree's own.* No command that checks out a branch, makes one or moves one
  qualifies: `checkout` is for files only (`checkout [<revision>] -- <paths>`), `-b`, `-B` and `switch` are
  not on the list (the third review moved a branch of the user's with `checkout -B`). And before every git of
  the script, the script itself looks at three things and runs nothing when one does not hold: the entry's
  `HEAD` names the branch NEXUS made for the worktree; the entry has no configuration of its own
  (`config.worktree`); no directory on the way to a tracked file is a link (Git for Windows writes, deletes
  and reads through a junction; measured). `tests/integration/git/user-git-script.test.ts`.
  These are checks a moment before the use. What makes them more than that under ISOLATED is the access list
  above: the sandbox account cannot replace `HEAD` or `config.worktree` at all. Under RESTRICTED the task's
  code is the user at low integrity, the entry must be writable for its own git, and a label does not stop a
  replacement: there the checks are what there is. It matters for one kind of repository, one that reads
  per-worktree configuration (`extensions.worktreeConfig`, which `git sparse-checkout` switches on): in such a
  repository, under RESTRICTED, code that wins the race between NEXUS's check and git's start could have a
  planted `config.worktree` read by NEXUS's own git. Stated as a limit of RESTRICTED.
  *One command leaves the containment: a push the user allowed.* It runs as the user at the user's own
  integrity, because only there are the network and the sign-in to the remote. It is a `git push` that NEXUS
  writes from the parsed command (the git around it on the same line stays inside the containment), with the remote by name, listed options, no hooks and the recorded Git
  directory (`AUTONOMY_MODEL.md`, "A push you allowed"). It runs only after the capability broker found the
  user's grant for it. What it trusts that the task's code can touch: the commits it pushes (that is the point
  of a push), and, under RESTRICTED in a repository that reads per-worktree configuration, the race stated
  above.
  Four more things were added after the second audit of git (below):
  - *An index of its own in an ISOLATED session.* The index in the worktree's entry is written by the sandbox
    account, and an entry in it can name a file outside the worktree (`../x`, an absolute path); stock git,
    run as the user, then read it out (`git diff`) or wrote it (`git restore .`), both measured. So the user's
    git reads another index, kept where the sandbox account has no access, made from the branch's commit when
    it is not there, and a copy of it is put in the entry after each command so that the task's own read-only
    git sees what was staged. Git itself refuses tree entries that step out (measured during the audit).
    `tests/integration/git/user-git-script.test.ts`, "an index forged in the worktree is not the index the
    command reads".
  - *Nested repositories are not entered.* A repository named in the index is entered by stock git on `add`,
    `rm` and `stash`, under its own configuration, so a filter defined there runs as the user (measured). The
    script computes exclude pathspecs from the index right before each `add` and `rm`; `stash` (other than
    `list` and `drop`) is refused while such an entry exists. Test "a nested repository is never entered..." in
    the same file.
  - *No program stands in for a comparison.* `--ignore-submodules=all`, `--no-ext-diff` and `--no-textconv` are
    put on every `status`, `diff`, `log` and `show`, because a `.gitattributes` in the worktree can select a
    driver that the machine's own git configuration defines.
  - *No LFS download.* `GIT_LFS_SKIP_SMUDGE=1`, for this git and for NEXUS's own: where Git LFS is installed,
    a `.lfsconfig` in the worktree names the address it downloads from (measured: a request to an address the
    worktree named). The stated cost: LFS files stay pointers in NEXUS's worktrees.
  Such a command has the user's network and reads what the user's low-integrity processes read. What it can
  run is git doing one of those things. `tests/scenarios/v8-isolated-git.test.ts` has contained code plant a
  hook, a user-level configuration, the entry's files, a sibling branch and the pointer, then commits: the
  commit is made in the real repository and nothing planted runs.
  The first version of this path took the classifier's "no finding" as "git alone" and was found, by the
  independent review of 2026-10-11, to let `git grep -Ocmd`, `git --exec-path=.` and `git --git-dir=<own
  directory with an alias>` run programs as the user, with the hooks directory, the home and the script in a
  place contained code could write. That version was never released.
- *A ref-changing git inside a larger command* (`npm test && git commit`) is stopped before git, with a sentence
  that says to run it as a command of its own. Nothing is changed.
- The user's branches, tags, configuration and hooks stay out of reach of both: Windows refuses the write
  (`tests/scenarios/v8-isolated-git.test.ts`, `v8-containment.test.ts`).
- NEXUS's own git commands name the worktree's Git directory and, since this revision, the repository's common
  directory themselves (`GIT_COMMON_DIR`): the `commondir` file in a worktree's entry, which contained code can
  write, redirects nothing. They never read the index of a worktree's entry either: NEXUS keeps one of its own,
  built from the branch's commit (`GitService.privateIndexOf`). After the second audit they also leave out of
  `git add -A` the nested repositories the index names, run with `GIT_LFS_SKIP_SMUDGE=1` and `--no-textconv`
  and `--no-ext-diff` on comparisons. The Codex worker process runs no git at all: it asks the runtime for the
  fingerprint of a session's working directory (`workingState`), because a git started in the worker would
  take the repository from the `.git` file the session wrote.
- Under RESTRICTED the worktree's pointer and entry are replaceable, so NEXUS's own git never trusts them
  (`tests/integration/git/worktree-pointer-trust.test.ts`). Every git command of NEXUS in a worktree it created
  passes through `GitService.run`, which holds the entry NEXUS found in the repository when it trusted the
  worktree (by the entry's back-pointer, and only when exactly one entry claims the worktree; after a restart,
  from the repository NEXUS's own record names, never from the worktree). Before each command it checks that
  the `.git` file is a plain file reading exactly `gitdir: <that entry>`, that the entry's `commondir` names
  the repository's `.git` and its `gitdir` names the worktree's `.git`, that no `config.worktree` with content
  exists, and (for commands that add to a branch) that `HEAD` names the task's own branch. On a difference the
  command is refused with a plain message (the git entry of the working tree was changed, and how); NEXUS does
  not repair it and carry on. Independently of that check, the command names `--git-dir`, `--work-tree` and
  `GIT_COMMON_DIR` itself, so the pointer would decide nothing even if the check were absent (measured: a
  pointer to a planted repository with a `core.fsmonitor`, a filter, a diff driver, hooks and `core.sshCommand`
  ran none of them under NEXUS's git, and ran two under stock git).
  A speculative candidate is a clone, with a `.git` directory and a `config` of its own that the task owns and
  that NEXUS holds no record to compare with. Measured before this change: a filter in that `config` ran as the
  user under NEXUS's `git status`/`add`. Now a command in such a directory is refused unless every key of the
  `config` is one git writes into a clone (`core` basics, a remote's address, a branch's upstream, the author);
  a filter, a driver, a program, an `include`, a URL rewrite or `extensions` is refused.
  What remains: the commands NEXUS writes as scripts to run as the user (the allowed push) do their own check,
  described above, and are a moment-before-use check under RESTRICTED. A clone's `config` is checked at each
  command, so the same window between check and start exists there. A directory under NEXUS's worktrees that
  NEXUS has no record of, and whose `.git` is a directory, is checked as a clone is.
- Under RESTRICTED there is no grant: the command is the user, and reads the repository. To let git commit,
  the same three places are labeled low.

Not contained here: the object store can be added to by contained code (never rewritten under ISOLATED; under
RESTRICTED an existing object can be damaged, which git then reports). Reading the worktree's own `.git` entry
is no longer a boundary request; anything below a `.git` directory still is.

**Junctions and links.** A low-integrity process cannot create a junction or a symbolic link to a directory it
cannot write (tested); a link that exists is followed by Windows with the caller's own rights, so it gives
nothing the caller did not have. NEXUS's own git is a different caller: Git for Windows writes a tracked file
through a junction that stands where a tracked directory was (measured, `hostile-index.test.ts`). So before a
command that writes files from commits (`reset`, `merge`, `checkout`, `switch`, `cherry-pick`, `revert`,
`stash`, `restore` and the like) NEXUS removes, as links, every link that stands where a directory of tracked
files is in its index, in the branch's commit and in the commits the command names, without opening what they
lead to (`unlinkTrackedDirectories`). A link made between that check and git's write is not seen. What bounds
that is Windows, which lets code at low integrity make a junction only to a directory it can itself write
(`tests/integration/isolation/containment.test.ts`, the junction test). The user's git, which is stock
git running a script, is not given this step; Windows' rule is what limits it, and the case is recorded and
not asserted in `user-git-script.test.ts` ("a link where a tracked directory was").

## Processes

Every contained process tree is one job object: kill on close, no breakaway, an active-process limit (512 by
default), optional job memory, die on unhandled exception, and the UI restrictions (no desktop switching, no
display or system-parameter changes, no `ExitWindows`, no global atoms, no handles of other processes' windows,
no clipboard). A contained process at low integrity cannot open a medium process of the user for reading
(probe D3) and cannot send input to a medium window.

An application with a window (an Electron application under test) keeps those restrictions except the one on
handles, which a browser engine needs among its own processes. The limit on desktops stays on under both
profiles, because the desktop is made by the launcher's first step, which runs as the user before the job
applies (under ISOLATED the account's process is then started from that desktop).

**Desktops.** Every contained command runs on a desktop the launcher makes for it, not only an application with
a window: on the user's desktop a process can read the screen whatever its integrity (measured by the audit).
The desktop is open to its owner (the user, who makes it), the system and, under ISOLATED, the sandbox account,
and to nobody else; it is labeled low so that the command can use it, and it is not the one on the screen. If
it cannot be made, nothing is started. Under ISOLATED the sandbox account is
also refused the user's desktop by name (every right) and, on the window station, the screen, the clipboard,
making desktops and changing attributes; these deny entries stay for the session. Measured by
`containment.test.ts` with `ui-probe.cs`: under ISOLATED the probe cannot open the input desktop or "Default"
and cannot create a desktop. **Limit:** RESTRICTED runs as the user and can open the user's desktop, so it can
read the screen; the window says so.

*Why no desktop is named to Windows for the account's process, and the residual that follows.* A process
started "as another user" is placed on the desktop of the thread that asks and carries the asking session's
logon identifier, by which it can open named objects of the session that the user's programs created with
default access. Naming a desktop to Windows removes that identifier, and then the account cannot create any
named object in the session at all (Git Bash does not start); both were measured during this work. So the
launcher moves its own thread to the command's desktop and starts the account's process from there, and the
identifier stays. This is a residual of the ISOLATED profile: the account can open named objects that the
user's programs made with default access in the same session. The deny entries above close the desktop and
the screen, which was the measured way to use it.

**Handles.** The command inherits its three standard handles and no other (a handle list), whatever the
launcher itself holds from its parent. The same probe checks that no file handle of the runtime arrives.

**Error dialogs.** The launcher sets the process error mode before creating anything, so a program that cannot
start under a restricted identity fails with a code. (During the probes a .NET test target raised a dialog on
the user's screen; that is where this rule comes from.)

## Runtime pipe and credentials

- The runtime's pipe needs a token that is in `<data dir>/runtime/endpoint.json`. Under ISOLATED the file is in
  another account's profile. Under RESTRICTED the data directory is labeled protected. Either way contained code
  cannot read the token.
- Independently, a low-integrity process cannot open the pipe for writing (the pipe's default label refuses
  write-up), and the handshake needs a write. Probe 6.
- Once the pipe exists the runtime has the launcher protect it (`nexus-launch pipe-protect`): an access list for
  this user and the system only, no inheritance, and a label that refuses read and write from below medium
  integrity. Without a launcher there is no containment, and no project code this would keep out. The launcher
  waits for a free instance of the pipe (40 tries of 250 ms) before it gives up, and the audit measured that the
  pipe's security descriptor applies to every instance of the pipe. `tests/integration/isolation/pipe.test.ts`:
  contained code under both profiles cannot open the pipe, read the token or have a request answered.
- NOT YET BUILT: per-kind dispatch (`desktop` and `tool` clients may call the same channels today). The points
  above do not depend on it.
- Provider credentials: the Claude login is the provider's own file under `~/.claude` (protected or
  unreachable); the ChatGPT tokens are a DPAPI blob in the data directory (the same). No credential is put in
  the environment of a contained process: the environment is an allowlist (`process/contained-env.ts`), tested
  with sentinels in every place a secret is known to sit.
- The sandbox account's password is generated at setup, stored as a DPAPI blob only the user can open, read by
  the launcher at the moment of the logon, and never printed, logged or put on a command line.
- The folder where that blob lives (`%LOCALAPPDATA%\NexusSandbox`) is labeled protected before the setup writes
  the credential, again after the setup, and at every start whatever the record says (a folder that was
  removed and made again has no label, and a record would call it done). After a successful setup from the
  window the account is verified at once and the ISOLATED profile is tried for real, so no restart is needed.
- The account used is the one that was verified: the record of it is read once, when it is verified, and not
  again when it is used. The launcher is given the account's SID, refuses to start a process if the stored name
  is not that SID, and the second step checks which SID it runs as. A sandbox root that failed verification is
  not swept.
- The setup scripts take their cmdlets from Windows' own module folder only (`PSModulePath`; the user's begins
  in the user's documents, and the setup runs elevated). A local group whose members cannot be listed is a
  problem, not "no members" (`sandbox-checks.test.ts`).

## Network

| Traffic | Policy | Enforced by |
|---|---|---|
| Research (search, read, download) | public addresses only, http and https, ports 80 and 443, GET only, no cookie, no credential, budgets per mission | NEXUS's own fetch (`network/fetch.ts`): the name is resolved once, every answer is checked, and the socket connects to the address that was checked; every redirect is judged again |
| A research or application browser | by purpose: PUBLIC_RESEARCH reaches the public Internet and nothing local; LOCAL_APP_TEST reaches the registered endpoints of the project and nothing public | the filtering proxy (`network/proxy.ts`), which the browser has no way around. Wired to the application browser (`APP_BROWSER_AUTOMATION.md`) and to the research browser (`INTERNET_RESEARCH.md`); a research render also has a limit of requests, of bytes and of idle time |
| Project code installing dependencies | the approved package registries | the same proxy with the registry policy. **Under ISOLATED it is the only network the code has of its own** (firewall; the exception is a name looked up through Windows, below). Under RESTRICTED it is advice: the code can open any socket |
| Project code otherwise | none of its own, under ISOLATED, apart from the loopback and the names Windows looks up for it (below) | Windows Firewall rule on the sandbox account, both directions |

**DNS, a stated limit, measured** (`containment.test.ts`, "has no route to the Internet"). The account's own
traffic is blocked: TCP, HTTP and its own DNS packets over UDP are asserted to fail. A name looked up through
Windows' resolver is answered all the same, because the DNS Client service asks on the network and the
firewall rule on the account does not cover a service. So a name that contained code asks for, and whatever
it encodes in the name, can be seen outside, and an answer comes back. Closing this needs a different
containment (an AppContainer or a filtering driver), not an account and a rule. The window and the text of
the start-up verification say it. **Loopback** is not filtered by Windows Firewall: every service that listens
on `127.0.0.1` is reachable by the account, not only NEXUS's proxy.

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
- DNS. A name looked up through Windows' resolver is answered, because the DNS Client service asks and the
  account's firewall rule does not cover a service. The name asked for, and what it encodes, can be seen outside
  (Network, above).
- Named objects of the session that the user's programs created with default access: a process started as
  another user carries the session's logon identifier (Processes, above). The user's desktop and screen are not
  among them; the account is refused both by name.
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
- The user's desktop and so the screen: the command is the user and can open it. The clipboard is blocked by
  the job; a window of the same integrity is not protected from it.

**STANDARD**: nothing is contained.

**Both contained profiles**: the provider's own process is not contained. Its file tools are confined by the
authorizer (canonical paths), as in 0.7. Codex sessions rely on Codex's own read-only sandbox, as in 0.7.

## Independent review (2026-10-11)

A reviewer that had not written the code read it against this document (read-only; report kept with the
session). What it found, and what was done:

| # | Finding | State |
|---|---|---|
| 1 | CRITICAL: an ISOLATED session could run programs as the user through the "git alone" path (git options, aliases through a redirected Git directory; hooks directory, home and script writable by contained code) | Fixed: closed list of subcommands and arguments, pins, user-only directories (Git, above). Regression tests. |
| 2 | HIGH: the access to `.git` let one task rewrite a sibling task's branch; the entry's `commondir`, `gitdir`, `config.worktree` were writable | Fixed: refs by file; under ISOLATED the account adds and replaces nothing (the labels first put on the three files did not keep them from being replaced: measured later, see Git above). A forged `index` in the entry: NEXUS's own git and the user's git in an ISOLATED session no longer read it (Git, above). Not closed: a forged commit-graph in the object store (below). |
| 3 | HIGH: the sandbox account's credential blob was readable by a low-integrity process of the user | Fixed: `%LOCALAPPDATA%\NexusSandbox` is protected with the data directory. |
| 4 | MEDIUM: an "allow once" could be spent on another action needing the same capability | Fixed: bound to the action shown, since then to a hash of the whole call (`AUTONOMY_MODEL.md`). Allow for the mission and for the project remain by capability and resource, as they say. |
| 5 | MEDIUM: RESTRICTED counted as the isolated profile, so commands NEXUS cannot read into ran without a question, with the user's network | Fixed: only ISOLATED does. Under RESTRICTED such a command is one boundary request ("run project code outside the isolated profile"). |
| 6 | MEDIUM: windowed applications had no UI restrictions (clipboard); their desktop was open to everyone | Fixed (Processes, above). |
| 7 | MEDIUM: any loopback address an application printed was taken as its own | Fixed: Windows must say a process the launcher started holds the port; else nothing is opened. Since the audits below: every listener on that port must be the application's, on an address that serves the registered host. |
| 8 | MEDIUM, suspicion: a junction swapped under a file tool of the provider | Not changed. A low-integrity process cannot make a junction to a directory it cannot write (Windows), so a swap leads nowhere new. Not tested here. |
| 9 | LOW: the launcher inherits handles without a list | Not changed at the time: no inheritable handle beyond the three standard ones was found. Since then the command is started with a handle list that names those three (Processes, above). |
| 10 | LOW: sibling-prefix directory check; unfiltered Electron arguments; the setup script trusts an existing `C:\ProgramData\NexusSandbox` and an existing account of that name | First two fixed. The setup no longer trusts a name: an existing account, folder or firewall rule is judged by what it is, repaired when it is the setup's own and refused otherwise (`sandbox-checks.test.ts`). A race between checking the folder and creating it remains; it costs availability only (the audit measured that the access list is not written through a junction). |

Not closed by this review or after it:

- The worktree's entry holds `HEAD`, and the object store takes new files. NEXUS checks `HEAD` before it adds
  to a branch; it does not validate a commit-graph that contained code wrote. What a forged one can make
  NEXUS's own git do is not established. (The entry's `index` is no longer an open point: no git of NEXUS's
  and no user's git in an ISOLATED session reads it.)
- The registry hosts include GitHub's download hosts and, since the Electron acceptance, `github.com` itself and
  `release-assets.githubusercontent.com` (where install scripts fetch prebuilt binaries, Electron's among them);
  over a tunnel the proxy sees no method. A project can be
  sent to an allowed host. This is in "What is not contained".

### Four focused audits that followed

Four further independent audits ran on the work of the second session: the second round on git ("git as the
user" had been rewritten), Windows containment with the setup and the pipe, network with the research browser
and the application under test, and grants with automatic resumption (`AUTONOMY_MODEL.md`). They found 5 HIGH
findings on git (an option value read as the next option, PowerShell re-quoting an argument, a forged index,
drivers named by `.gitattributes` and an LFS address named by `.lfsconfig`, a junction under NEXUS's own
`reset --hard`), none on Windows containment, and 3 HIGH on the rest (quadratic HTML extraction on a hostile
document, a page whose script blocks the browser's thread, and a regular expression in an application's
manifest run by the runtime). Each is fixed with a regression test, or stated as a limit in the place it
belongs (the DNS exception and the desktop residual above; LFS files that stay pointers; the choice of
resource "any" for a push in `AUTONOMY_MODEL.md`). The list of findings, one by one, with the test or the
reason for each, is in [V0_8_PROGRESS.md](V0_8_PROGRESS.md), section "Finishing 0.8"; it is not repeated here.

## Not yet built (2026-10-11)

Per-kind dispatch on the pipe; a setting for what a project's application may reach besides itself. Built
since this section was first written: application and browser automation (`APP_BROWSER_AUTOMATION.md`), the
research browser (`INTERNET_RESEARCH.md`), the pipe's explicit access list and label, a handle list in the
launcher, fault injection and a soak of the containment, the isolation, application and research panels,
removal of the labels and of the Git access when no project is enrolled.
