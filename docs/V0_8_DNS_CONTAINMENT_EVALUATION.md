# 0.8: closing DNS and direct network exfiltration under the isolated profile

Measured on 2026-10-12, Windows 11 Pro 25H2 build 26200.9457, on the development machine. Every statement
marked *measured* was run; scripts and raw outputs are in `test-results/dns-exp/` (not committed: scratch).

## What is open

Under ISOLATED the contained process is another account with outbound and inbound firewall rules of its own.
Its own packets are blocked (measured before: TCP, HTTP, DNS over UDP). Two things are not:

1. **Names.** A name looked up through Windows is asked on the network by the DNS Client service, not by the
   process. Measured as the account: `ping <name>` gets the address, `[Net.Dns]::GetHostAddresses` and
   `Resolve-DnsName` answer. A name is a message to whoever answers for its zone, and the answer is a message
   back: a channel in both directions that no firewall rule for the account sees.
2. **The DNS cache of the machine.** `ipconfig /displaydns` as the account prints the service's cache: the
   names the user's own programs looked up recently.

## One bounded cycle on the account and its token: nothing holds

| Tried | Result (measured) |
|---|---|
| RPC filter (`netsh rpc filter`, layer um, block) on the resolver interface `45776b01-5956-4485-9f80-f428f7d60129`, condition on the account's token, made by the elevated setup | Created and listed by Windows with both conditions. Lookups and the cache: unchanged. |
| The same filter with no condition at all (everybody), for 20 seconds | Lookups and the cache as the account: unchanged. The filter does not reach local RPC to this service on this build. A condition cannot do better than none. |
| Groups of the token made deny-only (interactive, console logon, authenticated users, this organization, local account, LOCAL, NTLM) | Unchanged. With Everyone deny-only the process does not start. |
| The process at untrusted integrity instead of low | `ping` still resolves, the cache is still printed; `whoami` and PowerShell no longer start. |

No Windows-enforced way was found that leaves the containment what it is. The filter is not shipped; the
machine has none left (removed by its key). Per the owner's rule the experimenting stops here.

## AppContainer

### Conventional AppContainer, no capability (measured, as the user)

A process started with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, an AppContainer SID derived from a name,
and an empty capability list:

| Probe | Result |
|---|---|
| `ipconfig /displaydns` | "cannot display the DNS resolver cache" |
| `ping <fresh name>` (getaddrinfo) | host not found |
| `[Net.Dns]::GetHostAddresses` | unknown host |
| `Resolve-DnsName` (DnsQuery) | access denied |
| `nslookup` (its own packets) | no servers available |
| `curl http://1.1.1.1/` | exit 7, no connection |
| `curl http://<name>/` | exit 6, could not resolve |
| `curl http://127.0.0.1:<listener of the user>/` | 200 |

So an AppContainer without a network capability closes both open things across the APIs tried, and still
reaches a listener on the loopback, which is where NEXUS's proxy listens. (That the loopback is reached without
a loopback exemption is as measured on this machine, which runs a third-party firewall product; it has to be
measured again on a machine with Windows Firewall alone before anything relies on it.)

### Composed with the NexusSandbox account (measured, with a scratch copy of the launcher)

The launcher's first step unchanged (the user starts the second step as the account, on a desktop of its own),
the second step adds the AppContainer attribute when it starts the command. Result: the same table as above,
as `nexussandbox`, at low integrity, with child processes (cmd starting whoami, ipconfig, ping, PowerShell,
curl) working, files written in the task directory, Node running (`dns.lookup` → `ENOTFOUND`, loopback → 200).

What it took, each found by a failure:

- **The account's Windows profile must be loaded** (`LOGON_WITH_PROFILE`). Without it there is no place for
  the AppContainer's profile: `CreateAppContainerProfile` fails with 0x80070002 and so does the start of the
  process. Today the account is logged on without a profile on purpose (its home is a directory of the
  session). Loading it creates `C:\Users\NexusSandbox` once and costs time at each start.
- **`LOCALAPPDATA` (and the profile variables) in the command's environment**: without them process creation
  fails with 203. Today the environment is an allowlist without them.
- **An access entry for the AppContainer's SID on everything the command touches**: the task directory, the
  mirrored tools, the desktop of the command. A grant to the account alone is no longer enough: an AppContainer
  needs both.
- **Not the user's window station.** Giving the AppContainer an entry on `WinSta0` (so that its children
  could open it) broke the start of every Chromium-based application in the user's session for as long as the
  entry was there: GPU and renderer processes crashed at start (measured: NEXUS's own end-to-end run failed
  from that moment, and passed again once the entry was removed). The command needs a window station of its
  own, or its children must reach the desktop another way. This is unsolved in what was measured: with the
  entry removed, child processes inside the AppContainer were not measured again.

What does **not** work in it (measured):

- **Git Bash.** `bash.exe` of MSYS2 dies at start: `NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0...)` is
  refused. The MSYS2 runtime keeps its shared state in a named-object directory an AppContainer may not create.
  NEXUS's Bash tool, and "git as the user" inside the containment, run on it.
- **git.exe on a path whose parents the AppContainer cannot look at.** `git init` under
  `C:\ProgramData\NexusSandbox\worktrees\…` fails with "Invalid path 'C:/ProgramData': Permission denied": git
  looks at each parent directory, and an AppContainer has no entry on `C:\ProgramData`. Microsoft's own tool
  for this (below) has an elevated step that adds minimum entries for AppContainers on the system drive for
  exactly this.
- Not measured: npm through the proxy, an Electron application under test inside an AppContainer (Chromium
  starts its own sandboxed children there), PowerShell's file provider (one probe failed with "drive not found"
  for `FileSystem`), handle and pipe use by the Claude agent's tools.

### The Windows API for this: `processmodel.dll`

This build has it. Exports found (measured, by reading the file): `Experimental_CreateProcessInSandbox`,
`Experimental_CreateProcessAsUserInSandbox`, `Experimental_QuerySandboxSupport`,
`Experimental_CompileSandboxSpecificationInternal`, `Experimental_FreeSandboxSpecification`, and a second,
newer family without the prefix: `CreateProcessSecurityEnvironment`,
`CreateProcessAsUserInsideSecurityEnvironment`, `QueryProcessSecurityEnvironmentSupport`,
`IsProcessSecurityEnvironmentVersionSupported`.

From Microsoft's documentation of the experimental pair (read, not run): the sandbox is described by a
FlatBuffer; with `app_container = true` it is an AppContainer whose profile is named by the caller; file access
is granted by path (read-only and read-write lists, applied by a bound-filesystem policy, not by access
entries); the network is closed unless a capability is given, and a proxy URL can be set for the container;
the integrity level is low; a job with UI limits is made. Limits stated there: **handles are not inherited**
(`inheritHandles` must be FALSE), so the command's output cannot come back over inherited pipes as it does
today; a caller that is itself in an AppContainer is refused; the header is not public; "experimental and
subject to change". The `AsUser` form takes a token, which is how it would compose with the NexusSandbox
account; the launcher's second step, which already is that account, could also call the plain form.

From Microsoft's open-source project that uses it (`microsoft/mxc`, MIT, 1.0.0 released 2026-10-07; read, not
run): it calls the newer family ("process security environment"), needs Windows 11 24H2/25H2 at build 9278 or
later (this machine: 9457), puts a per-container filter on egress that allows the container to connect to one
loopback proxy endpoint and nothing else (which would also close "services on the loopback can be reached",
the other stated limit of ISOLATED), and **falls back to a conventional AppContainer** where the API is not
there. It ships an elevated host-preparation tool for the two compatibility problems met above and one more
(entries for AppContainers on the system drive root; the security of `\Device\Null`). Its documentation says
nothing about DNS; that has to be measured, not assumed.

Not done: calling either family. The specification format of the newer one is in that repository; the older
one's compiler function has no published signature, and calling it blind was not worth a crash in a process
that holds the user's session.

## Assessment

- **DNS and the cache are closed by an AppContainer without a network capability.** That is the one mechanism
  measured to do it, and it composes with the NexusSandbox account, the worktree grants and the loopback
  proxy.
- **It is not a setting: it changes what runs inside.** Git Bash does not start in it, git needs entries on
  parent directories, the account needs its profile, every grant needs a second entry, and the window station
  question is open. Each of these is a piece of the launcher, the setup, the tool mirror or the Bash tool.
- **The experimental API must not be the only boundary.** It exists on current builds only, its first form is
  marked experimental and already has a successor, and it does not inherit handles. Its place, if any, is as
  the preferred way where `QueryProcessSecurityEnvironmentSupport` says it is there (it brings the per-container
  proxy-only filter), with the conventional AppContainer, which is plain documented Windows since 8, as the
  way everywhere else and the one the acceptance is run on. That is also how Microsoft's own project is built.
- **Git Bash is the hard part.** Three ways, none measured yet: a POSIX shell that needs no MSYS2 runtime for
  the Bash tool inside the containment (busybox-w32 is one native build); running the Bash tool's shell
  outside the AppContainer and only its children inside; or an AppContainer capability or named-object
  arrangement that lets MSYS2 make its directory. "git as the user" already runs as the user, outside.

## What this means for 0.8

Direct DNS exfiltration under ISOLATED is not closed, and is not closable without the change above. 0.8 stays
PARTIAL.

## Outcome (2026-10-12, evening): the isolated profile runs in an AppContainer

Built, and measured on this machine. What the evaluation above left open, and how each ended:

| Question | Answer (measured) |
|---|---|
| Does the account need its Windows profile? | Yes. Without it no process starts in the AppContainer ("file not found"); the launcher logs the account on with its profile and registers the AppContainer for it once. The removal script takes the profile away again, found by the account's identifier. |
| The window station | Nothing to do: Windows already lets AppContainers into it (ALL APPLICATION PACKAGES). No entry is added, ever. |
| Folders above the sandbox root | The AppContainer could not even ask whether `C:\` exists: cmd refused unquoted paths, Node failed with `EPERM lstat 'C:\'`, git with "unable to get current working directory". The setup adds one entry each on the drive's root and on `C:\ProgramData`: read and list that folder itself, inherited by nothing. |
| An entry for the AppContainer's own SID | **Must not be used on files.** A folder whose access list names an AppContainer is refused to every low-integrity process that is not in one (measured on a scratch folder and, by mistake, on `C:\` for a quarter of an hour). An entry for a capability does not do this, and Windows' own entry on `C:\` is of that kind. The AppContainer therefore holds one capability of NEXUS's own (no meaning to Windows), and every access entry names that capability. |
| Integrity labels inside an AppContainer | **They do not bind.** A process in the AppContainer read a file labeled "no read from below" and overwrote one labeled "no write from below". Inside the isolated profile only the capability's entries decide: the root gives it reading, NEXUS gives writing per session directory, the user's repository gives it nothing. |
| Git Bash | Not used. The shell is busybox-w32 (ash), a native program, inside the AppContainer; `tests/integration/isolation/shell-semantics.test.ts` lists what it does and what it refuses. |
| git on the user's repository | Not from inside: git looks at every folder above the repository, in the user's profile. A git inside a longer command is told to run alone; git alone runs as the user (the restricted mechanics), as before. |
| Node | `spawn`, `exec` and `fork` with a pipe hung: libuv before 1.53.0 names its pipes outside `\.\pipe\LOCAL\` and retries for ever when refused. Fixed upstream on 2026-09-24; no Node release has it yet. The sandbox's own copy of node.exe has the one name pattern replaced (same length). A program that brings its own libuv is not reached by this. |
| Electron under test | Starts, loads a page and is captured, with `--no-sandbox` (which NEXUS already passed). |
| The loopback | Reached, with and without the exemption the setup registers. Whether a machine without the exemption would refuse it could not be measured here. |
| Names and the cache | Refused in every way tried: the resolver (ping), .NET, DnsQuery (`Resolve-DnsName`), nslookup, curl by name, Node `dns.lookup` and `dns.resolve4`, a fresh name, `ipconfig /displaydns`. Asserted by the containment tests and by NEXUS's own check at every start: an isolated profile for which a name is looked up is reported as not holding. |

The Windows process-security-environment API (`processmodel.dll`) was not needed and is not used.
