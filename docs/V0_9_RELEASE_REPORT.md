# NEXUS 0.9.0

Written 2026-10-13. Branch `nexus-0.9-production-proof`, on top of `main` (`v0.8.0`, `ab54281`). The list of
everything open is `V0_9_HARDENING_LEDGER.md`; what stands between this and a 1.0 candidate is
`1_0_READINESS.md`.

## Verdict

**PARTIAL against the gates 0.9 was given. Released as 0.9.0 on the owner's decision: merged to `main`, tagged `v0.9.0`, and published.**

The brief for 0.9 sets seven gates and says: if any release-material gate remains, PARTIAL, no merge, no tag.
Measured against that, 0.9.0 is PARTIAL: the installer was not run, there was no soak, no crash campaign, no
Arena campaign, no real Program, Workspace or night, no independent UX review, and ten MEDIUM findings of the
security review are open.

On 2026-10-13 at 18:33 the owner asked for 0.9.0 the same evening and said to leave the long items out and to
take shortcuts; at 19:20 they added a pillar to 0.9.0 (network resilience, the Director Line, progress and ETA)
to be built after this part. So this report covers part one: the hardening and the release engineering done in
one day, validated by the suite, the end-to-end tests and the package. It is not the "production proof" the
brief describes, and it is not called PASS. The pillar was built the same evening (its own section below, with
what was and was not proven), after which the branch was merged to `main` and tagged `v0.9.0`, as the owner
asked for 0.9.0 that day. The owner also asked for the project to be published: a copy of the repository whose
history has the machine's identifiers replaced (user name, machine name, account SID) is pushed to a public
GitHub repository; the working repository keeps its own history. NEXUS's own code is under the Apache License 2.0.

| Gate of the brief | State |
|---|---|
| Security | PARTIAL: first restart observed; second review done; the CRITICAL and the HIGH findings fixed for what was reproduced; a capability per session. Open: ten MEDIUM, reading between sessions, no final review, the launcher read and not attacked by the second party |
| Autonomy | NOT SHOWN on this source: no real mission was run on 0.9.0. The scenario and end-to-end tests pass |
| Release engineering | PARTIAL: package built from a clean tree and checked, manifest, bill of materials, notices, checksums, license obligations met, signing state stated. The installer, the upgrade, the uninstall and the restart after an install were not run |
| Reliability | NOT SHOWN: no soak, no crash campaign. The limits of a soak were fixed beforehand and its analyzer is tested |
| Quality | NOT SHOWN: no Arena campaign, no AUTO evidence |
| App / research | PARTIAL: the browser, Electron and research tests of the suite pass under the new capabilities; no campaign |
| UX | NOT SHOWN: no independent review |

## First Real v0.8 Reboot Observation

`docs/acceptance/v09-first-real-reboot-2026-10-13.md`. Observed before anything was changed: a full start of
Windows (boot type 0x0); the packaged 0.8.0 reported ISOLATED available 6.6 s after its launch, verified by
running it; no elevation prompt; 0 interruptions. The startup task ran 25 s after the kernel started. The 34
hostile containment tests of the 0.8.0 source passed afterwards; Node's native `realpath` works inside. Not
answered: whether the task restored the Mount Manager entry or found it there (it keeps no record). One
restart, not a matrix.

## Security Hardening

**Session capability isolation.** Every contained command now holds, beside the capability all sessions hold,
one of its session's own and one of its project's. A session's worktree, temporary directory and home are
opened for writing to that session's capability only; the package cache to the project's. The command's
process, its first thread and the default access list of its token name the session's capability and not the
AppContainer, so another session cannot open its processes or what they create. The launcher reads every
capability back from the token before the command runs, and takes only names of NEXUS's own making. Test: two
hostile sessions at once, and one of another project (`tests/integration/isolation/cross-session.test.ts`):
no write to the other's worktree, temporary directory or home, no ending of its process, no write to another
project's cache. **Open:** a session still reads another's worktree.

**Trusted Git objects.** Not done. What was done in git: the CRITICAL finding of the review. A speculative
candidate's clone could redirect its repository (`commondir`, or a `.git` pointer) and have NEXUS's own git
run a program of its choosing as the user. NEXUS now names the clone's Git directory itself for every command
and refuses anything in the clone that redirects it; the winner's commits are fetched from that directory with
every object checked (`tests/integration/git/worktree-pointer-trust.test.ts`). An object store of the task's
own remains for the next release.

**Link scan.** Not done.

**Privileged bootstrap.** Reviewed by the second reader: the task's definition, script and folder are sound on
this machine. Open: the elevated scripts compile and write in the user's temporary folder (W2-F3, W2-F4), and
the task records no result.

**Independent reviews.** Four readers on the 0.8.0 source: 1 CRITICAL, 3 HIGH, 16 MEDIUM, about 25 LOW. Closed
with tests: the CRITICAL; the HIGH for writing and for processes (shared tools writable; one capability for
all sessions; the inner spec left behind); MEDIUM: a URL an agent names as a way out, the provider's own web
tools, a mission-wide grant without the native confirmation, the package configuration reader, a launcher spec
without an AppContainer; several LOW. One reader was stopped by the provider's safety filter after its first
finding; nothing was done to get around that, and a second reader read the same scope without launching
anything. Each finding with its state: ledger, section E.

**Node compatibility.** Not done: the change to the sandbox's node.exe is as in 0.8, and the compatibility
policy and the runtime probe remain for the next release.

## Installation

Not run: clean install, upgrade, uninstall, reinstall, restart after an install. The package was built and
started (see Package).

## Distribution

- **Signing:** nothing is signed and no certificate is owned. Microsoft's Artifact Signing is closed to
  individuals outside the United States and Canada; an individual certificate from an authority is the open
  way and was not bought. `CODE_SIGNING.md`. The check of signatures is tested with a changed byte.
- **SmartScreen, antivirus:** not exercised on an installer; what an unsigned build meets is in
  `CODE_SIGNING.md`. No security setting was changed.
- **BusyBox licensing:** the license text, the notices and the complete source of the shipped commit go beside
  the installer (GPL-2.0, section 3(a)); a build stops on a binary that is not the one on record.
- **SBOM, checksums:** `release/v0.9.0/`: the installer and its block map, `build-manifest.json` (commit, version, lock hashes, native binaries with their hashes and sources, schema, protocol, setup version 3, toolchain, signing state), `sbom.cdx.json` (CycloneDX 1.7, 265 components: the production dependencies, Electron, busybox-w32, the launcher), `THIRD_PARTY_NOTICES.md`, `licenses/`, `source/` (busybox-w32 at the shipped commit), `SHA256SUMS` over all of it, read back after writing. Built once; a second build for comparison was not made.
- **Dependencies:** no known vulnerability in what ships (`pnpm audit --prod`); two advisories in the packaging
  tool's own dependencies, which do not ship.
- **Secrets:** a scan of the documents, the real data directory, the development data and the test artifacts
  found no credential.

## Reliability

No soak, no crash campaign, no sleep or network campaign. `V0_9_SOAK_THRESHOLDS.md` fixes what a soak will be
judged by. One teardown of one test file failed once under load (`V0_9_FLAKES.md`), cause not established.

## Programs / Workspaces / Overnight / Provider recovery / Director / Task Compiler / Arena / Context Graph / Token Intelligence

No run on 0.9.0 beyond the suite. The subscription's weekly window stood at 52% on the morning of 2026-10-13.

## Browser / Electron / Research

The tests of the suite, under the per-session capabilities. The research tools refuse a URL that is data
(query length and count, runs of encoded text, credential shapes, credentials of this machine) and count a
budget per registrable domain; in an enrolled project the provider's own web tools are neither offered nor
allowed.

## UX / Accessibility

No review. One change a user meets: allowing a boundary request for the whole mission now asks for the native
confirmation, as allowing for the whole project did.

## Tests

`pnpm test` on the final source (`d042794` differs from the tested commit by documents only), nothing beside it:
**271 files, 5,182 tests, all passed** (980 s). Typecheck (both projects) and lint clean. Every run of the day
is in `V0_9_FLAKES.md` as it was: 245 of 246 files on the first run of the branch (a teardown refused a
directory once); 246 of 247 when a new test of this release looked at a folder other tests were writing
(corrected); 247 of 247 with 4,773 tests on part one (`ed9c18a`); 269 of 271 when the pillar was first
integrated, where two architecture guards objected to the new network module (a file named after the power
controller, a process started outside the approved runners) and were satisfied, not relaxed. Not run: the
1,000-seed orchestrator stress and the other stress suites.

## E2E

`pnpm test:e2e` on the final source: **41 passed, 1 failed, 3 skipped** (18.6 minutes). The failure is
`v4.spec.ts:200` (a checkbox on the Programs page whose click did not change its state); the same test passed
3 times of 3 alone right after, and the whole suite had passed 42 of 42 on part one earlier the same day. It is
recorded as an open flake with what is suspected and not established (`V0_9_FLAKES.md`): this release pushes
progress to the window on every event of a mission, which may make such a moment more likely. It was not rerun
until green. The three skipped are the capture specs. No end-to-end test covers the progress panel or the
Director Line settings yet.

## Package

Built from a clean tree at `d042794` (`pnpm package`): `NEXUS-Setup-0.9.0.exe`, SHA-256
`0d842410f751375bfa9d5588cea134ce5c2d62e7af434a93bacfdfa8d1593636`. The unpacked application was started
off-screen on a data directory of its own (`scripts/v08-packaged-check.mjs`): 17 checks of 17. It is the package
of that commit and of version 0.9.0, channel `release`, schema 20, runtime protocol 1; the runtime is ready and
its endpoint restricted; both profiles are verified by running them from the package, ISOLATED as the sandbox
account; every page renders; it stops cleanly. Evidence: `docs/acceptance/v09-packaged-check-2026-10-13.json`.
The release folder `release/v0.9.0/` was built from the same commit: the installer, the manifest (which now
names four native programs: the launcher, the Wi-Fi helper, busybox, the Electron executable), the bill of
materials, the notices, the licenses, the busybox source, and checksums read back. The commit that follows
`d042794` adds this report and that evidence file only. **The installer itself was not run.**

## Operational autonomy (added to 0.9.0 on 2026-10-13, built the same evening)

Three things the owner asked for after part one: a network that goes away must not end a night's work; the
owner must be able to reach NEXUS from a phone and be told what matters; and a long mission must say how far
it is and how long it still needs. Built in one evening by four parallel sessions with the files divided
between them, then wired by one. What follows says for each what is in the application, what proves it, and
what was not done. Documents: `NETWORK_RESILIENCE.md`, `DIRECTOR_LINE.md`.

### Progress and time remaining

In the application: `src/main/modules/progress`, the channel `progress.get`, a panel on the mission page
(percentage, stage, elapsed, active work remaining as a range, confidence with its reason, tasks, workers,
blocker, scope change, last event, milestones, next refresh).

- The percentage is by expected work, not by count of tasks; the remaining time follows the dependencies (the
  longest chain, or all the work spread over the workers, whichever is longer).
- Durations are learned from the tasks that finished on this machine, by kind and size, with medians and
  quartiles; few samples are mixed with general figures and the confidence then says LOW and why.
- A range, never one number; HIGH, MEDIUM or LOW with the reason.
- When verification adds repairs the percentage goes down and the panel says "Scope expanded".
- A wait is said as a wait: "24-35 min of active work remain. Waiting for the Internet; when that ends is not
  known". Waiting for the network, for the provider, for a boundary decision and for the user are told apart.
- Refreshed when something happens in the mission and every five minutes otherwise (a setting, 30 s to 1 h).
- No model is asked for any number or sentence: the texts are templates over the computed snapshot.
- Each estimate shown is kept in memory and, at the end of a mission, its coverage, bias and width are computed.

Proof: 20 unit tests (estimator, service, what the panel shows). **Not done:** a Program or a Workspace has no
progress of its own, only each of its missions; the kept estimates are not written to the database yet (the
tables exist), so nothing is learned from past accuracy; no run with a real long mission; the panel has no
screenshot test.

### Network resilience

In the application: `src/main/modules/connectivity`, `native/nexus-wlan` (shipped as `bin/nexus-wlan.exe`),
`src/main/runtime/network-resilience.ts`, a pause reason and a session outcome `network`.

- Eight states from distinct evidence (the Wi-Fi interface, a name lookup, two independent hosts by name and
  by address, the provider's host, the usage state): a lost Wi-Fi, a Wi-Fi without Internet, a DNS failure and
  an unreachable provider are different things and are recorded as such.
- A session that ends because the provider could not be reached is a wait, not a failed task: the mission is
  paused as "waiting for the network" and resumed, once, when the network is seen again. Sessions are resumed
  by the same mechanism as after a usage wait.
- The saved Wi-Fi profile that was in use when the work began is reconnected through the Windows WLAN API, by
  name, with no question to the user. Then approved saved backups in order. Never a network that is not saved,
  never an open one, never a new profile, never a key; a disconnect the user made is respected.
- The request that keeps Windows from idle sleep is held while any mission works or will resume by itself
  (before 0.9: only during Overnight), released when nothing autonomous is active or everything waits on the
  user, and let go after six hours without progress. It does not block a sleep the user asks for.
- The network is checked only while there is autonomous work. The check is a name lookup and TLS handshakes
  with two well-known hosts and the provider's; nothing is sent.
- Every outage is recorded with its facts (states passed through, reason codes, reconnect attempts) in the
  database, and the diagnosis is assembled from those facts only.

Proof: 167 tests of the module with fakes, and 3 through the runtime's glue with a simulated outage (Wi-Fi
drops, the session's error is judged a network loss, the profile is reconnected, the mission is resumed once,
the open network is never used; an error that is not the network is not a wait; a mission the user paused is
neither kept awake for nor resumed). The helper's `status` and `profiles` were run on this machine and agreed
with Windows.

**Not done, plainly:** no real outage was produced. The helper's `connect` and `watch` were never run against
Windows; which reason code Windows gives for a user's own disconnect is assumed; captive portals, VPNs and
IPv6-only networks are untested. While the provider is away the mission is paused as a whole: commands of the
project that are already running finish, and nothing new starts, because every task needs the model. There is
no screen for the recovery policy (the default applies: reconnect the profile that was in use; no backups).

### Director Line

In the application: `src/main/modules/director-line`, schema 20, nine `directorLine.*` channels, Settings >
Director Line, `src/main/runtime/director-line-host.ts` and `director-line-reports.ts`. Off until turned on.

- A provider interface; Telegram by long polling (no inbound port on the machine); a Twilio voice provider
  that is ready and not configured; types for the other channels.
- Pairing: a one-time code shown on the machine (12 characters, 10 minutes, 5 attempts) sent from the phone to
  the bot; that chat becomes the operator. Everything from any other chat is untrusted: one fixed reply, rate
  limited, never interpreted. For voice: the expected number and a PIN.
- What a paired phone can do: ask for status, time remaining, blockers, details, the last checks, the overnight
  report; pause after the current task; continue what the user paused; add a task (now, or after the current
  work), which is created through the same channel as in the window, so admission, the Task Compiler and the
  capability broker apply as always.
- What it cannot do, by construction: the line holds no path to the capability broker, the settings, the
  boundary inbox or power. A message that asks to push, publish, delete, disable the sandbox, change the
  profile, grant a boundary request or run a command is refused and noted, and the reply says it is decided at
  the machine. A boundary request is reported to the phone as something that cannot be granted from there.
- Reports: the end of a mission (an overnight run with its report), a failure, a blocker or an outage that has
  lasted (5, 15, 30, 60 minutes, then hourly), an estimate that slipped by a quarter and ten minutes. The
  policy decides what is sent, where and how often: quiet hours, call then one message then a local
  notification, one call attempt, progress messages no more often than every 45 minutes. Reports made without
  a network are queued; when it returns, stale ones are dropped and related ones become one message.
- The bot token is kept only through Windows' protected storage, is never returned by any channel, and does
  not appear in errors or logs (tested with a transport that fails with the full address in its message).
- Turning the line on, setting a provider, starting a pairing, setting a PIN, a test call and a policy change
  that widens anything need the native confirmation.

Proof: 201 unit tests and 21 integration tests (pairing, a spoofed chat, a wrong and an expired code, wrong
number and PIN, replayed and duplicated updates across a restart, injected instructions, each dangerous request
refused with no action called, the outbox, quiet hours, the handlers with and without a confirmation, no
channel returning a secret, the upgrade of a schema-19 database).

**Not done, plainly:** no real service was contacted, so the line has never exchanged a message with Telegram.
No operator is paired on this machine. Voice: no credentials; the inbound call flow and the relay server are
designed, not built, and the screen has no fields for them: ready and unconfigured at best, and only for an
outbound call. No model classifies what the patterns do not recognise (the hook is there, unused): an
unrecognised message gets a short help text.

### The gates the owner added

| Gate | State |
|---|---|
| Network loss no longer kills a long mission | Shown with a simulated outage through the runtime's glue; not with a real one |
| Automatic saved-profile reconnect tested | With a fake adapter only; the real `connect` was not run |
| Local work continues offline | Partly: running commands finish; the mission waits as a whole |
| Network work resumes without duplicate execution | Resumed once (test); a real provider session was not interrupted for real |
| Overnight prevents ordinary idle sleep while active | The decision is tested; it was already held during Overnight and is now held for any working mission |
| No arbitrary Wi-Fi connection | Tested: never unsaved, never open, never unapproved |
| Progress bar, five-minute refresh, range and confidence, honest scope and waits, no model for numbers | Met by tests; not seen on a real long mission |
| Paired bidirectional messaging, status, safe remote task, no bypass of capabilities, spoof and replay tests | Met with a fake transport; no actual channel is configured, so by the brief's own wording this gate is not yet due |
| Telephone voice | Not configured; outbound only is implemented |
| The combined overnight acceptance | **Not run** |

## Left out by the owner's decision

Per-session reading; the object store of the task's own; the link scan; the Node compatibility policy and the
runtime probe; the open MEDIUM findings; the startup task's result record and the versioned setup state; the
installer lifecycle; signing; the reboot matrix; sleep, network and disk campaigns; the soak; the crash
campaign; real Programs, Workspaces and a night; the power action; quota recovery; Director, Council, Task
Compiler and Arena campaigns; Context Graph and token measurements; the UX and accessibility reviews; the
diagnostic bundle and the recovery path; the performance baseline against 0.8; the final independent review.

## Known Limitations

Those of 0.8 that this release did not close (ledger, section A), and: sessions read one another's worktrees;
a real mission was not run on this source, so the capability per session met only the tests; a packaged run
that grants for a mission shows a dialog.

## 1.0 Readiness

NOT READY. Seven blockers, in `1_0_READINESS.md`.
