# NEXUS 0.9: hardening ledger

Started 2026-10-13 on `nexus-0.9-production-proof` (from `main` at `ab54281`, tag `v0.8.0`). One list for
everything 0.8 left open and everything 0.9 finds: the limits 0.8 stated, what the first restart showed, what
0.8 did not try, and the findings of the reviews. Each line has one disposition and, when it is closed, the
commit and the evidence that closed it.

Dispositions: **FIX_IN_0_9** (changed in this release, with a test), **PROVE_SAFE** (not changed; evidence that
it holds), **DOCUMENTED_PRODUCT_LIMIT** (stays; said where the user meets it), **EXTERNAL_DEPENDENCY** (needs
something NEXUS or its owner does not have), **DEFER_TO_POST_1_0**.

A CRITICAL or HIGH weakness is never deferred to reach PASS. PASS needs 0 CRITICAL, 0 HIGH and 0
release-material MEDIUM open.

State: OPEN, IN PROGRESS, CLOSED (with commit), STATED (a limit, written where it belongs).

## A. The limits 0.8 stated

| # | Limit | Disposition | State | Notes |
|---|---|---|---|---|
| A1 | Every ISOLATED session holds the same capability: nothing but convention keeps one session out of another's directories | FIX_IN_0_9 | CLOSED for writing and for processes (`f0868b6`, `tests/integration/isolation/cross-session.test.ts`); OPEN for reading | A capability per session, derived from the session, granted on its directories only; made and removed deterministically; swept after a crash. Two hostile sessions at once as the test (also cross-repository: section 28 of the brief) |
| A2 | After git alone has run as the user for a session, the repository's `objects` directory stays writable to other low-integrity processes of the user; existing objects can be overwritten and git serves them | FIX_IN_0_9 | OPEN | An object store of the task's own, so that nothing an untrusted process can write is later read as committed history; what NEXUS takes into the user's repository is verified first |
| A3 | No walk of the worktree for links before the user's git stages it | FIX_IN_0_9 | OPEN | Defence in depth: reparse points of any kind, a changed `.git` pointer or entry; nothing followed; refused when in doubt |
| A4 | The launcher's AppContainer code was not read by a second reviewer | FIX_IN_0_9 | IN PROGRESS | Independent review started 2026-10-13 (three reviewers, section E) |
| A5 | The package configuration reader was not read by a second reviewer | FIX_IN_0_9 | IN PROGRESS | Same |
| A6 | The change to the sandbox's node.exe was not read by a second reviewer | FIX_IN_0_9 | IN PROGRESS | Same; and the change becomes a bounded compatibility policy (A8) |
| A7 | A restart of Windows had not been observed | PROVE_SAFE | CLOSED for one restart (`e002f34`) | `docs/acceptance/v09-first-real-reboot-2026-10-13.md`: ISOLATED available by itself, 0 prompts. More restarts in the matrix (B3) |
| A8 | The sandbox's node.exe is changed in one place for libuv < 1.53 | FIX_IN_0_9 | OPEN | `SandboxNodeCompatibilityPolicy`: version and capability probe, known pattern only, NEXUS's own copy only, output verified, provenance recorded, no change when the Node carries the fix, unknown binary refused |
| A9 | A program with a libuv of its own (Electron's main process, a Node a project installs) hangs on a child with a pipe inside ISOLATED | FIX_IN_0_9 for detection; EXTERNAL_DEPENDENCY for the cure | OPEN | `RuntimeCompatibilityProbe` and a stored profile: the hang becomes a stated refusal or a brokered equivalent. The cure is libuv 1.53 in the runtime the project uses. Never run outside the containment |
| A10 | busybox ash has no bash arrays | DOCUMENTED_PRODUCT_LIMIT | STATED | The refusal says what to do; its wording is reviewed with the error messages (D7) |
| A11 | A git inside a longer command is refused under ISOLATED | DOCUMENTED_PRODUCT_LIMIT | STATED | Same |
| A12 | RESTRICTED is not a containment against hostile code | DOCUMENTED_PRODUCT_LIMIT | STATED | Said in the security model and where a project runs Restricted |
| A13 | The installer was never run for a release; install, upgrade, uninstall, reinstall untested | FIX_IN_0_9 | OPEN | Release gate of 0.9 |
| A14 | Signing, antivirus and SmartScreen behaviour unknown | PROVE_SAFE for antivirus and SmartScreen (observed, recorded); EXTERNAL_DEPENDENCY for a certificate | OPEN | No certificate is owned: a blocker of public distribution, not of the local release. The signing step is made ready |
| A15 | A setup that fails after the password was reset was exercised once only | FIX_IN_0_9 | OPEN | Failure injected at each step after the reset; the stored password must follow the account's |
| A16 | Whether the startup task keeps the Mount Manager entry over time | PROVE_SAFE | IN PROGRESS | Reboot matrix (B3) |
| A17 | Loopback services other than NEXUS's proxy are reached from ISOLATED | DOCUMENTED_PRODUCT_LIMIT | STATED | Windows does not filter the loopback for an AppContainer with the exemption the proxy needs. To be weighed again by the final review |
| A18 | A forged commit-graph in the object store: what it makes NEXUS's git do is not established | FIX_IN_0_9 with A2 | OPEN | With an object store of the task's own, NEXUS's git reads no commit-graph a task wrote; asserted |
| A19 | A filter or driver from the user's own global git configuration can be selected by a worktree's `.gitattributes` when NEXUS stages | FIX_IN_0_9 | OPEN | To be confirmed by the review; if it holds, staging runs with no filter and no driver from any configuration |
| A20 | Whether a machine without the loopback exemption refuses the proxy was not measured | PROVE_SAFE | OPEN | Measured during the uninstall and reinstall runs, when the exemption is absent |

## B. What the first restart showed (2026-10-13)

| # | Finding | Severity | Disposition | State |
|---|---|---|---|---|
| B1 | The startup task leaves no record of its result: after a restart nobody can say whether it restored the entry, found it, or failed | LOW (availability and evidence; the application notices a missing entry by using the profile) | FIX_IN_0_9 | OPEN: the script writes one result file where only the system and administrators write and everybody reads; the application shows it |
| B2 | An ordinary user cannot read the task: the application tells "there" from "not there" and nothing more | LOW | FIX_IN_0_9 with B1 and the versioned security state (D3) | OPEN |
| B3 | A fast startup does not run the task (the entry survives with the restored kernel); a resume from hibernation is unobserved | — | PROVE_SAFE | OPEN: reboot matrix: full start, fast startup, hibernation, NEXUS running at shutdown, entry absent |
| B4 | About 200 old copies of the launcher in `C:\ProgramData\NexusSandbox\bin` | LOW (growth) | FIX_IN_0_9 | OPEN: copies no instance uses are removed at start |
| B5 | Windows lists "NEXUS 0.7.0" as installed, from an earlier installer test | — | FIX_IN_0_9 with A13 | OPEN: accounted for before the installer runs |
| B6 | The installed bootstrap script differs from the repository's in line endings | LOW | FIX_IN_0_9 with D3 | OPEN: the setup copies bytes; the installed script is checked by hash |

## C. What 0.8 did not try (`V0_8_RELIABILITY.md`)

| # | Not tried | Disposition | Where in 0.9 |
|---|---|---|---|
| C1 | A soak of hours; a soak under ISOLATED; memory growth of the runtime | FIX_IN_0_9 | Soak with thresholds fixed beforehand |
| C2 | A kill of the runtime while an application under test runs | FIX_IN_0_9 | Crash campaign |
| C3 | The elevated setup failing halfway | FIX_IN_0_9 | A15 |
| C4 | The setup started from the window, on the released version | PROVE_SAFE | Clean-install run (one elevation prompt, announced) |
| C5 | A machine without Edge, without Git for Windows, another Git version | DOCUMENTED_PRODUCT_LIMIT unless the installer run shows otherwise | Compatibility check at start, stated requirement |
| C6 | Worktree and repository on different volumes or a share | PROVE_SAFE or DOCUMENTED_PRODUCT_LIMIT | Path diversity tests |
| C7 | Disk full in the sandbox root; the root removed while NEXUS runs | FIX_IN_0_9 | Disk pressure tests on a bounded volume |
| C8 | Other Windows versions | DOCUMENTED_PRODUCT_LIMIT | One machine is available; said |
| C9 | The runtime when Windows is out of memory | DEFER_TO_POST_1_0 | Cannot be produced safely on the owner's machine; the leftover check after a reaped run is kept |

## D. What the 0.9 brief adds as work of its own

| # | Item | Disposition |
|---|---|---|
| D1 | The startup task reviewed as a privileged component; tampering tested | FIX_IN_0_9 |
| D2 | busybox-w32 (GPL-2.0): license, notices and corresponding source with any build given to anybody | FIX_IN_0_9 |
| D3 | A version of the sandbox setup the application can judge: old, current, partial, tampered; states HEALTHY, REPAIR_AVAILABLE, UAC_REQUIRED, TAMPERED, UNSUPPORTED | FIX_IN_0_9 |
| D4 | Build manifest, checksums, bill of materials, release layout, verified runtime assets | FIX_IN_0_9 |
| D5 | Database backup before a migration; restore; downgrade refused | FIX_IN_0_9 |
| D6 | Diagnostic bundle, recovery path without the window, supportability document | FIX_IN_0_9 |
| D7 | Error messages of the states a user meets | FIX_IN_0_9 |
| D8 | Secrets in logs; paths in exports meant for sharing | FIX_IN_0_9 |
| D9 | Flaky tests named with frequency and cause; heavy suites scheduled so that they do not fail each other | FIX_IN_0_9 |

## E. Findings of the reviews

The second independent review (launcher and capabilities; setup, removal and startup task; package
configuration reader; path checks; node.exe; shell; trusted git and its object store; network, research and
browser; the runtime's pipe; grants and automatic resumption; unattended work) was started on 2026-10-13 on the
0.8.0 source. Its findings are entered here as they arrive, each with: id, hypothesis, source, evidence,
severity, confidence, reproduction, resolution, state.

### How the review went (2026-10-13, on the 0.8.0 source)

Four independent readers, each given the code and a threat model and not the author's conclusions:

- **G** (trusted git, its object store, the package configuration reader, path checks, the change to node.exe):
  complete. Reproduced its git and reader findings against the real code; could not start a contained process,
  so what contained code can write was derived from access lists.
- **N** (network, research, browser, the runtime's pipe, grants and resumption, unattended work): complete, with
  pure-function probes, a live probe of the proxy on the loopback and about 80 classifier variants.
- **W1** (launcher, capabilities, setup, startup task, shell): **cut off.** The session was stopped by the
  provider's safety filter after its first finding had been delivered. It had run contained probes and the
  containment tests (29/29). Nothing was done to get around the stop.
- **W2** (the same scope as W1): a second reader, reading only (code and access lists of the machine; nothing
  launched). Complete. What it reports is confirmed by reading or marked plausible; nothing of it was measured
  by the reader. So the launcher and the setup have now been read by a second party, and not attacked by one
  beyond W1's interrupted probes: said in the release report as it is.

Severity as the reviewer gave it unless a note says otherwise. RM = release-material.

### CRITICAL

| ID | Finding | Source | Confidence | State |
|---|---|---|---|---|
| G-I-1 | A speculative candidate's clone is trusted by its `.git/config` alone. A task that redirects `.git/commondir`, or replaces `.git` by a pointer to a repository it made, has NEXUS's own git (the user, not contained) run a filter program of its choosing at `add -A`: code execution as the user from inside the containment. Needs a run with the SPECULATIVE or ADAPTIVE strategy and 2 or more candidates | `git-service.ts` (trustedFor, assertOwnGitDir, assertPlainCloneConfig), `orchestrator/speculation.ts:268` | Reproduced through the real `GitService.addAll` (two variants) | OPEN, first to fix |

### HIGH

| ID | Finding | Source | Confidence | State |
|---|---|---|---|---|
| W1-F1 / G-G-1 | Contained code of any session could write the sandbox's shared tools (the shell, the Node copy): the capability had an entry of its own to write on `tools` | The machine's access list; `execution-broker.ts:612` | Measured by W1; the entry read by G and by the author | CLOSED `ded0121`: the entry is taken away before the profile is judged; every start tries to write there from inside; test with a planted entry |
| W2-F1 | One capability for every session and project: a session writes another's temp, home and worktree, can change the script another is about to run, poison a project's package cache, and read every worktree, spec and verification scratch | `execution-broker.ts:478-501`, `setup-sandbox.ps1:142` | Confirmed by reading and by the access lists | CLOSED for writing and for processes (`f0868b6`): a capability per session and per project, the command's process and what it creates closed to other sessions; two hostile sessions at once as the test. **OPEN for reading**: a session still reads another's worktree. Carried to the next release as MEDIUM |
| W2-F2 | The inner spec of a contained command (its command line and whole environment) lies in `specs`, readable by every contained process, and stays when the launcher is killed: 48 were found | `nexus-launch.cs:361-403`, `execution-broker.ts:995` | Confirmed by reading and on the machine | CLOSED as far as leaving it behind goes (`f0868b6`): the second step deletes it as soon as it has read it, before the command exists; test. The folder is still readable for the instant between writing and reading: with the reading above |

### MEDIUM

| ID | Finding | RM | State |
|---|---|---|---|
| N-K-1 | A URL an agent names on the research tools is an unattended way out for what the session read; the limits the documents promised were not in the code; budgets per host name | yes | CLOSED `3194d1c` |
| N-K-2 | The native `WebFetch`/`WebSearch` of read-only roles (a setting, off by default): the host is judged by its text only (`localtest.me` passes), the broker is not asked, no budget | yes | OPEN |
| N-L-1 | Answering a boundary request for the whole mission, and leaving the enrollment, need no native confirmation: whoever holds the pipe's token can grant | yes | OPEN |
| N-K-3 | The dependency proxy opens any port of an allowed host and has no total limit; `github.com` as a whole is allowed | no (a stated limit), fixed for ports and totals | OPEN |
| W2-F3 | The elevated scripts compile and load code from the user's TEMP (`Add-Type`), and run `netsh -f` on a file written there | yes | OPEN |
| W2-F4 | The elevated scripts write their result where the user writes (a link there overwrites any file); from a source checkout they run scripts a user can change | yes | OPEN |
| W2-F5 | The password file's access list is set after the file is written, and the result of setting it is not checked | yes | OPEN |
| W2-F6 | `%LOCALAPPDATA%\NexusSandbox` inherits its access list: on this machine other principals can replace the credential blob or the record | yes | OPEN |
| W2-F7 | Entries given on a user's repository are recorded after they are made; a crash between leaves entries nothing takes back, the removal included | yes | OPEN |
| W2-F8 | The launcher (which holds the account's password) and its second step start with the worktree as current directory: a library planted there could be loaded | yes | HALF: the second step starts in the launcher's own folder (`e3b5543`); the first step still starts in the worktree. OPEN |
| W2-F9 | A command for `cmd` passes the check for shell operators when they are inside single quotes or in an argument without spaces | yes (the promise is false, though inside the containment) | OPEN |
| W2-F10 | The launcher accepts an ISOLATED spec without an AppContainer | yes | CLOSED `e3b5543`: refused |
| W2-F12 | The removal deletes the sandbox root recursively, elevated, through a tree contained code wrote | yes | OPEN |
| G-J-1 | The sandbox reads the whole Git directory of the user's repository, `config` included (addresses with tokens) | yes | OPEN |
| G-E-1 | The package configuration reader prints a line without `=` as a key: a token alone on a line is shown | yes | OPEN |
| G-G-2..3, W2-F15 | The Node copy is keyed by path only, never checked again, a failed change is kept for ever; any `node.exe` on PATH is copied | with A8 | OPEN |

### LOW (fixed where it is cheap; the others stated)

N-M-1 grants of a project outlive its enrollment · N-M-2 resumption matches on text an agent wrote · N-M-3 a
mission-wide grant on "any" shows only the first action · N-N-1 a shorter final delay is not an escalation ·
N-N-2 the list of secret file names is short · N-N-3 the window's content policy lacks three directives ·
N-N-4 a link's text can differ from its target · N-L-2 sixteen unauthenticated connections hold the pipe ·
G-I-2 `fetch` from a candidate's clone unchecked · G-E-2 short path segments and bare values of host fields
are printed · G-E-3 `constructor=x` makes the reader throw · G-J-2 what low-integrity code of the user can
write in a granted repository (A2) · W2-F11 the firewall rule is removed before the new one is made ·
W2-F13 the second step is identified by its name and started later · W2-F14 208 launcher copies; the cleanup
can take a live instance's (B4) · W2-F16 the contained environment names the real user · W2-F17 the password is
not wiped from memory · W2-F18 an unchecked resume; exit codes 120 to 127 are ambiguous · W2-F19 desktop
details · W2-F20 `C:Windows` (CLOSED) · W2-F21 no deny-logon rights for the account · W2-F22 the sweep leaves
worktrees (523) and trusts names · W2-F23 NEXUS writes through directories contained code could replace ·
W2-F24 the root is made, then closed.

Each gets its disposition when it is taken up; the table of closed items is kept below.

### Closed

| ID | Commit | Test |
|---|---|---|
| N-K-1 | `3194d1c` | `tests/unit/network/exfiltration.test.ts` |
| W1-F1 / G-G-1 | `ded0121` | `containment.test.ts`, "writes nothing where every session reads" |
| W2-F20 | the commit after `4660a2b` | lint |
| G-I-1 (CRITICAL) | `ecf3a80` | `tests/integration/git/worktree-pointer-trust.test.ts`: both ways the review reproduced, a per-worktree configuration, other object stores, and the honest clone |
| G-I-2 | `ecf3a80` | same file: the fetch is from the clone's Git directory with every object checked |
| N-K-2 | the commit "fix(security, K-2)" | `tests/unit/policies/authorizer.test.ts`, "WebFetch and what a name resolves to" |
| N-L-1 | `1fd60a0` | `tests/integration/persistence/autonomy-handlers.test.ts`, `unattended.test.ts` |
| N-N-1, N-N-3, N-K-3 (ports) | `a58ba4c` | `tests/unit/network/policy.test.ts` for the ports; the other two by reading |
| G-E-1, G-E-2, G-E-3 | `6417b00` | `tests/unit/policies/package-config.test.ts`, four cases from the review |

Decided and not changed: **N-K-3, the total** (the dependency proxy is one for the whole runtime: a total for
all sessions would stop honest work after enough installs; a connection that sends more than 4 MiB is still
cut; a proxy per session, with a total of its own, goes with the per-session capability). **N-M-2** (the text an
agent writes can name a request it was told about: the effect is a restart of its own task, at most three, with
no authority beyond the grant; stated). **N-K-1's "a host never seen"** (a question for every new host would
bring back the interruptions 0.8 removed).

## F. Carried from 0.7.2 through 0.8 (`V0_8_DEFERRED_FINDINGS_TRIAGE.md`)

| ID | What | Disposition in 0.9 |
|---|---|---|
| campaign arm for AUTO's depth | Evidence for the default depth | FIX_IN_0_9 (the Arena campaign), or a stated evidence limit if the harness cannot carry Programs and Workspaces |
| 13.5 rest | AUTO with plan approval and a stale specification | FIX_IN_0_9 (a test) |
| 3.9, 10.7 | Advisory leases not capped; routing records and checkpoints never pruned | Decided by the soak: release-material if growth is unbounded at its scale |
| R.12 | A reviewer's finding waits for an answer nobody gives | Decided by the Program acceptance: release-material if it interrupts an unattended run |
| 5.5, 9.4, 10.4 | Fallback field in the routing record; a waiting session counted; text of provider requests in the inspector | DEFER_TO_POST_1_0 (no claim of 0.9 depends on them); 10.4 is taken up again under provider privacy as a statement of what is sent |
| 6.5, 8.4, 9.6 | Prompt size: uncapped older section, text twice | Measured by the token work of 0.9; changed only with a campaign that shows no loss of quality |
| 8.5 | Workspace runs read every workspace the project is in | Tested by the multi-repository acceptance; release-material if it crosses an authority boundary |

## G. How 0.9.0 was closed (2026-10-13)

At 18:33 the owner asked for 0.9.0 the same evening and said: leave the long items out, shortcuts are allowed.
What that decision set aside is listed in `V0_9_RELEASE_REPORT.md` under "Left out by the owner's decision" and
in `1_0_READINESS.md`. The findings still OPEN above (ten MEDIUM, the reading half of W2-F1, the LOW list) are
carried to the next release with their severity unchanged; none of them is CRITICAL, and no HIGH is open for
writing or for processes. The brief's rule that a release-material MEDIUM blocks PASS was set aside by the
owner's decision, not met.

## H. Operational autonomy (added to 0.9.0 the same evening): what is open

Built and in the application: progress and time remaining, network resilience, the Director Line. What each
proves and does not is in `V0_9_RELEASE_REPORT.md`. Open, to be closed before any of it is called proven:

| # | Open | Kind |
|---|---|---|
| H1 | No real network outage was produced; the helper's `connect` and `watch` never ran against Windows; the reason code of a user's own disconnect is assumed | PROVE (needs the owner present: it disconnects the machine) |
| H2 | ~~The Director Line never exchanged a message with a real service; no operator is paired~~ Done after the release, see I2. Still open under it: a report raised by a real event (only a test message and typed questions were exchanged), quiet hours, a restart with messages waiting | PROVE |
| H3 | Telephone voice: inbound flow and relay server designed, not built; no screen for credentials. Replaced by the owner's decision of the same evening, see I3 | BUILD, then EXTERNAL (an account with the provider costs money and is the owner's to open) |
| H4 | Programs and Workspaces have no progress of their own | BUILD |
| H5 | The kept estimates and their accuracy are not written to the database (the tables exist) | BUILD |
| H6 | No screen for the network recovery policy and no status channel for the network | BUILD |
| H7 | The combined overnight acceptance (keep-awake, an outage, recovery, a report, a remote "status", a remote task) | PROVE |
| H8 | None of the new code was read by a second party | REVIEW: the line takes input from the Internet and the helper is a new native program |
| H9 | The quiet interval of the network check contacts two well-known hosts while work is active: said in `NETWORK_RESILIENCE.md`; whether the owner wants it configurable | DECIDE |

## I. After the release (2026-10-13, evening; branch `nexus-0.9.1-voice`, nothing of it is in the `v0.9.0` tag)

| # | What happened | What it shows and does not |
|---|---|---|
| I1 | The owner asked for the latest version on the machine. `NEXUS-Setup-0.9.0.exe` from `release/v0.9.0/` was run by hand, for the current user, over the 0.7.0 test install of B5 (data copied first to `%APPDATA%\nexus\backup-before-0.9.0`). Windows now lists 0.9.0, the shortcuts point at it, the database went from schema 11 to 20 (the previous file kept as `nexus.db.v11.bak`), the runtime started and reported ISOLATED as verified | A13 in part: one upgrade, on the machine it was built on. Not shown: a clean install, an uninstall, a reinstall, another machine, an upgrade from 0.8.0. B5 is closed by it |
| I2 | The owner made a Telegram bot, entered its token in Settings and paired their account with the pairing code. A test message arrived. The owner then asked for the status and the time remaining and wrote "push it", and reported that all three were answered as designed (the last one refused) | H2: the line works against the real service for pairing, a test message, two questions and a refusal. It is the owner's report; no log of the exchange was read for this entry |
| I3 | The owner decided that the Director's voice channel is WhatsApp calling through Plivo with audio in both directions, not a telephone call through Twilio (a Twilio call to a Tunisian mobile was read at about 1.27 USD a minute), and that a call is a live conversation, not a spoken report. The Twilio settings fields and the two Twilio documents on the branch are to be replaced | Nothing real: no account, no call. What is on the branch is tested against scripted sessions and fake services only |
| I4 | The owner has no registered business, so WhatsApp calling in every form (Plivo: sales contract and 1,000 USD a month; Meta: a messaging limit that needs a verified business) was dropped the same night, and the voice channel became standard SIP: free accounts on sip.linphone.org that the owner made by hand, the official Linphone application on the telephone, and on the PC a helper of NEXUS's own that drives the official Linphone libraries (AGPL-3.0-or-later, a separate program, fetched and verified, not kept in the repository). Speech is recognised and made on the PC (sherpa-onnx; no sound leaves the machine for it) | A decision and what was built for it. See I5 for what was run |
| I5 | Run on 2026-10-13, late, on this PC: both accounts registered over TLS; `pnpm smoke:sip` placed a call between them through the service with ZRTP and a tone heard in both directions; `pnpm smoke:voice-call` (twice) rehearsed a whole call with a second endpoint standing in for the telephone and a synthetic voice: answered, questions answered from the figures in the model's words, an answer cut when spoken over (NEXUS went on about 0.7 s), goodbye and hang-up, the record showing TLS and ZRTP. First sound of an answer about 1.4 s after the words were recognised, about 2.2 s after the caller stopped. Model alone (`pnpm smoke:voice-latency`): first sentence after 0.65 to 1.2 s | The chain works through the real service between two programs on ONE PC behind ONE router. NOT shown: the telephone ringing (locked, in the background), sound through a mobile network (no STUN or TURN server is set, none was needed here), a real voice (names such as RaceDeck and spoken digits are the recognisers' weak points: the PIN is to be keyed), the PIN on a real call, a call NEXUS places to the telephone, an outage during a call, the packaged application. Whether the service lets a third party forge the caller's address is not established; the PIN is the default for that reason |
| I6 | Full suite on the branch before the last two commits: 5,396 of 5,398 passed; one racy assertion in a new test (fixed), one test of the application-under-test browser that failed under load and passed alone, and one file whose clean-up could not delete a folder under the sandbox account's worktrees (EPERM) | Two flakes of 0.8 code met again under load; not caused by this branch as far as reading the failures shows, not investigated further |
