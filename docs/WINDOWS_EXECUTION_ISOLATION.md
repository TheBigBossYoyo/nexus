# Windows Execution Isolation: Research

Research and recommendation. Date: 2026-10-05. Nothing in this document is implemented. No source code was changed
and no experiment was run for it: every statement about Windows behavior comes from the sources listed at the end
or from the author's prior knowledge, and each claim that could not be confirmed is marked **NOT VERIFIED**.

## Position of 0.7 and earlier

**0.7 implements none of this as containment.** Agent sessions, and every process they start, run as the user, in
the user's logon session, at the user's integrity level, with the user's privileges, in the Electron main process's
process tree and under no job object of NEXUS's own. `docs/SECURITY.md` ("Known gaps: No OS sandbox") states the
same for 0.6.

**0.7's static inspection is not a sandbox.** The command classifier (`command-classifier.ts`) and the 0.7 file and
command inspection read the text of a command before it runs. They cannot see what a script, test runner, build
tool or `python -c` / `node -e` does once started, and a writing agent can write a program and run it. A forbidden
command is stopped only if the classifier recognizes it. Nothing stops the operating system call itself.

What NEXUS does today for process ownership: `killProcessTree` in `src/main/modules/process/run-process.ts` runs
`taskkill /pid <pid> /T /F`. `taskkill /T` follows the parent-process-id relationship. A descendant whose parent has
already exited is no longer reachable through that relationship. That a surviving orphan escapes `taskkill /T` is
documented behavior of the tool as the author knows it; it was **NOT VERIFIED** on this machine for this document.

## What is being contained

The agent is `claude.exe` (Claude Agent SDK 0.3.288) or `codex exec`. These processes start `git`, `node`, `pnpm`,
`python`, PowerShell and `bash` (Git for Windows), which start further processes (compilers, test runners, install
scripts, dev servers). The threats this research looks at, from `docs/SECURITY.md` and the readiness report:

| Threat | Example |
|---|---|
| T1 Process escape | A child outlives its session, survives `taskkill /T`, keeps running after a run is cancelled |
| T2 Writes outside the worktree | A script writes to the user's repository, home directory or another worktree |
| T3 Registry writes | A script changes `HKCU` keys (Run keys, environment) |
| T4 Network | A script reaches any host, or the loopback services of the machine |
| T5 Power | `shutdown`, `shutdown /a` run by a script (the classifier cannot see inside scripts) |
| T6 Resource exhaustion | Fork loop, memory exhaustion that takes down NEXUS and the machine |
| T7 Credentials and other processes | Reading another process's memory, reading the user's tokens, files, SSH keys |

No Windows mechanism covers all of these at the user level. The table at the end maps mechanism to threat.

## Mechanisms

### 1. Job Objects

A job groups processes so they can be limited and terminated together.

- **Process-tree ownership.** After `AssignProcessToJobObject` the association cannot be broken, and by default every
  child created with `CreateProcess` joins the job. Membership does not depend on the parent-process-id chain, so an
  orphaned grandchild is still in the job. Source: Microsoft, "Job Objects".
- **Kill on close.** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: closing the last handle terminates every process in the
  job. If the owner (NEXUS) crashes, the OS closes its handles and the job's processes die. This is the one property
  that makes a crash of NEXUS not leave agent processes behind. `TerminateJobObject` kills the job on demand.
- **Breakaway.** A child can leave the job only if the job sets `JOB_OBJECT_LIMIT_BREAKAWAY_OK` (and the parent passes
  `CREATE_BREAKAWAY_FROM_JOB`) or `SILENT_BREAKAWAY_OK`. If neither is set, breakaway is impossible and
  `AssignProcessToJobObject` calls from inside the tree fail. Tools that expect to put their own children in a job
  can fail because of that; which of the tools here do so is **NOT VERIFIED**.
- **Limits.** Active-process count (`ActiveProcessLimit`), per-process and job memory limits
  (`JOB_OBJECT_LIMIT_PROCESS_MEMORY`, `JOB_OBJECT_LIMIT_JOB_MEMORY`), CPU rate control, working set, priority, time
  limits. These address T6.
- **UI restrictions** (`JOBOBJECT_BASIC_UI_RESTRICTIONS`): `JOB_OBJECT_UILIMIT_EXITWINDOWS` blocks `ExitWindows` and
  `ExitWindowsEx`; `UILIMIT_HANDLES` blocks use of USER handles of processes outside the job; clipboard read and
  write, desktop creation and switching, display settings, system parameters, global atoms can be blocked.
  `EXITWINDOWS` blocks calling `ExitWindowsEx` from the job. Whether it stops all shutdown paths is **NOT VERIFIED**:
  `shutdown.exe` is a program that runs in the job and the documentation lists only the `ExitWindows` functions, so
  an `InitiateSystemShutdownEx` call (which is what `shutdown.exe` is commonly understood to use) is not covered by
  that flag on the documentation's evidence. Privilege removal (below) is the control that addresses T5.
- **Nesting.** Windows 8 and later allow a process to be in several jobs in a hierarchy. Closing a nested job with
  kill-on-close terminates its processes and those of its child jobs. This matters because Electron itself, or a
  process that launched NEXUS (a terminal, a CI agent, an installer), may already be in a job. On Windows 7 and
  earlier this fails; those versions are out of scope (NEXUS requires Windows 11 per `README.md`).
- **What it does not stop.** Writes (T2), registry (T3), network (T4), credentials (T7). A job is an ownership and
  resource tool, not an access-control tool.
- **Edition, admin.** Any Windows edition, no administrator rights.
- **Compatibility.** Node's `child_process`, `git`, `pnpm`, `python`, PowerShell and bash run normally inside a job
  that allows no breakaway. Detached children are still in the job. The risk is a tool that insists on breakaway or on
  its own job; **NOT VERIFIED** for `claude.exe`, `codex`, pnpm and Git for Windows' MSYS2 `bash`.
- **Performance.** Negligible per process creation. No measurement was made (**NOT VERIFIED**).
- **Implementation from Node/Electron.** Node has no job-object API. Starting a child inside a job from Node needs
  one of: a small native helper executable that creates the job, starts the agent in it and waits (a handoff at
  `spawn`); a foreign-function layer (koffi) to call `CreateJobObjectW`, `SetInformationJobObject`,
  `AssignProcessToJobObject`; or PowerShell with `Add-Type` P/Invoke. A process started by Node and assigned to a job
  after `spawn` has a window in which it can already have started children that are not in the job; closing it needs
  `CREATE_SUSPENDED` (which Node's `spawn` does not expose) or creating the child from the helper. The helper
  approach closes the window.
- **Testability.** High. A test spawns a tree (including a process that detaches and a grandchild whose parent
  exits), kills the owner, and asserts that no process of the tree is alive. `IsProcessInJob` and
  `QueryInformationJobObject` can assert membership and limits.

### 2. Restricted tokens (CreateRestrictedToken)

A restricted token is a copy of the user's token with fewer rights. It can (a) remove privileges, (b) mark SIDs
deny-only, (c) add a list of restricting SIDs. With restricting SIDs the system makes two access checks, one with the
token's enabled SIDs and one with the restricting SIDs, and grants access only if both pass. Source: Microsoft,
"Restricted Tokens".

- **Privileges.** `SeShutdownPrivilege` ("Shut down the system") is required to shut down the local system;
  `SeRemoteShutdownPrivilege` is the remote variant. A token created with `DISABLE_MAX_PRIVILEGE`, or with those
  privileges listed for deletion, cannot enable them. This addresses T5 for the Win32 shutdown API; it does not stop a
  process from asking an unrestricted process (a service, a scheduled task, NEXUS) to do it. Whether an ordinary
  non-elevated user's `shutdown /s` needs the privilege held in the process token is the author's understanding;
  the Microsoft constants page confirms only the privilege's purpose. The behavior of `shutdown.exe` under a token
  without the privilege was **NOT VERIFIED** by running it.
- **Deny-only SIDs.** Marking `BUILTIN\Administrators` deny-only prevents use of an elevated group membership for
  allow decisions. For a standard user the gain is small. Marking the user's own SID deny-only breaks reads of the
  user's profile, which breaks dev tools.
- **Restricting SIDs / write-restricted.** `WRITE_RESTRICTED` applies the second check to write access only.
  Reads then work as the user; writes succeed only where the DACL grants write to one of the restricting SIDs (for
  example a synthetic SID added to the worktree's ACL). This is the design that Codex's own Windows sandbox is
  reported to use (see "Interaction with Codex" below). It covers T2 and T3 (HKCU writes need the restricting SID in
  the key's ACL; they will fail), not T4.
- **No administrator needed** to create a restricted version of the caller's own token and start a process with
  `CreateProcessAsUser`: Microsoft states `SeAssignPrimaryTokenPrivilege` is not required in that case.
- **Desktop caveat.** Microsoft notes restricted applications should run on a desktop other than the default one, to
  stop `SendMessage` / `PostMessage` attacks on unrestricted windows. Agents are console processes with no window,
  but a script can create windows (T7). Chromium uses an alternate desktop for this reason. Cost: an extra
  desktop and `lpDesktop` in `STARTUPINFO`.
- **Compatibility.** Reads continue as the user. The write-restricted variant requires every legitimate write
  location to carry an ACE for the restricting SID: the worktree, the temp directory, `%LOCALAPPDATA%\pnpm`, the npm
  cache, `~/.claude`, `~/.codex`, the Python cache, Git's `.git` of the shared repository (worktree administrative
  data lives there), `%TEMP%`. Each of those is a grant of write to a location outside the worktree; the grant is the
  attack surface. Subtle breakage (named pipes, mutexes, `CreateFileMapping` in the global namespace) is possible and
  **NOT VERIFIED** for these tools.
- **Performance.** Negligible at run time. Setup cost is in ACL edits.
- **Implementation.** `CreateRestrictedToken` and `CreateProcessAsUserW` are not reachable from Node without a
  native layer. Same options as Jobs. A native helper is the practical way, and it can do job plus token in one place.
- **Testability.** High: in a test, try `shutdown /s /t 60` (then `/a`) and a write outside the root, from the
  restricted process, and assert failure. The shutdown test must be built so that a failure to block does not shut
  the machine down (use `shutdown /s /t 3600` followed by `/a`, or call `InitiateSystemShutdownEx` with a long delay and
  abort), and run on a disposable machine first.

### 3. Low integrity level (mandatory integrity control)

MIC compares the integrity level of the process with that of the object before the DACL is checked. Default policy on
objects is no-write-up; unlabeled objects count as Medium. Source: Microsoft, "Mandatory Integrity Control".

- **Writes.** A Low process cannot write to Medium objects even when the DACL allows it. It can write to objects
  labeled Low (for example `%USERPROFILE%\AppData\LocalLow` and folders explicitly relabeled), and to its own objects.
- **Reads.** The default label policy is no-write-up only: a Low process can read what the DACL lets the user read,
  including the user's files, SSH keys and tokens, unless an object also carries no-read-up. Low IL is therefore not
  a confidentiality control (T7 reads not covered).
- **Registry.** The same rule applies to keys: writes to `HKCU` keys that carry the default (Medium) label fail; keys
  in the `Low` integrity branch can be written.
- **Process control.** A Low process cannot open higher-integrity processes for write-like access, and the page states
  that Low processes cannot get access to a process in an AppContainer.
- **Network, power.** Not restricted. `SeShutdownPrivilege` is a token privilege, independent of integrity level; a
  Low token keeps its privileges unless they are also removed (**NOT VERIFIED** for a standard user's Low token).
- **Process creation.** A new process gets the minimum of the user's level and the file's level; a Low-labeled
  executable starts at Low. For an agent, the token's level must be lowered by NEXUS (`SetTokenInformation` with
  `TokenIntegrityLevel` on a duplicated token) and the process started with `CreateProcessAsUser`.
- **Compatibility.** Poor for this workload without ACL work. Low IL breaks writes to the user profile caches the tools
  rely on: `%LOCALAPPDATA%\pnpm` and the pnpm store, the npm cache (`%APPDATA%\npm-cache` / `%LOCALAPPDATA%\npm-cache`),
  `~/.claude`, `~/.codex`, the Python and pip caches, `%TEMP%` (the Low temp is a different directory from the
  Medium temp), Git's own config writes, and the worktree itself (it is a Medium-labeled tree, so the agent could not
  write the task it exists to do). Each of those must be relabeled Low (`icacls /setintegritylevel`), which turns them into
  writable locations for every Low process of the user, and which also makes `claude.exe`'s own state writable by
  other Low code. That the worktree needs relabeling is a direct consequence of the MIC rule above; the specific list of
  caches is the author's, **NOT VERIFIED** by running each tool at Low IL.
- **Edition, admin.** Any edition. Lowering one's own token does not need administrator rights. Relabeling objects
  owned by the user does not either (`SeRelabelPrivilege` is needed only to raise a label above one's own level).
- **Implementation.** Same native helper requirement as Restricted tokens.
- **Testability.** Good: `icacls` shows labels; a Low process's failed write is a plain exit code.

### 4. AppContainer and LPAC

An AppContainer process has a package SID and capability SIDs, runs at Low IL, and gets access only where a DACL
grants access to its package SID or capability SIDs (for both the user and the AppContainer principals; the effective
access is the intersection). Source: Microsoft, "Launch an AppContainer" and "AppContainer isolation".

- **Files and registry.** No access to the user's profile unless ACLs grant the package SID. Regular AppContainers
  are granted some system files, registry keys and COM objects (through the "ALL APPLICATION PACKAGES" group); LPAC opts
  out of that group (`PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT`) and needs explicit capabilities (for
  example `registryRead`, `lpacCom`) even for what a regular AppContainer already has.
- **Network.** No network without the `internetClient` (or related) capability. Loopback is blocked for AppContainers
  by design and needs an exemption per container SID (`CheckNetIsolation LoopbackExempt`, or
  `NetworkIsolationSetAppContainerConfig`); the loopback exemption is a machine-level setting and, per the search
  results used, needs administrator rights. The need for administrator rights and the exact behavior on Windows 11 build
  26200 are **NOT VERIFIED**. Consequence for NEXUS: localhost inter-process traffic that dev servers and test runners
  use is blocked unless exempted.
- **Process and window isolation.** Other processes' handles, windows and credentials are unreachable. This covers T7
  better than any other user-level mechanism listed here.
- **Power.** The AppContainer token has no shutdown privilege in the sense that it cannot call into the shell, but this
  was **NOT VERIFIED**.
- **Profile.** `CreateAppContainerProfile` creates a profile directory and redirects `LOCALAPPDATA`, `TEMP` and `TMP`
  under `...\AppData\Local\Packages\<name>\AC`. Tools that expect the real profile (`~/.claude`, pnpm, npm, git
  config) will find an empty one.
- **Compatibility.** Poor without substantial ACL work. Each of Node, Git for Windows (MSYS2 runtime), pnpm (store on
  another volume, hard links), Python and `claude.exe` assumes read access to the user profile, `Program Files`, the
  Windows directory, system registry keys and the loopback network. Granting the package SID access to the
  directories needed (Git for Windows, Node, the toolchains, the worktree, the shared `.git`) is a per-machine
  inventory problem. How `claude.exe` (a bundled runtime) and `codex.exe` behave inside an AppContainer was **NOT
  VERIFIED**. A signed-in agent also needs the network (the model API): `internetClient` allows outbound traffic to
  anything on the Internet, so AppContainer's network control is coarse (all or nothing, plus intranet and server
  capabilities). Per-host control needs the firewall (below).
- **Edition, admin.** All editions, Windows 8 and later. Creating a profile and launching needs no administrator rights
  by the documentation reviewed. Granting ACLs on directories the user owns needs none; on `Program Files` it needs
  administrator rights (usually already readable through ALL APPLICATION PACKAGES).
- **Performance.** Process start is slightly slower; file access has an extra check. Not measured.
- **Implementation.** Higher than the above: profile creation, capability SIDs, `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`,
  `STARTUPINFOEX`, ACL grants, loopback handling. A native helper is mandatory; a koffi layer is possible but
  struct-heavy.
- **Testability.** Medium. Behavior depends on installed software and machine ACLs; tests need a matrix.
- **Win32 App Isolation** (a packaging path to AppContainer-based isolation for Win32 apps) needs Windows 11 24H2
  (build 26100) or later and packaging (MSIX, Visual Studio 17.10.2 or later) per the Microsoft materials found.
  It is aimed at isolating an application that the developer ships, not at launching arbitrary tools. Status
  (preview or general availability) in October 2026 is **NOT VERIFIED**; the sources found date from 2023 to 2024.

### 5. Windows Sandbox (.wsb)

A disposable virtual machine with its own kernel under the Microsoft hypervisor. Source: Microsoft, "Windows
Sandbox".

- **Editions.** Pro, Enterprise, Pro Education/SE and Education. Not supported on Windows Home. The optional feature
  must be enabled, which requires administrator rights and, on most systems, a restart; hardware virtualization must
  be available (Microsoft's page names no further hardware here; the exact list was not extracted, **NOT VERIFIED**).
- **Isolation.** Strong for T1 to T4 and T7: the guest has its own processes, filesystem and registry. Networking is on
  by default and can be turned off in the `.wsb` configuration; folders from the host are mapped in, and can be read-only.
  Closing the sandbox discards everything.
- **Limits.** Currently only one instance at a time (Microsoft states it does not allow multiple instances), which
  conflicts with parallel agent sessions. Applications are not shared: Git, Node, pnpm, Python, `claude.exe` and the
  agent's authentication must be installed or mapped in each time, and credentials would be in the guest. Start-up is
  seconds, memory is shared with the host through smart memory management. Mapped folders are a write path to the
  host: writes to a mapped writable folder are real, so the worktree mapping is a deliberate hole.
- **Compatibility.** Tools run as in a clean Windows. The agent's sign-in state does not exist in a fresh sandbox.
  Interaction with NEXUS's session monitoring (the main process talks to the SDK child through stdio) is not
  possible across the VM boundary without a channel; the design is an open question.
- **Implementation.** Generated `.wsb` plus `WindowsSandbox.exe`; no programmatic channel for commands except a
  `LogonCommand`; the machinery for NEXUS to drive many agents through it does not exist and is large.
- **Testability.** Medium; slow tests; needs a machine with the feature enabled.
- **Conclusion.** Not suitable as the per-task containment of a multi-agent orchestrator in this form (single
  instance, no programmatic control, no persistent tool state). It remains a sensible manual tool for a user to
  inspect a hostile repository by hand.

### 6. Filesystem ACL-based temporary execution roots

Run the agent as a different identity, or with a SID that is granted write only in a per-run root.

- **Dedicated local user.** One or more local accounts (for example `NexusAgent`) that own nothing in the user's
  profile. The agent runs under that account (`CreateProcessWithLogonW` or `LogonUser` plus `CreateProcessAsUser`,
  which need the account's credentials and, for `CreateProcessAsUser` with a fresh token, privileges NEXUS's process
  does not have as a standard user: `SeAssignPrimaryTokenPrivilege`, `SeIncreaseQuotaPrivilege`; `CreateProcessWithLogonW`
  avoids that). ACLs on the worktree grant the account modify rights; the user's profile grants it nothing, so T2 and
  most of T7 are covered by default-deny, and the registry of `HKCU` is the account's own. **Creating the account and
  setting ACLs needs administrator rights once** (an elevated setup helper). This is the design that Codex's elevated
  Windows sandbox is reported to use (see below).
- **Per-run ACLs on the user's own account.** Add an ACE for a per-run synthetic SID on the worktree and use a
  write-restricted token (mechanism 2). No new account and no administrator rights, but the process still reads
  everything the user can read.
- **Network.** A dedicated account also allows user-scoped Windows Firewall rules (the account's SID in a rule's
  local user list), which is the only way in this list to get per-account network policy without a driver. Creating
  firewall rules needs administrator rights.
- **Compatibility.** Tools find an empty profile for the dedicated account. Authentication state for `claude.exe`
  (`~/.claude`) and `codex` (`~/.codex`) would need to be provisioned into the account's profile, with the credential
  exposure questions that raises. The agent also needs the user's Git identity, repo access and tools found on the
  user's PATH; PATH entries under the user's profile (scoop, `%LOCALAPPDATA%` installs, as on this machine) are unreadable
  by another account unless granted. How much of that is workable is **NOT VERIFIED**.
- **Edition, admin.** Any edition; administrator rights for setup. Domain-joined and managed machines may forbid the
  account.
- **Implementation.** High: an elevated installer or first-run step, account lifecycle, password storage (DPAPI under
  the user, or a random password rotated per run), ACL management with inheritance, cleanup after a crash. A native
  helper is again the practical route.
- **Testability.** Good for the file rules (ACL assertions and negative writes), harder for the setup and cleanup
  paths.

### 7. Process mitigation policies

`SetProcessMitigationPolicy` (on oneself) and `PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY` (at creation, applies to a
child and cannot be changed after start) switch exploit mitigations: DEP, ASLR, dynamic-code prohibition, Win32k
system-call disable, binary-signature requirement, image-load restrictions (no remote images, no Low-label images),
extension-point disable, CFG, CET, FSCTL system call disable. Source: Microsoft, `UpdateProcThreadAttribute`.

- **What they stop.** They harden a process against exploitation of itself. They do not stop a legitimate program from
  writing files, spawning children, using the network or registry. They are not an agent-containment mechanism.
  Several (dynamic code prohibition, block non-Microsoft binaries, Win32k disable) would break Node (V8 JIT), Python
  extension modules and Git for Windows tools outright. `IMAGE_LOAD_NO_LOW_LABEL` is useful only in combination with
  Low IL, to stop a Low process from loading DLLs it wrote there.
- **Child-process policy.** `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY` with `PROCESS_CREATION_CHILD_PROCESS_RESTRICTED`
  (Windows 10 and later) makes the new process unable to create child processes. Microsoft's remarks state that this
  becomes a property of the token, and that it is only effective in sandboxed applications such as AppContainer that
  ensure privileged process handles are not accessible; a process that can reach another process handle with
  `PROCESS_CREATE_PROCESS` or `PROCESS_VM_WRITE` may bypass it. **That makes the flag unsuitable as a standalone
  control**, and unusable for the agent itself, which exists to start `git`, `node` and the rest. It is usable for a
  leaf worker (for example a process that only runs one checked command and must not fork), together with a token that
  denies access to other processes.
- **Edition, admin.** None.
- **Implementation.** Same as other creation-time controls (native helper); `SetProcessMitigationPolicy` on oneself
  could be called from the helper before it starts the agent.
- **Testability.** High for the policies themselves, but the policies defend against a different threat.

### 8. Windows Firewall / WFP for network control

Windows Filtering Platform and the Windows Firewall can block outbound traffic per application path, per user SID or
per AppContainer package SID. Creating rules needs administrator rights. Rules keyed to the user's own SID would
also block NEXUS and the browser, so per-process network policy for a user-level agent needs a different identity
(a dedicated account or an AppContainer). Per-host allow-lists (only the model API) require rules by address, with the
maintenance cost of address changes, or a local proxy with the agent forced through it; the latter is outside
what a firewall rule alone enforces. Whether Windows Firewall can express "only this process may reach these
hosts by name" without an address list: **NOT VERIFIED** (it works with addresses, FQDN-based rules exist in
Defender for Endpoint tooling; their availability on Windows 11 client without management was not confirmed).

### 9. Other candidates, briefly

- **Hyper-V VM / WSL2 / Docker.** A full VM or a Linux container gives strong isolation and a different OS. The agent
  would run Linux tools against a Linux checkout; NEXUS is a Windows product for Windows repositories (Git for Windows,
  PowerShell, `.exe` toolchains). Hyper-V needs Pro or higher and administrator rights. Out of scope for a worker
  model that must run Windows tooling; a possible future option for repositories that are Linux-first.
- **Dev Drive.** A ReFS-based volume (Windows 11) with a trust designation and Microsoft Defender "performance mode",
  reported to improve build performance by up to 30 percent in Microsoft's materials. It is a performance and
  filter-configuration feature, not an isolation mechanism. A dedicated Dev Drive volume could, however, serve as
  the single parent for worktrees, which makes one ACL root and one cleanup point; that use is an idea, not a
  documented feature. Its relation to ACLs, relabeling and AppContainer grants is **NOT VERIFIED**. Creating one
  needs administrator rights.
- **Win32 App Isolation.** See the AppContainer section. It targets packaged apps; not a fit for launching third-party
  CLI tools.
- **Windows Defender Application Control / AppLocker.** Control which executables may run. Machine policy, administrator
  rights, not per-session. Mentioned for completeness only; **NOT VERIFIED** and not evaluated.

## Interaction with Codex

OpenAI describes a Windows sandbox for Codex that uses restricted tokens, synthetic SIDs and ACLs on the working
directory; an "elevated" mode adds dedicated local sandbox users, an elevated setup helper, and user-scoped firewall
rules. This is reported by the OpenAI engineering article and by several third-party write-ups found by search;
the third-party ones were not cross-checked against the Codex source, and the exact behavior of the installed Codex
version was **NOT VERIFIED**. The consequence for NEXUS is a nested-sandbox question: `codex exec` may itself create
restricted tokens for the commands it runs, and its restricted tokens and ACL edits may fail or behave differently if
NEXUS has already placed the Codex process under Low IL, an AppContainer or its own restricted token. A job object
that allows no breakaway is the least likely to interfere; whether Codex tries to assign its children to its own job
(which would fail inside a no-breakaway job, unless nested jobs apply) is **NOT VERIFIED**. NEXUS must test the pairing
before it enables any token-level layer for the Codex provider.

## What each mechanism stops

Y = stops it by design. P = partially, or only in combination. N = does not address it. ? = NOT VERIFIED.

| Mechanism | T1 process escape | T2 writes outside root | T3 registry | T4 network | T5 power | T6 resources | T7 other processes, credentials |
|---|---|---|---|---|---|---|---|
| Job object (kill on close, no breakaway) | Y | N | N | N | P (UI limit EXITWINDOWS only; `shutdown.exe` path ?) | Y (process count, memory, CPU) | P (UI handle limit) |
| Restricted token, privileges removed | N | N | N | N | P (removes SeShutdownPrivilege; ? for all shutdown paths) | N | N |
| Restricted token, write-restricted with a synthetic SID | N | Y (where ACLs are set) | Y (writes) | N | P | N | N for reads |
| Low integrity | N | P (blocks Medium-labeled objects, not Low) | P | N | N | N | N for reads; P for process access |
| AppContainer / LPAC | N | Y | Y | Y (capability; loopback blocked by default) | ? | N | Y |
| Windows Sandbox | Y | Y | Y | Y (configurable) | Y (guest only) | P | Y |
| Dedicated local user with ACLs | N | Y | Y | P (with firewall rules) | P (? by default rights of a standard account) | N | Y for the user's profile |
| Mitigation policies | N | N | N | N | N | N | N (exploit hardening only) |
| Child-process restricted | P (needs AppContainer-like handle isolation) | N | N | N | N | P | N |
| Firewall / WFP rules | N | N | N | Y (needs admin; needs another identity to be per-agent) | N | N | N |

## What each mechanism costs

| Mechanism | Windows edition | Admin needed | Breaks Node, Git, pnpm, Python, claude, codex | From Node/Electron | Testable |
|---|---|---|---|---|---|
| Job object | All | No | Unlikely; breakaway behavior ? | Native helper, koffi or PowerShell P/Invoke; helper closes the suspended-start window | High |
| Restricted token (privileges only) | All | No | Unlikely; ? | Native helper (needs `CreateProcessAsUser`) | High |
| Restricted token (write-restricted + ACLs) | All | No | Writes to caches and profile fail until ACLs are granted | Native helper plus ACL edits | High |
| Low integrity | All | No | Breaks user-profile cache writes and the worktree until relabeled | Native helper plus `icacls` | Good |
| AppContainer / LPAC | All (Win 8+) | No for launch; likely for loopback exemption ? | Breaks most dev tools without ACL and loopback work; claude and codex ? | Native helper, heavy | Medium |
| Windows Sandbox | Pro, Enterprise, Education; not Home | Yes (enable feature) | Needs full tool install and sign-in inside; single instance | `.wsb` generation; no programmatic channel | Medium, slow |
| Dedicated local user | All | Yes, once | Profile, PATH, auth state must be provisioned | Elevated native helper | Good |
| Mitigation policies | All | No | Several break Node and Python outright | Native helper | High, wrong threat |
| Firewall / WFP | All | Yes | None, if identity exists | Elevated setup | Medium |

## Implementation routes from a Node/Electron app

NEXUS has no native addon today (`package.json` has no ffi or native module; it depends on Electron 44.5.1 and the
Claude Agent SDK 0.3.288). Options:

1. **A small native helper executable** (C, C++, Rust or Go), signed with the app, shipped in the installer. NEXUS spawns
   it with the command to run; it creates the job, creates the (restricted) token, starts the agent suspended, assigns
   it to the job, resumes it, relays the exit code, and exits when its parent dies. Pros: closes the start-up window,
   the only place that can use `CREATE_SUSPENDED` and `STARTUPINFOEX` attributes, one auditable component, can be tested
   alone, no Node ABI issues. Cons: a second build toolchain, a signed binary to ship and keep out of
   antivirus quarantine (see the memory note on Bitdefender and Electron binaries; whether a new native helper would
   be flagged was **NOT VERIFIED**), process-start indirection.
2. **koffi** (MIT license, prebuilt binaries for Windows x64, supports structs and callbacks per its documentation;
   Electron compatibility was not stated in the page read, **NOT VERIFIED**). Pros: no extra executable. Cons: the
   start-up window of `child_process.spawn` followed by `AssignProcessToJobObject` cannot be closed from Node;
   `CreateProcessW` must be called through koffi to get a suspended start, which means re-implementing process creation
   and pipe plumbing outside Node's `child_process` and so also outside the Agent SDK's own spawn of `claude.exe`
   (the SDK starts its child itself; whether it accepts a custom spawn function or executable wrapper is **NOT VERIFIED**).
3. **PowerShell with `Add-Type` P/Invoke.** Needs no addon, but each launch compiles C# (slow, flagged by endpoint
   security tools) and the same start-up window problem exists. Suitable for a research prototype only.

The SDK launching `claude.exe` itself is the main constraint: containment must wrap or follow that spawn. A helper that
is passed as the SDK's executable (a wrapper that creates the job, then runs the real `claude.exe` inside it) is
the lowest-friction place to start if the SDK supports an executable override; that is **NOT VERIFIED**.

## Recommended 0.8 direction

The prior in the request: job object with kill-on-close first, then a restricted token without `SeShutdownPrivilege`
and a child-process or ACL-scoped write root, with AppContainer as research. The evidence supports it, with changes.

1. **Layer 1, job object with kill-on-close, no breakaway, with process-count and memory limits.** Argued for:
   user-level, any edition, no administrator rights; the only mechanism here that addresses T1 and T6 and that fixes
   the real gap in the current `taskkill /T` approach; its failure mode (a tool that wants its own job) is
   observable and testable; it is the least likely to conflict with Codex's own sandbox. It does not contain writes,
   registry, network or power, and 0.8 must not describe it as a sandbox. Include `JOB_OBJECT_UILIMIT_EXITWINDOWS` and
   `UILIMIT_HANDLES` as cheap extras, with the caveat on shutdown above.
2. **Layer 2, a token without `SeShutdownPrivilege` and `SeRemoteShutdownPrivilege`** (and other unneeded
   privileges), created with `CreateRestrictedToken`, no restricting SIDs yet. Argued for: addresses the specific
   known open HIGH finding (an agent can run `shutdown` through a script) at low compatibility cost, because it
   changes no access check on files. Acceptance depends on a test of the actual `shutdown.exe` and
   `InitiateSystemShutdownEx` paths, which has not been run (**NOT VERIFIED**).
3. **Layer 3, write-restricted token with a per-run synthetic SID and ACLs on the worktree, temp directory and a short
   list of cache directories** (the route Codex is reported to use, without a dedicated user). Argued for as the next
   step for T2 and T3, **against enabling it by default until** each provider and tool has been run through it on the
   test matrix, because every cache location that needs an ACE is also a place an agent can write outside the
   worktree. Argued **against** low integrity as a primary mechanism: it protects only against writes to Medium
   objects, breaks the caches listed above, and needs relabeling that opens the same locations to every Low process.
4. **AppContainer / LPAC: a research track only.** The isolation is the strongest of the user-level options, and the
   cost is the highest: loopback is blocked by default, the profile is redirected, system-wide tool installs need
   ACL grants, and neither `claude.exe` nor `codex` has been run in one. It should be evaluated in a time-boxed spike
   against a fixed matrix of commands (git, node, pnpm install, pytest, `claude.exe` with its network, `codex exec`)
   and kept only if the matrix passes. The spike's result is a decision, not a feature.
5. **Dedicated local user with firewall rules**: a second research track, valuable chiefly for network control (T4),
   the one threat nothing user-level covers. It needs administrator rights once and a provisioning story for the
   agent's credentials; both are product decisions for the owner.
6. **Not recommended for 0.8:** Windows Sandbox (single instance, no programmatic channel), mitigation policies as a
   containment control, the child-process-restricted flag for the agent itself, Hyper-V or WSL2 as the general worker.

Delivery vehicle: a native helper executable, because it is the only route that closes the process-start window and
that can later carry layers 2 and 3 in the same place. koffi is acceptable for a prototype that only creates a job
and assigns a process, if the SDK's spawn cannot be wrapped.

Everything above must be presented to users as process-tree ownership and partial hardening, not as a sandbox, until
a hostile-repository test campaign (see `docs/V0_8_PROPOSAL.md`) has run against each layer.

## Not verified

- The exact behavior of `shutdown.exe` and `InitiateSystemShutdownEx` under (a) `JOB_OBJECT_UILIMIT_EXITWINDOWS` and
  (b) a token without `SeShutdownPrivilege`, on this machine's Windows 11 build.
- That `taskkill /T` leaves an orphaned grandchild alive (the documented semantics follow the parent-id relation;
  not run here).
- Whether `claude.exe`, `codex`, pnpm or Git for Windows' `bash` call `AssignProcessToJobObject` or use breakaway.
- Behavior of Node, Git, pnpm, Python, `claude.exe` and `codex` at Low IL, in an AppContainer or LPAC, or under a
  write-restricted token; the cache list in the Low IL section.
- Whether Codex's own sandbox works inside a NEXUS job, token or container.
- Whether the AppContainer loopback exemption needs administrator rights, and its behavior on Windows 11 build 26200.
- Windows Sandbox hardware requirements beyond the edition list.
- Whether the Claude Agent SDK accepts a custom spawn function or executable wrapper.
- Whether Electron 44 supports koffi; whether a native helper is quarantined by Bitdefender on this machine.
- Windows Firewall rules by host name on client editions; WDAC and AppLocker (not evaluated).
- Win32 App Isolation status in October 2026; Dev Drive relation to relabeling.
- Performance figures for every mechanism (none measured).
- The Codex Windows sandbox details beyond what the OpenAI article and third-party write-ups state.

## Sources

Microsoft Learn: Job Objects (`win32/procthread/job-objects`); JOBOBJECT_BASIC_UI_RESTRICTIONS; Restricted Tokens
(`win32/secauthz/restricted-tokens`); Mandatory Integrity Control; AppContainer isolation; Launch an AppContainer;
Privilege Constants; UpdateProcThreadAttribute (mitigation and child-process policy); Windows Sandbox overview;
Win32 app isolation overview; Dev Drive overview. Chromium sandbox design document (`docs/design/sandbox.md`: restricted
token, job object, alternate desktop, integrity level). OpenAI, "Building a safe, effective sandbox to enable Codex on
Windows", with third-party write-ups (secondary, not cross-checked). koffi documentation (koffi.dev). Search results on
AppContainer loopback and `CheckNetIsolation`.
