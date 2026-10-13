# Windows Isolation Research for the ISOLATED Profile (NEXUS 0.8)

Research with experiments. Date: 2026-10-11. Machine: Windows 11 Pro build 10.0.26200, French locale, a standard (non-elevated) token of a
user who is also a member of Administrators (the group is deny-only in the token), Electron 44 / Node 24.14.0 project, branch
`nexus-0.8-isolation-autonomy`. No source under `src/` was changed. Nothing was installed. Nothing was committed.

This document decides what the ISOLATED execution profile for untrusted project code (node, npm/pnpm, git, python, PowerShell,
Playwright browsers, Electron apps under test, and the agent processes themselves) can really be on this machine. It extends
`docs/WINDOWS_EXECUTION_ISOLATION.md` (2026-10-05, nothing verified by experiment) and does not repeat it. Where that document
was wrong or unverified, section "Corrections to the 2026-10-05 research" says so. Status words used in the tables:

- **SUPPORTED**: works on this machine, by a recorded run, with the tools named.
- **EXPERIMENTAL**: works in part; a stated cost or untested piece remains.
- **INCOMPATIBLE**: tested and fails for this workload as configured.
- **NOT AVAILABLE**: does not exist as a usable API or feature.
- **NOT VERIFIED**: not run here. A statement taken from documentation is labelled "documented".
- Cell labels in the compatibility tables: **tested** (run on this machine), **documented** (from a source), **NOT VERIFIED**.

## Summary of findings

1. A job object with kill-on-close, no breakaway and an active-process limit contains a Node tree including a detached grandchild whose
   parent had exited. `taskkill /T /F` does not (baseline measured: the grandchild survived). Nested jobs work: the shell this ran in
   is already in a job.
2. A write-restricted token (restricting SIDs: a synthetic SID, Everyone, the logon SID; privileges removed) with an ACE for the
   synthetic SID on the work directory runs node, npm, pnpm, git, python, PowerShell, `claude.exe --version` and `codex --version`.
   Writes outside the grant are refused, including through a junction. **Reads of the whole user profile still succeed**, including
   the directory that holds the Claude login (`.claude`, which contains a `.credentials.json`; its contents were not read).
3. Low integrity behaves the same way for writes and reads, and also runs every tool when the work directory carries a Low label and
   TEMP is redirected into it.
4. **Update (second round, Experiments A to C).** Reads of the user profile CAN be contained without administrator rights, for the
   Node, Git, Python, npm and pnpm workload, if the sandbox root is outside the profile (`C:\ProgramData\NexusSandboxProbe\<random>`, created by the
   standard user) and the token is `DISABLE_MAX_PRIVILEGE` with the user SID and Administrators deny-only, no restricting SIDs, default DACL on the logon SID, and (optionally) Low
   integrity with the root labeled Low. All 14 file, registry, pipe and junction assertions passed (Experiment A). The first-round conclusion that
   Node and Git break was caused by the working directory being inside the profile. Two things are NOT contained by that token: DPAPI decryption of
   the user's blobs, and (without Low) reading the memory of same-session processes. Costs: Node's `child_process.spawn` with piped stdio fails (`EPERM`),
   because the default named-pipe DACL gives the sandbox nothing it can use; and the user's Git/SSH/Claude configuration is by design unreachable.
5. **Network cannot be contained at user level on this machine** (Experiment B). A job network rate limit is accepted without admin but
   does nothing observable. An AppContainer without `internetClient` refuses outbound TCP but still reaches loopback listeners outside the container; scripts
   do not load from it (`lstat C:\` refused), only inline Node code runs. No other no-admin per-process socket control was found.
5b. **Third round (supersedes the recommendation of the second).** Token L (user SID enabled, `DISABLE_MAX_PRIVILEGE`, Low IL) runs Node (including `node --test` and piped child processes and named pipes), npm, pnpm, Git, Python and
    PowerShell. A NO_READ_UP mandatory label set by the normal user on a protected tree (275 ms for 2,000 files, covers existing and new children, removable) blocks reads from token L; reads of unlabeled places, Credential Manager (17 entries), DPAPI and all
    network stay open. A linked Git worktree can commit on its own branch namespace and cannot move other branches, tags, config or hooks once four `.git` paths are labeled Low. See "Third round".
6. The launcher plumbing works (Experiment C): piped stdin/stdout/stderr pass through, the child exit code is relayed, and killing the launcher kills the
   child and its detached grandchild. A .NET Framework launcher starts from a path with spaces without a dialog.
7. A .NET Framework executable started as a target under the restricted identities failed to start with a hard-error dialog on the
   user's screen. This is a compatibility finding and a procedural incident (see "Incident").
8. No toolchain for a native launcher exists on this machine except the in-box .NET Framework C# 5 compiler. The probe launcher was built with it. The Claude Agent SDK
   (0.3.288 in this repo) has a `spawnClaudeCodeProcess` option, which answers the open question whether it accepts a wrapper.

## Toolchains present

| Tool | Result |
|---|---|
| `cl`, `gcc`, `clang` | not found |
| `rustc`, `cargo` | not found |
| `go` | not found |
| `dotnet` | `C:\Program Files\dotnet\dotnet.exe` present; `dotnet --list-sdks` prints nothing (runtimes only: Microsoft.NETCore.App 8.0.23 and 10.0.5, WindowsDesktop 8.0.23). No SDK, so `dotnet build` is NOT AVAILABLE |
| .NET Framework `csc.exe` | `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` present (C# 5 language level). Used to build the probes |
| Visual Studio / Build Tools | no `Program Files\Microsoft Visual Studio` found |
| `koffi` | not in `node_modules`; not installed (instructed). Prebuilt for Windows x64 per its documentation; Electron 44 compatibility NOT VERIFIED |
| `node` 24.14.0, `git` 2.53.0, `python` 3.14.3, `pnpm` 12.8.1, `npm` 11.9.0, `codex-cli` 0.130.0, `claude` 2.1.288 | present (Node, pnpm, npm, codex under `C:\Users\user\scoop\apps\nodejs-lts\current`, a junction to `24.14.0`) |
| `pwsh` | not found; Windows PowerShell 5.1 only |
| Playwright Chromium | `%LOCALAPPDATA%\ms-playwright\chromium-1217`, `-1223`, `-1228` present; not launched (see Incident) |
| Electron | `node_modules\electron\dist\electron.exe` present (Bitdefender memory note: check before use); not launched |

## Part 1: documentation findings

Sources are listed at the end. Each item is "documented" unless a probe is cited.

**Job objects.** After `AssignProcessToJobObject` the association cannot be broken; a process can be in several jobs in a hierarchy since
Windows 8 and Server 2012. Children created with `CreateProcess` join the job unless the job sets `BREAKAWAY_OK` (and the parent passes
`CREATE_BREAKAWAY_FROM_JOB`) or `SILENT_BREAKAWAY_OK`. With neither flag set, "a child process [that] attempts to associate itself or
another child process with a job by calling AssignProcessToJobObject ... the call will fail"; Microsoft names this a risk for
processes designed to be associated with a specific job. `Win32_Process.Create` children are not associated with the job.
`KILL_ON_JOB_CLOSE`: closing the last handle terminates all associated processes; for a nested job it terminates the processes of the job and
of its child jobs. Accounting is kept for terminated processes too and child-job accounting is aggregated in the parent. UI limits
(`JOBOBJECT_BASIC_UI_RESTRICTIONS`) restrict handles, clipboard, system parameters, display settings, global atoms, desktop creation and
switching, and `ExitWindows`. Security limits must be set per process, not per job.

**Restricted tokens.** `CreateRestrictedToken` removes privileges, marks SIDs deny-only, and adds restricting SIDs. With restricting SIDs
the system makes two access checks (enabled SIDs, then restricting SIDs) and both must allow. A restricted version of the caller's own
primary token can be used in `CreateProcessAsUser` without `SeAssignPrimaryTokenPrivilege`. Microsoft advises running restricted
applications on a desktop other than the default one, to stop `SendMessage` / `PostMessage` attacks. `WRITE_RESTRICTED` applies the second
check to write access only (flag value 8; the Learn page read does not describe this flag; the behavior below is measured).

**Mandatory integrity control.** Default policy is no-write-up. A Low process cannot write Medium objects even where the DACL allows;
it can read what the DACL allows. Object labels can add no-read-up and no-execute-up; the probe confirmed a no-read-up label on a pipe
blocks Low reads (below).

**AppContainer.** Microsoft's isolation page lists credential, device, file, registry, network, process and window isolation; "granular access
can be granted for Internet access, Intranet access, and acting as a server". Loopback: the Learn material on Windows Runtime apps says
IP loopback between two different apps is restricted by network isolation, with `CheckNetIsolation LoopbackExempt` as the exemption tool;
the sources found say to run it elevated but do not state the requirement outright. **Measured differently on this machine**, see Probe 8.
LPAC and capability SIDs as in the prior document.

**Chromium's Windows sandbox** (design document): the target starts with an initial token (more powerful, used by the main thread during start-up)
and a lockdown token; the target calls `LowerToken()` after start-up. Job object: one-active-process limit, UI restrictions, per-process job.
Alternate desktop: a third desktop, never visible, to stop message attacks, about 4 MB. Integrity levels: a Low token "can still read
most files" and "can access TCP/IP sockets"; "there is no practical way on Windows to stop sandboxed code from calling a system service";
CPU, memory and I/O are not limited. This explains Probe 5: a strict token cannot even start a process without the two-token trick.

**OpenAI Codex Windows sandbox.** The OpenAI article returned HTTP 403 to the fetch tool, so it was not read in full. Secondary write-ups of it agree on: first an
unelevated design (synthetic SID, write-restricted token, write ACE on the working directory; weak on network); then an elevated design
(administrator approval once, dedicated low-privilege sandbox user accounts, ACL boundaries, firewall rules blocking outbound network by
default, local logon-right changes). Reported failure: error 1385 where policy blocks the sandbox user's logon right (managed machines). Reported
limit: neither mode stops writes to directories where Everyone already has write. All of this is secondary and **NOT VERIFIED** against the
Codex source. The design of "wr2" below is the same family as the unelevated design.

**Process mitigation policies.** Unchanged from the prior document (documented only; not tested here).

**Modern APIs.**
- A `CreateProcessInSandbox`-style API: **NOT AVAILABLE**. Searches found no such function. Chromium's `StartSandboxedProcess` is a project wrapper, not an OS API.
- Win32 app isolation: Microsoft Learn (updated 2025-05) still says "This feature is in preview"; requires Windows 11 24H2 (build 26100) or later,
  Visual Studio 17.10.2+ packaging; target types are Win32, Desktop Bridge, and apps packaged with external location. It is for apps the
  developer packages, not a launcher for arbitrary executables: **NOT AVAILABLE** as a usable API for this purpose. Status in 2026 beyond that
  page: NOT VERIFIED.
- Windows Sandbox CLI (`wsb`, Windows 11 24H2): documented as a lifecycle tool for whole sandbox VMs. Not tested here (single instance and no persistent tool state, per the prior document).
- VS Code documents an agent-terminal sandbox on Windows, "Experimental", requiring "the applicable September 8, 2026 Windows security update" (KB5124008 for 24H2/25H2);
  it states sandboxed processes "run under your account" and that it "is not a virtual machine or user-account boundary". The mechanism is not named.
  This machine has KB5124007 (2026-09-08), KB5126052 and KB5129195 installed and `Get-HotFix -Id KB5124008` finds nothing (that KB is
  probably the 25H2/24H2 package for other builds; NOT VERIFIED). Whether the update adds an OS sandbox primitive: NOT VERIFIED.
- Microsoft Execution Containers (MXC), reported from a secondary source as announced at Build 2026 in early preview with declarative ACLs for agents: NOT VERIFIED, no API documentation read, not tested.

**Symlinks, junctions, reparse points.** Measured here: a standard user cannot create file or directory symlinks (`EPERM`, developer mode off, no
`SeCreateSymbolicLinkPrivilege`), can create directory junctions, and can create hard links to files it can read (it succeeded to a
file in the project, under the plain token). The ACL of the target governs access through a junction: see Probe 4.

**Defender / SmartScreen with unsigned helpers.** The launcher built here (22 KB, unsigned, built locally with `csc.exe`) was compiled and run dozens of
times under the project folder without quarantine, and no Bitdefender or Defender prompt appeared. `Get-MpThreatDetection` returned nothing
(it may need elevation; NOT VERIFIED that this reflects no detection). The Mark-of-the-Web / SmartScreen path (a downloaded or installed
unsigned binary) was not tested. Bitdefender excludes the project folder only; a helper installed under `%LOCALAPPDATA%\Programs` was not tested.

## Part 2: experiments

All probes are under `test-results\isolation-probes\` (git-ignored). Layout:

- `src\probe.cs`: the launcher/probe harness (C# 5; builds with the in-box `csc.exe`; command in the file header). `bin\probe.exe` is the build.
  Commands: `info`, `run --mode <plain|restricted|wr1|wr2|ro|low|lowdmp|ac|acnet|lpac|lpacnet> [--job --joblimit N --jobclose --holdms N --soft --ui N --desktop NAME --nochild] --out FILE -- <cmdline>`,
  `pipesrv`, `acprofile create|sid|delete`. Since the incident the launcher calls `SetErrorMode(0x8003)` and puts every run in a job with UI limits (0xFF).
  Runs before that change had no job; their results do not depend on it.
- `scripts\jobs.ps1` (Probe 1), `scripts\battery.ps1 -Mode <m>` (Probes 2 to 8; 15 commands per mode).
- `shared\scripts\*.js|*.py`: `tree.js`, `mid.js`, `orphan.js`, `fork.js`, `wtest.js`, `pipecli.js`, `srv.js`, `nettest.py`; `shared\bin\node.exe` is a copy of Node.
- `results\`: raw outputs: `job-tests.txt`, `battery_<mode>.txt` (+ `bat_<mode>_<n>.txt` per command), `pipe-tests.txt`, `ac-net-tests.txt`, `desktop-tests.txt`, `ro-read-tests.txt`, `claude-codex-tests.txt`, `ancestor-aces-added.txt`.
- Environment given to every probed child: `TEMP`/`TMP` redirected to the mode's work directory, `npm_config_cache` redirected. Real profile variables otherwise unchanged. Scratch layout: `shared` (read for the sandbox SIDs),
  `work_<mode>` (write for the sandbox SIDs; Low label for `work_low`), `outside` (no grant), `results`.
- Synthetic SID used: `S-1-5-21-1111111111-2222222222-3333333333-5001`. AppContainer profile `nexus.probe.ac`.
- Clean-up verified: profile deleted (`DeleteAppContainerProfile` returned 0, package folder absent), no leftover processes, registry key `HKCU\Software\NexusProbeKey` absent, no synthetic-SID or package-SID ACE on `C:\`, `C:\Users\user`, `Documents`, `Documents\Nexus`, `Documents\Nexus\test-results` (checked by SDDL after removal; ACE propagation lagged by a minute).

### Probe 1: job objects (`results\job-tests.txt`)

| Case | Result |
|---|---|
| Shell already in a job? | `SELF_IN_JOB=True`, flags `0x1800` (`BREAKAWAY_OK | SILENT_BREAKAWAY_OK`), about 223 active processes. Assigning a new child to a new job from inside it returned `ASSIGN_OK`: **nested jobs work** |
| A: job (`KILL_ON_JOB_CLOSE`, limit 20, no breakaway), `node tree.js` = main, a child that spawns a detached grandchild and exits, a detached direct child | Before close: `ActiveProcesses=4`. After closing the job handle: main, detached child and orphaned grandchild all dead. **PASS** |
| B: baseline, no job, `taskkill /pid root /T /F` | main and detached child killed; **the grandchild survived** (cleaned up by hand). This closes the NOT VERIFIED item on `taskkill /T` |
| C: `ActiveProcessLimit` 8, Node tries 30 spawns | 7 succeeded, 23 failed: Node throws `spawn UNKNOWN` synchronously (not an event) once the limit is hit. The tool under test must catch it |
| Node `detached:true` inside the no-breakaway job | works; libuv does not set `CREATE_BREAKAWAY_FROM_JOB`, children stay in the job |
| `CREATE_BREAKAWAY_FROM_JOB`, tools that call `AssignProcessToJobObject` | NOT VERIFIED (the flag is implemented but the test was not meaningful, since the probe's parent job allows breakaway) |
| UI limits, `shutdown`/`ExitWindowsEx` | NOT VERIFIED (set only; shutdown paths were deliberately not run) |

### Probe 2: restricted token, `DISABLE_MAX_PRIVILEGE`

`CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)` + `CreateProcessAsUser`, no admin needed. `whoami /priv` in the child lists only `SeChangeNotifyPrivilege`;
the plain token lists `SeShutdownPrivilege` (disabled), `SeUndockPrivilege`, `SeIncreaseWorkingSetPrivilege`, `SeTimeZonePrivilege` and `SeChangeNotifyPrivilege`.
So the shutdown privilege is gone from the token (this machine, standard token). `cmd`, `node`, `git`, `python`, `claude.exe --version`, `codex --version` ran. The 15-command battery was not repeated for this mode alone
(`wr2` includes it); pipe and `claude`/`codex` tests were. Real shutdown paths: not run, **NOT VERIFIED**.

### Probe 3: WRITE_RESTRICTED token

Two variants (`results\battery_wr1.txt`, `battery_wr2.txt`), both `DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED`.

- **wr1: restricting SID = synthetic SID only. INCOMPATIBLE.** `cmd` runs; `whoami`, `node`, `git`, `python`, `powershell`, `npm` all exit `0xC0000142` (DLL initialization failed): the second access check on writes to session objects (desktop, window station, base named objects) fails.
- **wr2: restricting SIDs = synthetic SID, Everyone (`S-1-1-0`), logon SID (`S-1-5-5-0-...`); token default DACL set to user, synthetic SID, SYSTEM. SUPPORTED.**
  Without the default-DACL step the first token variant of this family failed to start; the default DACL is needed so the process can open objects it creates itself.

wr2 results (15 commands, ACE for the synthetic SID on `shared` (read) and `work_wr2` (full)):

| Command | Result |
|---|---|
| cmd, whoami, node (copy and scoop), git (init + commit in work dir, status on the Nexus repo), python (print, write file), Windows PowerShell, npm -v, `npm install ../pkg --offline`, pnpm -v | all exit 0, correct output |
| write in `work_wr2` | OK |
| write in `outside` (sibling dir, no ACE) | `EPERM` |
| open `Nexus\package.json` for write (no write performed) | `EPERM` |
| **read** `Nexus\package.json`, `~/.gitconfig`; list `~/.claude` (36 entries), list `Documents` (44 entries) | **all OK: the confidentiality gap is confirmed** |
| TEMP in work dir | OK |
| junction in work dir to `outside`, then write through it | creation OK, **write through it `EPERM`**: the target's ACL decides; an ACL boundary holds across a junction |
| file/dir symlink creation | `EPERM` (same as the plain token) |
| hard link to a profile file | `EPERM` (the plain token succeeded) |
| `reg add HKCU\...` | access denied |
| loopback listen + self connect, TCP connect to 1.1.1.1:443 | OK (no network control) |
| `claude.exe --version` 2.1.288 | OK. Not a session: login, network and tool use not tested |
| `codex --version` | OK, with two warnings: it cannot write `C:\Users\user\.codex\tmp\arg0` ("Accès refusé") and proceeds |

What breaks: every location a tool writes outside the grant: `~/.codex/tmp`, `~/.claude`, pnpm/npm caches (redirected here), the real `%TEMP%`.

### Probe 4: low integrity (`results\battery_low.txt`)

Token duplicate with `S-1-16-4096` set. `work_low` labeled Low with `icacls /setintegritylevel (OI)(CI)L`.
Same 15-command battery: all exit 0 (git init/commit, python write, Windows PowerShell, npm install of a local package, pnpm). Write to `outside` (default Medium label): `EPERM`.
Open of a profile file for write: `EPERM`. Reads of the profile: OK (same gap). `reg add HKCU`: access denied. Hard link and symlink: denied.
Junction creation: `EPERM`; the outcome of write through a junction at Low was not obtained (`ENOENT` after the failed creation). `whoami /priv` still shows `SeShutdownPrivilege`
(disabled), as Low IL does not remove privileges. This corrects the prior prediction that the tools would break at Low: they did not, once TEMP/npm cache point inside a Low-labeled directory.
Real caches (`%LOCALAPPDATA%\pnpm`, `~/.claude`, `~/.codex`) were not used: `codex --version` warns it cannot write `~/.codex/tmp`.

### Probe 5: reads stopped? A token with the user SID deny-only (Chromium-style "ro")

`ro`: user SID and Administrators deny-only, `DISABLE_MAX_PRIVILEGE`, restricting SIDs Everyone, Users, logon SID, synthetic SID, not `WRITE_RESTRICTED` (so the second check covers reads).

- First attempts all failed to start (`0xC0000142`, `0xC0000022`): deny-only user SID plus default DACL granting only the user/synthetic SID leaves the process unable to open itself. Setting the default DACL to the logon SID (an enabled group that is also a restricting SID) fixed `cmd`.
- Reads: `python` reading `~/.gitconfig` and `Documents\Nexus\package.json`: `PermissionError`; `cmd type ~/.gitconfig`: access denied; `dir ~/.claude`: access denied. System files (`C:\Windows\win.ini`) readable. Writing to `C:\`: denied. **This mechanism does stop profile reads without admin.**
- What fails: `node` runs `-v` but cannot load a script ("Cannot find module"): Node calls `lstat` on every ancestor directory and the profile directories refuse the restricting SIDs. `git`, `npm`, `pnpm` fail with access denied on the working directory path. Windows PowerShell exits with `0x8007000E`. Python works for inline code.
- Adding a read-attributes/traverse ACE for the synthetic SID on ancestors was attempted on `Documents`, `Nexus`, `test-results` (added, then removed) and on `C:\Users\user`; the latter did not finish in 8 minutes because the DACL write propagated inherited ACEs over the profile tree and was cancelled. That attempt is superseded by Experiment A below: with the sandbox root outside the profile no ancestor grants are needed, and Node and Git work.

### Probe 6: named pipes (`results\pipe-tests.txt`)

Servers created by an ordinary medium-IL process with: default DACL; DACL user-only + SYSTEM; the same plus a `ML;;NWNRNX;;;ME` label; Everyone full; user + ALL APPLICATION PACKAGES. Clients are `node.exe` or `cmd.exe` (native). "R / W" = read-only / write-only open.

| Client | default DACL | user-only DACL | user-only + NW/NR/NX label | Everyone-full DACL |
|---|---|---|---|---|
| plain token | R W RW OK | OK | OK | OK |
| restricted (privileges only) | OK | OK | OK | OK |
| wr2 (write-restricted) | R OK, **W and RW denied** | R OK, W denied | R OK, W denied | OK |
| low IL | R OK, W denied | R OK, W denied | **R, W and RW denied** | R OK, W denied |
| ro (restricting SIDs, reads checked) | denied (cmd write-open) | denied | not run | open OK |
| AppContainer (no caps) | denied | denied | not run | **denied** (Everyone does not match); opens only when the DACL names ALL APPLICATION PACKAGES (`AC`) |

So an IPC endpoint is protected from a write-restricted, low-IL, restricting-SID or AppContainer process by an explicit DACL that grants the user SID only and does
not grant Everyone, Users, or ALL APPLICATION PACKAGES, and adding the no-read-up label also blocks a Low process from reading. A token with only privileges removed (the `restricted` row) is not stopped by any DACL, since it keeps the user SID. A caveat: a default pipe DACL gives Everyone read, so a write-restricted process
can read-open it.

### Probe 7: desktops

`CreateDesktop` unelevated succeeded; a `cmd.exe /c echo` child under the plain token and under wr2 ran on `WinSta0\nexusprobe_desk` and printed. No window appeared (not switched to). SUPPORTED. The effect on windowed child programs (Chromium, Electron) NOT VERIFIED.

### Probe 8: AppContainer (`results\battery_ac.txt`, `ac-net-tests.txt`)

`CreateAppContainerProfile` and launch with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` needed **no admin**. ACEs for the package SID on the scratch dirs via `SetAccessControl` also needed none.

| Command | Result |
|---|---|
| cmd, whoami, `node -v` (shared copy and scoop path), `git --version`, python print and write in work dir | OK (Python prints "Failed to find real location of C:\PROGRA~1\Python314\python.exe") |
| git init+commit in work dir; git status on the repo; npm; pnpm | access denied / cannot find script |
| node running a script | **fails: `EPERM: lstat 'C:\'`** (the drive root's ACL grants Authenticated Users and Users, not the package SID); the same hits `npm-cli.js` |
| profile reads (`type ~/.gitconfig`, `dir ~/.claude`, `dir Documents`) | access denied |
| `whoami /priv` | `SeChangeNotifyPrivilege`, `SeIncreaseWorkingSetPrivilege` only; Low integrity label; package SID |
| network without capability | loopback self-connect OK; **connect to a medium-IL listener on 127.0.0.1 OK**; TCP to 1.1.1.1:443 `WSAEACCES 10013` |
| network with `internetClient` (S-1-15-3-1) | loopback OK, outbound OK |
| LPAC (`ALL_APPLICATION_PACKAGES_OPT_OUT`) with `internetClient` | Python exits `0xC0000022` (access denied at start); INCOMPATIBLE without explicit grants, not pursued |
| Windows PowerShell | not launched (see Incident) |

The documented claim (prior research and Microsoft's Windows Runtime guidance) that AppContainer loopback is blocked and needs an exemption **did not hold** for this custom profile: loopback to a user-owned listener
worked without any exemption, and no elevated command was run. Why (profile type, build 26200 behavior, listener ownership) is NOT VERIFIED; one profile and Python/Node sockets were tested.
Fixing `lstat C:\` needs an ACE on the drive root, which needs administrator rights and was not attempted.

### Probe 9: tools under tokens (`claude`, `codex`)

`claude.exe --version` (the SDK's bundled binary): exit 0 under plain, restricted, wr2, low. `codex --version`: exit 0 under all four, warnings under wr2 and low as above.
A real Claude session (login, network, tool use) and any `codex exec` under any token: **NOT VERIFIED**. Codex's own nested sandbox: NOT VERIFIED.
Playwright Chromium and Electron under any token: **NOT VERIFIED** (not launched, see Incident).

### Incident

During the pipe probe, `probe.exe` (a .NET Framework executable) was used as the *target* under the `ro` token; it failed to start (exit `2148734720`, `0x80131700`, or a time-out) and raised the hard-error dialog "This application could not be started" on the user's screen,
violating the rule against opening windows. Measures taken: no .NET executable is launched as a target under a restricted, Low or AppContainer identity any more (clients are `node.exe`, `cmd.exe`, `python.exe`, `git.exe`, `whoami.exe`);
the launcher now calls `SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX)` and puts each child in a job with UI restrictions; Windows PowerShell and the browsers were not launched under the AppContainer and `ro` identities after it; leftover processes were checked and none remained.
**Compatibility finding:** managed (.NET Framework) programs, and by extension anything that needs the CLR host, can fail to start under these tokens with a dialog and not an exit code. An ISOLATED launcher must set the error mode, must not start such targets without a test, and the launcher itself must run as the user (as the probe did).

## Second round: Experiments A, B, C (2026-10-11)

Added after the first report, with the same rules (console-only, hidden, scratch under `test-results\isolation-probes\`, `SetErrorMode(0x8003)` in the launcher, every child in a kill-on-close job with UI limits 0xFF, targets only
`cmd`, `node`, `git`, `python`, `whoami`, npm and pnpm). The launcher gained: `--ressids none|list` (list entries `SYN`, `LOGON`, SID strings), `--il low`, `--inherit` (child gets the launcher's own std handles), `--log FILE`,
`--netrate N`, `--deskdacl`, `--owner`, and `ace add|remove|has PATH SID HEXMASK` (writes a this-folder-only ACE with `SetKernelObjectSecurity`, which does not propagate to children). New scripts: `scripts\rdbattery.ps1` (Experiment A),
`scripts\update_doc.py` (this edit). Fixtures lived in the sandbox root, now deleted; raw outputs are `results\rd_<variant>.txt` (+ `rd_<variant>_<n>.txt`), `overhead.txt`, `netrate-tests.txt`, `ac-nonet-tests.txt`, `launcher-plumbing.txt`, `c1.launcher.log`, `c2.launcher.log`, `spawn_*.txt`.

### Experiment A: reads contained, sandbox root outside the profile

**Root.** `C:\ProgramData\NexusSandboxProbe\<8 hex>` was created by the standard user with no elevation (the parent `NexusSandboxProbe` too). A top-level `C:\NexusSandboxProbe` was **not tried**: the tooling in use refuses `Remove-Item`
on a drive-root folder, so a clean-up could not be guaranteed. NOT VERIFIED. DACL set with `SetAccessControl` on the new, still-empty folder: protected (no inheritance from `ProgramData`), inheritable full control for the user SID, SYSTEM, the per-run synthetic SID
`S-1-5-21-1111111111-2222222222-3333333333-5001` and the logon SID (`S-1-5-5-0-1724662223`). A second root (`...\sibling2`) used a different synthetic SID and granted nothing to the first. Contents: `bin\node.exe` (copy), `bin\npm` (copy of npm, 1,773 files),
`bin\pnpm-copy`, `proj` (package.json with `"test": "node --test"`, one test, probe scripts), `repo` (git repo made by the normal user), `home`, `tmp`.

**Environment given to the sandbox:** `TEMP`, `TMP` = `<root>\tmp`; `HOME`, `USERPROFILE` = `<root>\home`; `APPDATA` = `<root>\home\AppData\Roaming`; `LOCALAPPDATA` = `<root>\home\AppData\Local`; `PATH` = `C:\Windows\System32;C:\Windows;<root>\bin;C:\PROGRA~1\Git\cmd;C:\PROGRA~1\Python314`;
`GIT_AUTHOR_*` / `GIT_COMMITTER_*` set; `npm_config_cache`, `npm_config_userconfig`, `npm_config_prefix`, `PNPM_HOME`, `XDG_*` inside the root. `GIT_CONFIG_NOSYSTEM` was **not needed**.

**Token recipes tried (all `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)`, user SID and `BUILTIN\Administrators` deny-only, default DACL = logon SID + synthetic SID + SYSTEM full, not `WRITE_RESTRICTED`):**

| Variant | Restricting SIDs | Extra | Result |
|---|---|---|---|
| v1 | synthetic, logon, Everyone, BUILTIN\Users, NT AUTHORITY\RESTRICTED | | works; see tables |
| v2 | synthetic, Everyone, Users, RESTRICTED (no logon SID) | alternate desktop whose DACL names the synthetic SID | **INCOMPATIBLE**: node, git, npm, pnpm, whoami exit `0xC0000142` (window station access needs the logon SID); only `cmd` and python start |
| v3 | as v1 | Low IL, root not labeled Low | writes in the root fail (`EPERM`), as expected; superseded by v5 |
| v4 | **none** (deny-only user SID alone, first access check only) | | works; simplest recipe that holds |
| v5 | **none** | Low IL on the token; root labeled Low with `icacls /setintegritylevel (OI)(CI)L` | works; strongest |

Authenticated Users in or out of the restricting list was not run separately (v4 and v5 have no restricting list, which makes the question moot).

**Tool battery** (cwd `<root>\proj`; v1, v4 and v5 give the same results unless noted):

| Command | Result |
|---|---|
| `cmd /c dir` | OK |
| `whoami /priv` | only `SeChangeNotifyPrivilege` |
| `node -p 1+1`; node script by absolute path (`fsrw.js`: write, read back, `realpath`, `os.homedir()` = `<root>\home`) | OK in v1, v4, v5. The first-round `lstat` failure is gone once the root is outside the profile |
| `node --test` | **FAILS** `spawn EPERM` (the test runner spawns node with piped stdio); see "Why `spawn` with pipes fails" |
| `npm --version` (npm copied into the root) | OK 11.9.0 |
| `npm test` | npm starts, runs `node --test`, which fails as above |
| `git status`; `git add` + `commit` (identity from `GIT_AUTHOR_*` / `GIT_COMMITTER_*`) | OK. No safe-directory prompt (the token's user SID is unchanged) |
| `python` script with file IO in the root; `python --version` from `Program Files` | OK |
| `pnpm --version`: copy in the root, and original `pnpm.exe` in the profile (`scoop\apps\nodejs-lts\current\bin\node_modules\pnpm\pnpm.exe`) | both OK 12.8.1: an executable image is opened with the launcher's token, so a self-contained exe in the profile starts. What it then reads from the profile is refused |
| node (scoop, profile) `-v` | OK, same reason |
| Python at `C:\Program Files\Python314` | readable by Users, no ACE needed. (Python does not live in `%LOCALAPPDATA%` here) |
| `npm` JavaScript in the profile (`scoop\apps\nodejs-lts\24.14.0\node_modules\npm`) | refused until granted. With **a `FILE_READ_ATTRIBUTES` (0x80) non-inherited ACE for the logon SID on each of six ancestors** (`C:\Users\user`, `scoop`, `scoop\apps`, `nodejs-lts`, `24.14.0`, `node_modules`) **plus a ReadAndExecute inheritable ACE for the logon SID on the `npm` directory**, `node <profile>\npm\bin\npm-cli.js --version` printed 11.9.0. All ACEs removed afterwards and verified absent (0 on the six ancestors, 0 on all entries of the npm tree). Writing the ancestor ACEs took about 30 ms each through `SetKernelObjectSecurity`; the same change through `SetAccessControl` on `C:\Users\user` did not finish in 8 minutes (first round) because it propagates. These grants re-expose to the sandbox exactly what they name; the safer route is to copy tools into the root, as done above |

**Security assertions** (script `secprobe.js` run inside the token, plus Python ctypes; sentinels `%USERPROFILE%\nexus-probe-sentinel.txt` and `%APPDATA%\nexus-probe\s.txt` created by the normal user and removed afterwards; no real file was read, only listed or opened):

| Assertion | v1 | v4 | v5 |
|---|---|---|---|
| Read sentinel in `%USERPROFILE%` -> DENIED | PASS | PASS | PASS |
| List `%USERPROFILE%` -> DENIED | PASS | PASS | PASS |
| List `%USERPROFILE%\.claude` -> DENIED | PASS | PASS | PASS |
| Read sentinel in `%APPDATA%\nexus-probe` -> DENIED | PASS | PASS | PASS |
| Write to `%USERPROFILE%` -> DENIED | PASS | PASS | PASS |
| Write to the sibling sandbox root (other synthetic SID) -> DENIED; read of it -> DENIED | PASS / PASS | PASS / PASS | PASS / PASS |
| Write to HKCU (`reg.exe` from node) -> DENIED (spawn `EPERM`; with `cmd /c reg add` it is "access denied") | PASS | PASS | PASS |
| Read `C:\Windows\System32\drivers\etc\hosts` -> ALLOWED | PASS | PASS | PASS |
| Write inside the root -> ALLOWED | PASS | PASS | PASS |
| Junction in the root to `%USERPROFILE%`: listing and reading through it -> DENIED | PASS / PASS | PASS / PASS | junction creation denied at Low (`EPERM`), so not reached |
| Open a pipe created by a medium process with a user-SID-only DACL: read and write -> DENIED | PASS / PASS | PASS / PASS | PASS / PASS |
| `CryptUnprotectData` on a blob the normal user protected -> expected DENIED | **FAIL: ALLOWED** | **FAIL: ALLOWED** | **FAIL: ALLOWED** |
| `OpenProcess(PROCESS_VM_READ)` on the launching PowerShell (medium, same user) -> expected DENIED | **FAIL: ALLOWED** | **FAIL: ALLOWED** | **PASS: DENIED (error 5)** |

Why VM_READ is allowed below Low: the default process DACL contains the logon SID with read/execute rights, and the logon SID is an enabled group (and, in v1, a restricting SID). Low integrity adds the mandatory check and refuses it.
DPAPI works because the service decrypts for the token's user SID regardless of deny-only; it protects against reading blobs (reads are refused), not against decrypting blobs the sandbox already holds.

**Why `spawn` with piped stdio fails (also true for the wr2 token of the first round, where `reg.exe` from node got `EPERM`).** Node/libuv creates a named pipe with no security descriptor and the child opens the other end. A named pipe without an explicit DACL gets the pipe file system's default
(SYSTEM, Administrators and the creator owner full, Everyone read). With the user SID deny-only (or, for wr2, with Everyone only able to read), the creator-owner entry gives the sandbox nothing, so the client open is refused. Measured: stdio `inherit` and `ignore` work; a `net` pipe server listens, but its client gets `EPERM`.
`SetTokenInformation(TokenOwner)` to the logon SID or the synthetic SID fails with `ERROR_INVALID_OWNER` (1307): only the user SID or a group carrying the owner flag is accepted, and no group in this token carries it. Anonymous pipes (`CreatePipe`, as Git uses) work. A Bun or Node agent that creates pipes with default security is expected to hit the same limit (`claude.exe` and `codex exec` were not run under this token, NOT VERIFIED).

**Odd interaction, not understood:** while an AppContainer package-SID ACE was present on the root tree, a Low-labeled `node.exe` run by the normal user got `EPERM` from `lstat` on the root's children; removing that ACE fixed it. Do not mix package-SID grants with Low-labeled trees without testing.

**Process start overhead** (wall time of the whole launcher run, median of 20; the .NET launcher's own start-up of about 110 ms is included in every row, so the token cost is below the measurement noise):

| Case | `cmd /c exit 0` | `node -p 1` |
|---|---|---|
| plain (launcher, no token; first row includes cold cache) | 154 ms | 118 ms |
| v4 | 112 ms | 124 ms |
| v5 (Low IL) | 115 ms | 127 ms |
| v1 | 117 ms | 123 ms |
| wr2 | 159 ms | 120 ms |

### Experiment B: network

1. **Job network rate control.** `SetInformationJobObject(JobObjectNetRateControlInformation = 32)` with `MaxBandwidth` and flags `ENABLE | MAX_BANDWIDTH` succeeded **without admin** with a 16-byte structure (a 24-byte size returned `ERROR_BAD_LENGTH`). The limit is **not enforced** here:
   one HTTP GET of 100,236 bytes from `httpbin.org` took 1.06 s unlimited, 2.39 s at 1,000 bytes/s, and 0.71 s at 20,000 bytes/s (the spread is network noise; a real 1,000 bytes/s limit would take about 100 s). Loopback, a 2 MB transfer: about 200 MB/s unlimited and about 182 to 200 MB/s limited, in both directions (server in the job and client outside; client in the job and server outside). So the control neither throttles Internet traffic nor loopback. Inheritance by children and lifting by a child were not tested (nothing to inherit). Why it is inert (a QoS policy component, the build) is NOT VERIFIED. Status: **NOT AVAILABLE** as a control.
2. **AppContainer without `internetClient`**, root outside the profile with an ACE for the package SID, targets `node.exe -p eval(process.env.JS)` only. `node -p 1+1` runs; **outbound TCP to 1.1.1.1:443 refused (`EACCES`)**; **TCP to a loopback listener of a medium-IL process outside the container: allowed** (`connect` succeeded); self loopback inside the container works; `child_process.spawnSync` with piped stdio hangs until the 30 s time-out. With `internetClient`, outbound works. Scripts cannot be loaded (first round: `lstat C:\` refused), so an AppContainer is a no-network runner only for inline code and for tools that do not call `lstat` on the drive root (Python worked in the first round). The loopback result differs from the documentation; one profile, one build. (The loopback test with `internetClient` was inconclusive: the listener had timed out.)
3. **Other no-admin per-process socket controls:** none found. Windows Firewall rules, WFP filters and user-scoped rules need administrator rights; environment proxies and `NODE_OPTIONS` hooks are advisory; mitigation policies do not cover sockets; job network rate control is inert. The only no-admin network denial observed is the AppContainer capability model.

### Experiment C: launcher plumbing

Launcher: `bin\probe.exe` copied to `results\dir with spaces\launcher.exe` (a .NET Framework exe built by the in-box `csc.exe`), run as the normal user. Parent: a normal Node process (`shared\scripts\cparent.js`) spawning the launcher with `stdio: ['pipe','pipe','pipe']`.
Launcher arguments: `run --mode ro --ressids none --inherit --soft --log FILE --cwd <root>\proj --env ... -- <root>\bin\node.exe <script>`; diagnostics go to `--log` so they do not mix with the child's streams.

| Test | Result |
|---|---|
| C1: parent writes `hello via stdin`; child (read-contained token) echoes it upper-cased on stdout, writes `ERRLINE` to stderr, exits 7 | parent received stdout `ECHO:HELLO VIA STDIN`, stderr `ERRLINE`, and the launcher exited with **code 7**. Pass |
| C2: child starts a detached grandchild; parent kills the launcher with `SIGKILL` (TerminateProcess) | before the kill both alive; after the kill, **child and detached grandchild both dead**; the job handle closed with the launcher. Pass |
| Launcher started from a path containing spaces | no dialog, started normally. Pass |
| Exit of the child while the grandchild is alive | by the code path (the launcher terminates the job when the child exits); not separately tested |

The launcher passes its own std handles, so the Agent SDK's `spawnClaudeCodeProcess` can return the launcher's `ChildProcess`; a real SDK session through it is NOT VERIFIED.

## Third round: token L, mandatory-label read protection, Git worktree (2026-10-11)

Same rules as the second round. The first-round and second-round fixtures were deleted before this round; this round's fixtures (`work_L`, `protected`, `protected_link`, `protected_copy`, `medium_unlabeled`, `medium_sibling`, `repoL`) were created under the scratch directory and deleted afterwards (verified; no process, task, Run value, HKCU key or profile sentinel left).
New launcher command: `label set PATH SDDL | label clear PATH` (`SetNamedSecurityInfoW` with `LABEL_SECURITY_INFORMATION`, prints elapsed ms). New scripts: `scripts\lbattery.ps1`, `scripts\doc_third.md` / `update_doc3.py` (this edit). Raw results: `results\L_D1.txt`, `L_D1PS.txt`, `D2_L.txt`, `D3.txt`, `D4.txt.phase1`, `D4.txt.phase2`.

**Token L (launcher mode `lowdmp`):** `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)` on the user's primary token (the user SID stays **enabled**, group list unchanged, no restricting SIDs), `DuplicateTokenEx` to a primary token, `TokenIntegrityLevel` = `S-1-16-4096` (Low). `whoami /priv` shows only `SeChangeNotifyPrivilege`. The work root `work_L` (inside the project folder) was labeled Low with `icacls /setintegritylevel (OI)(CI)L /T` (2,802 files). `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, npm and pnpm caches pointed inside it; node, npm and pnpm were copies inside it; git and python from `Program Files`.

### D1: tools under token L (the decisive item)

| Test | Result |
|---|---|
| `node --test` (the runner spawns node with piped stdio) | **PASS** (1 test, exit 0) |
| `npm test` | **PASS** |
| node `spawnSync` and async `spawn` of a child with stdio `pipe`, output read back | **PASS** (`42`, `async-pipe`) |
| node `net` named-pipe server and client inside the sandbox | **PASS** (`pong`) |
| `git init`, `add`, `commit`, `log`, `status` in a repo inside the root | **PASS** |
| Python `subprocess.run(capture_output=True)` | **PASS** |
| `cmd /c echo x | findstr x` | **PASS** |
| `pnpm --version` (pnpm.exe copy) | **PASS** 12.8.1 |
| `powershell -NoProfile -Command 1+1` (run only after the above passed) | **PASS** (`2`, no dialog) |

So piped-stdio spawns work at Low with the user SID enabled. The first-round failure was caused by the deny-only user SID (the default pipe DACL's creator-owner entry), not by Low integrity.

### D2: NO_READ_UP label on a protected tree

Fixture: `protected\` with 2,002 small files (40 nested directories) and a sentinel; one deep file (`d1\sub1\deep\before-label.txt`) existed before the label.
**Setting the label:** `SetNamedSecurityInfoW(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, ..., sacl)` with SDDL `S:(ML;OICI;NWNRNX;;;ME)` (Medium, no-write-up, no-read-up, no-execute-up, inheritable) **works as the normal user, no admin**, in **275 ms for the whole tree**. It **propagated to existing children**
(the deep pre-existing file showed an inherited label `Medium (NW,NR,NX)`) and files created afterwards inherit it. A second pass (`label set` again) took 277 ms and is the recursive refresh if a child lost it. `icacls /setintegritylevel` takes a level and inheritance flags only (usage text shows no policy-bit syntax); it was not tried with NR.
**Removing:** `label clear` (an empty SACL with `LABEL_SECURITY_INFORMATION`) took 284 ms and removed the label from root and children; adding the `UNPROTECTED_SACL` flag made the call fail with 1314 (privilege not held), so the flag must not be used. After the clear, L could read the sentinel again; the label was then restored.

| Assertion (from token L unless stated) | Result |
|---|---|
| Read sentinel; list root; list a deep dir; read a deep file created BEFORE the label; read another pre-existing deep file; read a file created AFTER the label | all **DENIED** (6 PASS) |
| Delete a protected file; create a new file in the tree | **DENIED** (file still present, nothing created) |
| Relabel the tree from L (`icacls ... /setintegritylevel L`) | **DENIED** ("Accès refusé") |
| Normal medium process reads the same files, lists the tree | works |
| Hard link made by a medium process elsewhere to the sentinel; L reads it | **DENIED** (same file object, the label travels with it) |
| Copy made by a medium process elsewhere; L reads it | **ALLOWED** (the copy carries no label: the residual gap) |
| File moved in from elsewhere (keeps its old descriptor); L reads it | DENIED before and after a refresh pass (icacls showed no label on it before the pass, one after; why it was denied before is not understood) |
| Medium file with no explicit label (scratch dir, a file in `%USERPROFILE%`, `.claude` listing) read from L | **ALLOWED** (the residual gap, confirmed) |

### D3: other channels under token L

| Test | Result |
|---|---|
| `OpenProcess(PROCESS_VM_READ)` on the launching (medium) PowerShell | **DENIED** (error 5) |
| Write to HKCU (`reg add`) | **DENIED** |
| Read an HKCU key (`reg query HKCU\Environment`) | **ALLOWED** (14 lines): HKCU is readable |
| Write to `%USERPROFILE%`; write to a Medium-labeled sibling dir | **DENIED**; **DENIED** |
| Open the user-SID-only + no-read-up pipe, read and write | **DENIED**; **DENIED** |
| Run-key autostart write (`HKCU\...\Run`) | **DENIED** (nothing left behind) |
| `schtasks /create` (harmless name) | **DENIED** (no task exists afterwards) |
| `CredEnumerateW` (generic credentials of the user) | **SUCCEEDED, count = 17** (names and values not read). Credential Manager is open to the sandbox |
| DPAPI `CryptUnprotectData` on a blob the normal user protected | **ALLOWED** (as expected) |
| Clipboard: job UI limit `READCLIPBOARD` set | `OpenClipboard` OK; `GetClipboardData` **access denied (5)** |
| Clipboard: job UI limit not set | `OpenClipboard` OK; `GetClipboardData` did not fail on access (error 1168, no text format present at the time). Content never read. The limit is therefore the only observed block, and its effect is shown by the changed error code |
| Reads outside the protected list: a profile file, the `.claude` listing | **ALLOWED** (length and count only) |

### D4: Git linked worktree under token L

Setup: `repoL` made by the normal user (Medium, not labeled), `git worktree add -b agent/t1 <root>\wt`; the new worktree directory inherited the Low label from the root. `main` and a `victim` branch exist.

| Phase | Test | Result |
|---|---|---|
| 1 (nothing in `.git` labeled Low) | `git status`, edit + `git diff` | PASS |
| 1 | `git add -A`, `git commit` | **FAIL**: cannot create `.git\worktrees\wt\index.lock` (Permission denied) |
| 2 (label Low, inheritable, on `.git\worktrees\wt`, `.git\objects`, `.git\refs\heads\agent`, `.git\logs\refs\heads\agent`) | `git add -A`, `git commit` on `agent/t1` | **PASS**: the commit is recorded (`git log` shows it; the normal user sees `agent/t1` moved). Git prints `Unable to create packed-refs.lock` (non-fatal here) |
| 2 | `git update-ref refs/heads/main HEAD` | **FAIL** (cannot lock `main`), `main` unchanged |
| 2 | `git branch -D victim` and `git update-ref -d refs/heads/victim` (not checked out) | **FAIL** (cannot create `victim.lock`), branch intact. (`branch -D main` was refused only because `main` is checked out in the main worktree, which is not a permission test) |
| 2 | `git update-ref refs/heads/victim agent/t1` (move another branch) | **FAIL** |
| 2 | `git tag v1`; `git checkout -b newbranch` | **FAIL** (`refs/tags`, `refs/heads` are Medium) |
| 2 | `git config user.name x` (shared config) | **FAIL** (cannot lock `.git\config`); config unchanged |
| 2 | write `.git\hooks\pre-commit` | **FAIL** (access denied); no hook created |
| 2 | `git update-ref refs/heads/agent/other HEAD` (same namespace) | PASS (intended) |

An agent can commit on its own branch namespace and cannot move, delete or create branches or tags outside it, change the shared config, or add hooks. Side effect to design for: the Low label on `.git\objects` lets the sandbox write, replace or delete any object of the repository (not tested; follows from the label), so repository integrity should be checked (`git fsck`) before NEXUS merges from it, or the agent should work in a clone with its own object store (a clone made inside the Low root, which is the 0.8 per-task clone model).

This machine has a Windows group `CodexSandboxUsers` whose ACEs appear on the project folder's ACL (shown by `icacls`), which indicates Codex's elevated sandbox users were set up on this machine at some earlier time; it was not used or tested here.

## Corrections to the 2026-10-05 research

| Statement there | Now |
|---|---|
| `taskkill /T` orphan escape: NOT VERIFIED | Verified: the orphaned grandchild survives; a job closes it |
| Nested jobs matter (Electron or a terminal may already be in a job) | Verified: the shell is in a job (`0x1800`) and a child joined a new job |
| Whether the SDK accepts a wrapper: NOT VERIFIED | `spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess` and `pathToClaudeCodeExecutable` exist in `sdk.d.ts` (lines 1979, 2444). The function receives `command, args, cwd, env, signal` and returns an object with `stdin`, `stdout`, `kill`, `exitCode`, `on('exit')`. Real session through a wrapper: NOT VERIFIED |
| Low IL "breaks the caches until relabeled; the worktree itself needs relabeling" | Correct for the worktree and TEMP; but with those relabeled all 15 commands passed. The cache list is still unverified for real cache paths |
| Write-restricted token: "writes succeed only where the DACL grants a restricting SID" and compatibility "possible subtle breakage" | Needs the restricting list to include Everyone and the logon SID or nearly everything fails with `0xC0000142`; and needs a token default DACL. Pipes (Probe 6) are the subtle breakage found: write-open of default-DACL pipes is refused |
| AppContainer: loopback blocked, exemption needs admin | Not reproduced: loopback worked without an exemption for this profile. Profile creation, launch and ACL grants on one's own dirs need no admin |
| AppContainer "cannot call into the shell" re power | NOT VERIFIED still (no shutdown probe) |
| Windows Sandbox single instance / no programmatic channel | unchanged, not re-tested; the 24H2 `wsb` CLI is documented but not evaluated |
| "Whether a new native helper would be flagged": NOT VERIFIED | A 22 KB unsigned helper built locally ran without quarantine under the project folder; installed-location and signed/unsigned cases NOT VERIFIED |
| Win32 App Isolation status | Still "preview" on Microsoft Learn; packaging-based; NOT AVAILABLE for launching arbitrary tools |
| Child-process policy and mitigation attributes | still documented only; not tested |

## Candidate mechanisms

Compatibility cells: Node / Git / Claude / Codex / Playwright (Chromium) / Electron. "t" = tested here, "d" = documented only, "NV" = NOT VERIFIED.
Claude and Codex "t" means `--version` only.

| Mechanism | Status on this machine | Security benefit | Compatibility cost | Implementation complexity | Node | Git | Claude | Codex | Playwright | Electron |
|---|---|---|---|---|---|---|---|---|---|---|
| Job: kill-on-close, no breakaway, process limit, memory limit, UI limits | **SUPPORTED** (Probe 1) | Whole tree dies with the launcher/NEXUS, even orphans; fork cap; no process escape | `spawn` throws at the limit; tools that need their own job fail to assign (NV which) | Low | t | t | t (--version) | t (--version) | NV | NV |
| Nested jobs | **SUPPORTED** | Lets NEXUS contain even if started inside a job | none seen | Low | t | t | NV | NV | NV | NV |
| Restricted token, privileges removed | **SUPPORTED** | Removes `SeShutdownPrivilege` and others from the token | None seen | Low (native call) | t | t | t | t | NV | NV |
| Write-restricted token, synthetic SID only (wr1) | **INCOMPATIBLE** | n/a | Processes die at start (`0xC0000142`) except `cmd` | n/a | t (fails) | t (fails) | NV | NV | NV | NV |
| Write-restricted token + Everyone + logon SID + default DACL (wr2) + ACEs on grants | **SUPPORTED** | Writes outside the granted dirs refused; junction does not escape; registry `HKCU` writes refused; pipes refuse writes | Every cache/config dir a tool writes must carry the ACE; reads remain open | Medium: ACE lifecycle and cleanup | t | t | t (--version) | t (warns) | NV | NV |
| Low integrity + labeled work dir | **SUPPORTED** | Writes to Medium objects refused; registry refused; pipe write refused | Labeled dirs become writable to every Low process; `SeShutdownPrivilege` stays | Medium | t | t | t | t | NV | NV |
| Read-contained token: user SID + Administrators deny-only, `DISABLE_MAX_PRIVILEGE`, no restricting SIDs, default DACL on the logon SID (+ optional Low IL), sandbox root outside the profile | **SUPPORTED** (Experiment A, variants v4 and v5) | Profile, `.claude`, APPDATA reads refused; writes outside the root, HKCU, other roots, pipes refused; Low IL also refuses VM_READ of same-user processes | Node `spawn` with piped stdio fails (`EPERM`); DPAPI still works; tools and config must live in the root; worktrees must be created in the root | Medium: root DACL + per-run cleanup | t (script runs; spawn pipes fail) | t | NV | NV | NV | NV |
| **Token L**: `DISABLE_MAX_PRIVILEGE`, user SID enabled, no restricting SIDs, Low IL; Low-labeled roots (third round) | **SUPPORTED** (D1, D3, D4) | Writes, HKCU, Run key, scheduled tasks, same-user process memory, control pipe refused; piped spawns, named pipes, PowerShell, Git all work | Reads of unlabeled places and Credential Manager stay open | Low to medium: labels + launcher | t | t | NV | NV | NV | NV |
| **NO_READ_UP mandatory label** (Medium, NW\|NR\|NX, OI\|CI) on a protected list, no admin | **SUPPORTED** on a scratch tree (D2); real user folders NOT VERIFIED | Reads, listing, deletion, relabel by token L refused for 2,002 files; hard links keep it | Copies made elsewhere are unlabeled; a missed folder stays readable; labels persist after a crash | Medium: sweep, removal, large-tree timing | t | t | NV | NV | NV | NV |
| Git linked worktree with four paths labeled Low (`.git\worktrees\<name>`, `objects`, agent ref and log namespace) | **SUPPORTED** (D4) | Commit on own branch; other branches, tags, config, hooks refused | Object store writable by the agent; check with `git fsck` before merging | Medium | NV | t | NV | NV | NV | NV |
| Same, with restricting SIDs (synthetic, logon, Everyone, Users, RESTRICTED) (v1) | **SUPPORTED**, no advantage over v4 | Same assertions; VM_READ of same-user processes ALLOWED (logon SID matches the default process DACL) | Same | Medium | t | t | NV | NV | NV | NV |
| Same, without the logon SID, alternate desktop with a synthetic-SID DACL (v2) | **INCOMPATIBLE** | n/a | node, git, npm, pnpm die with `0xC0000142` (window station access needs the logon SID); python still runs | n/a | t (fails) | t (fails) | NV | NV | NV | NV |
| Job `NetRateControl` (JobObjectNetRateControlInformation) | **NOT AVAILABLE** as a control: call succeeds without admin, no throttling observed | none observed | none | Low | t | NV | NV | NV | NV | NV |
| AppContainer (no capability), sandbox root outside the profile granting the package SID | **EXPERIMENTAL** | Outbound TCP refused (`EACCES`); profile reads refused; no admin to create or launch | Node runs inline code only (`lstat C:\` refused for scripts); loopback to outside listeners still open; stdio-pipe spawn hangs; git fails in work dirs | High | t (inline only) | t (fails) | NV | NV | NV | NV |
| LPAC | **INCOMPATIBLE** (one probe) | Stronger than AppContainer | Python fails at start | High | NV | NV | NV | NV | NV | NV |
| Alternate desktop | **SUPPORTED** | Message attacks on user windows; recommended by Microsoft | none seen for console tools | Low | t | t | NV | NV | NV | NV |
| Named-pipe DACL (user SID only, no Everyone/AC) + no-read-up label | **SUPPORTED** | Keeps restricted, Low and AppContainer processes off the control pipe | none | Low | t | n/a | n/a | n/a | n/a | n/a |
| Mitigation / child-process policy | **NOT VERIFIED** | Exploit hardening / no children for leaf workers | Several policies break V8/Python (d) | Medium | d | d | d | d | d | d |
| Dedicated user + firewall | **NOT VERIFIED** (needs admin; not tested; per Codex reports) | Reads, writes and per-account network | Admin once; profile and auth provisioning | High | d | d | NV | d | NV | NV |
| Windows Sandbox | **NOT VERIFIED**, unchanged | VM-grade | Single instance; no persistent tools | Very high | d | d | NV | NV | NV | NV |
| `CreateProcessInSandbox`-style OS API | **NOT AVAILABLE** | n/a | n/a | n/a | | | | | | |
| Win32 App Isolation | **NOT AVAILABLE** for arbitrary executables (preview, packaged apps) | n/a | n/a | n/a | | | | | | |
| MXC / September 2026 update sandbox | **NOT VERIFIED** | unknown | unknown | unknown | | | | | | |

## Recommendation

Revised after the third round. Earlier rounds' recipes stay in the document as evidence.

**No-admin tier, "ISOLATED-L" (the recommendation):** job + token L + Low-labeled roots + NO_READ_UP labels on a protected list + a user-only/no-read-up pipe.

1. **Launcher** (C# built with the in-box `csc.exe`, shipped as a prebuilt exe through electron-builder `extraResources`): `SetErrorMode(0x8003)`, a job per run (kill-on-close, no breakaway, process and memory limits, UI limits `0xFF` incl. `READCLIPBOARD`), child created suspended, std handles inherited, exit code relayed, job terminated on exit (Experiment C).
2. **Token L:** `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)` of the user's token, user SID **enabled**, no restricting SIDs, integrity Low. Why this one: it is the only candidate where Node/Git/Python/npm/pnpm/PowerShell all pass **including piped-stdio spawns and named pipes** (D1).
3. **Roots:** a per-run directory with an inheritable **Low** label (`icacls /setintegritylevel (OI)(CI)L`) holding the clone/worktree, `HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP` and caches. Tools are copies in the root or live in `Program Files`. The directory may be inside the project folder or elsewhere; it does not need to be outside the profile at this tier.
4. **Protected list:** each sensitive folder gets an inheritable Medium label with **NO_WRITE_UP | NO_READ_UP | NO_EXECUTE_UP** through `SetNamedSecurityInfoW` (no admin; about 7,000 files per second measured; existing and new children are covered; removal is the same cost). Candidates: `%USERPROFILE%\.claude`, `.codex`, `.ssh`, `.gitconfig`, `.npmrc`, `.aws`, browser profiles, NEXUS's own data directory, other repositories. Applied to the user's real folders this was **not tested** (scratch tree only); labels persist after a crash, so the product needs a startup sweep and an uninstall removal, and a large tree (the home directory hang of the first round came from an ACL propagation over the whole profile) needs measuring before use.
5. **Control pipe:** DACL for the user SID only, plus a no-read-up label at Medium (refuses Low, write-restricted and AppContainer clients; D3).
6. **Git:** per-task clone or linked worktree inside the Low root; `.git\worktrees\<name>`, `.git\objects` (or the clone's own store), `refs\heads\<agent-namespace>` and `logs\refs\heads\<agent-namespace>` labeled Low; everything else in the main repository stays Medium. Verified (D4): the agent commits on its own branch and cannot move or delete other branches, create tags, change the shared config or add hooks. Check repository integrity before merging, since the object store is writable.

**What this tier contains (measured):** process tree and limits; writes outside the Low roots (profile, other Medium folders, HKCU, Run key, scheduled tasks); reads of the protected list; the memory of same-user processes (`VM_READ` denied at Low); the NEXUS pipe; clipboard reads (with the job UI limit); PowerShell and every Node child-process pattern still work.

**What it does not contain, stated plainly:**
- **Reads outside the protected list.** A Low process reads any Medium file without a NO_READ_UP label: a copy of a sensitive file made elsewhere, a file the list missed, `%USERPROFILE%` generally. HKCU is readable.
- **Credential Manager** (17 generic credentials were enumerable) and **DPAPI** decryption for the user.
- **All network**, outbound and loopback: no user-level control worked (job rate control inert; AppContainer breaks script loading and still reaches loopback).
- System and `Program Files` reads (needed to run).
- Anything the agent can persuade the user to approve.

**The only route found that closes both the read gap and the network gap** is a separate Windows identity (a dedicated local account with a clean profile) plus Windows Firewall rules scoped to it. Both need administrator rights once (account creation, logon right, rules). That is the design Codex's elevated mode is reported to use, and this machine already has a `CodexSandboxUsers` group, which shows such accounts can exist here. It was not tested.

**Weaker tiers:**
- *RESTRICTED:* job + privilege-stripped token (`DISABLE_MAX_PRIVILEGE`), redirected temp, no labels. Or the write-restricted token `wr2` (Probe 3), which needs ACEs and breaks piped spawns.
- *Read-contained, strict (variant v5 of Experiment A):* deny-only user SID + Low + root outside the profile. Stops all reads of the profile without a protected list, but piped-stdio spawns and in-sandbox named pipes fail, which rules it out for development work. Keep it only for commands known not to spawn with pipes.

**Delivery vehicle:** unchanged. A small C# launcher built with the in-box .NET Framework `csc.exe`, shipped via `extraResources` (outside `asar`), started as the normal user from any path including paths with spaces. koffi and native C/Rust/Go were not available or not needed. The Agent SDK's `spawnClaudeCodeProcess` is the hook; a real SDK session through it, and `claude.exe` / `codex exec` under token L, are NOT VERIFIED.

**Can reads of the user profile be stopped without admin?** Partly. By label, for a named list, yes (D2). Entirely, only with the strict token (v5), at the price of piped spawns. Not by Low IL alone.

## NOT VERIFIED

- Third round: labels on the user's real folders (`.claude`, `.ssh`, browser profiles) and their timing at real size; crash and uninstall removal of labels; `claude.exe` and `codex exec` under token L; Playwright/Electron under token L; reading the Credential Manager values (only the count was taken); a drive-root or `C:\Windows` alternative for the Low root; why a moved-in file was already denied before the refresh pass.
- Shutdown paths (`shutdown.exe`, `InitiateSystemShutdownEx`) under privilege removal and `UILIMIT_EXITWINDOWS`; privilege presence only was checked.
- Breakaway flag behavior and tools that call `AssignProcessToJobObject` (claude, codex, pnpm, Git `bash`); real sessions of `claude.exe` and `codex exec` under any token, and especially under the read-contained token (spawn with pipes fails there); Codex's own sandbox nested inside a NEXUS token or job.
- Playwright Chromium and Electron under any identity; alternate desktop with windowed children.
- A real Agent SDK session through `spawnClaudeCodeProcess` and the launcher (piped stdio and exit-code relay were verified with Node).
- A top-level `C:\NexusSandboxProbe` root; Authenticated Users in the restricting list; the read-contained token with Git `bash`, PowerShell (not launched under it), Playwright, `claude.exe`, `codex`.
- Why the net rate control is inert; why AppContainer loopback was open; the odd interaction of a package-SID ACE with a Low-labeled tree; LPAC with grants; a drive-root ACE for AppContainer.
- Low integrity combined with a write-restricted token; real cache locations at Low and write-restricted.
- Dedicated user and firewall, Windows Sandbox/`wsb`, WDAC/AppLocker, MXC, whether the September 2026 updates add an OS primitive, Win32 app isolation status after 2025.
- Signed vs unsigned helper behavior, SmartScreen/MOTW, and quarantine from the installed location.
- Performance beyond start-up overhead; mitigation and child-process policies.
- The OpenAI Codex article itself (403) and the exact Codex sandbox implementation.

## Sources

Microsoft Learn: Job Objects; Nested Jobs (linked from it); Restricted Tokens; AppContainer isolation; Win32 app isolation overview (preview, 24H2); Windows Sandbox CLI.
Chromium: `docs/design/sandbox.md`. VS Code: "Sandbox agent terminal commands" (agent-sandboxing). OpenAI, "Building a safe, effective sandbox to enable Codex on Windows" (403 to the fetch tool), with secondary write-ups: discuss.pytorch.kr thread, codex.danielvaughan.com articles, elevenforum.com. Microsoft Learn on enabling loopback for Windows Runtime apps (hh780593) via search results (not read in full). XDA Developers on MXC (secondary).
Local: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`spawnClaudeCodeProcess`, `pathToClaudeCodeExecutable`), `electron-builder.yml`.
