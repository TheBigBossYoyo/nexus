# NEXUS 0.8 release report

Written 2026-10-13. Branch `nexus-0.8-isolation-autonomy`, on top of `main` (v0.7.2). It replaces the report of
2026-10-11, whose verdict was PARTIAL, and says what closed each thing that report and the sessions after it left
open. The log of the work is `V0_8_PROGRESS.md`; what is and is not contained is `V0_8_SECURITY_MODEL.md`; how the
last open question was closed is `V0_8_DNS_CONTAINMENT_EVALUATION.md`.

## Verdict: PASS

**Every release gate is met on the commit named below. Version 0.8.0. Merged to `main` with a merge commit and tagged `v0.8.0`, on this machine only: nothing is pushed.**

## The last open gate: names under the isolated profile

On 2026-10-12 everything was closed except one thing: Windows looked up names for the sandbox account and showed
it the machine's name cache, which no firewall rule for an account sees. The owner's decision was to close it
before PASS, with no placebo. A bounded cycle on the account and its token found nothing that holds; the
isolated profile now runs project code in an AppContainer, and:

| Asked from inside the containment | Answer |
|---|---|
| The resolver every program uses (`ping`), .NET, `Resolve-DnsName`, `nslookup`, `curl` by name, Node `dns.lookup` and `dns.resolve4`, a name never asked before | no name looked up |
| `ipconfig /displaydns` | refused |
| A connection by address, TCP and HTTP, a DNS question over UDP | no route |
| NEXUS's proxy on the loopback | reached |

Asserted by `tests/integration/isolation/containment.test.ts` and checked from inside at every start of NEXUS: an
isolated profile for which a name is looked up is reported as not holding, and nothing runs under it.

The AppContainer cost more than a setting, and each cost is stated in the security model: a POSIX shell that runs
inside it (busybox ash) instead of Git's bash; no git on the user's repository from inside a longer command; a
changed copy of node.exe for the sandbox, because of a defect in libuv that is fixed upstream and not yet released
in any Node; an entry for the sandbox on the Mount Manager device with a one-shot startup task that restores it;
two entries on the folders above the sandbox root.

## Release gates

| Gate | Result |
|---|---|
| A normal autonomous mission interrupts the user 0 times | Met under both profiles, with real sessions: 0 tool approvals, 0 boundary requests, 0 dialogs |
| One deliberate out-of-scope action is one deduplicated boundary request; the mission resumes by itself when it is granted | Met under both profiles: the push is one request; granted, NEXUS resumes the mission by itself and the push arrives |
| An autonomous mission with an Electron application under test, under ISOLATED, with no question to the user | Met: Electron's installer ran, the application was started, operated, captured and stopped inside the AppContainer; 0 questions |
| ISOLATED never falls back; a profile that does not hold runs nothing | Met (`effective-profile`, `containment`, the scenarios) |
| Contained code reads no credential and nothing of the user's, writes nothing outside its roots, has no network of its own and gets no name looked up | Met against Windows: the isolation folder, 86 tests, both profiles, with the Mount Manager and the name assertions |
| The Bash capability under ISOLATED is a shell inside the containment, with stated semantics and explicit refusal | Met: `shell-semantics.test.ts`, 30 tests |
| Raw `.npmrc` stays a boundary; dependency diagnosis does not need it | Met: `package_config_inspect`; in the Electron mission the worker used it and asked nothing |
| Independent review of the host-side git | Done on 2026-10-12; three findings fixed with tests, the rest stated (security model) |
| Full regression | Met: 240 files, 4,714 tests, none failing |
| End-to-end and accessibility | Met: 42 passed, 3 skipped |
| The packaged application starts, verifies both profiles and renders | Met: 17 checks of 17 on the validated commit, and again on the commit that sets the version |
| The setup from the application's own button, with the owner present | Done on 2026-10-12 (before the AppContainer). The setup of version 3 was run by the owner from `scripts/sandbox-setup.mjs`, which shares its steps; from the button it was not run again. |

## Final runs (on `2e1af3f`)

One sequential run, nothing in parallel: `pnpm test`, the build, end-to-end, the package and its check, then the
eight real missions (Claude sessions on the owner's subscription; no separately billed API).

| Stage | Result |
|---|---|
| Full suite | 240 files, 4,714 tests passed |
| Build; browser, isolation and git-scenario tests | 122 of 122 |
| End-to-end (Playwright, the built application) | 42 passed, 3 skipped |
| Packaged application (`scripts/v08-packaged-check.mjs`) | 17 of 17 |
| ISOLATED missions: normal, boundary, resume, render, electron | 28 gates of 28; all five completed; 0 tool approvals; the only requests were the push the script asks for |
| RESTRICTED missions: normal, boundary, resume | 20 gates of 20 |

Evidence: `docs/acceptance/v08-acceptance-2026-10-13T10-11-46-869Z.json` (ISOLATED) and
`…T10-17-55-335Z.json` (RESTRICTED). The commit that follows `2e1af3f` changes documents, the version number and
evidence files only; the package was built and checked again on it.

The runs before this one are in `docs/acceptance/` as they were, failures included: 23 of 28 on `b26a878`, the
pauses that led to the Mount Manager entry and to the application record, 25 of 28 on `53d3a36` (the acceptance
remote was a folder; a network outage of the machine failed one RESTRICTED mission).

What was reviewed and by whom: the host-side git by an independent reviewer (a separate session that was given
the code and the threat model, not the author's conclusions). The launcher's AppContainer code, the package
configuration reader and the change to node.exe were read again by their author before this run, not by a
second reviewer.

## What the owner should know

- **The machine.** The setup is version 3: the account, its folder and firewall rules; a Windows profile for the
  account; one access entry each on `C:\` and `C:\ProgramData`; a loopback exemption; one entry on the Mount
  Manager device; a startup task, `NexusSandbox-RestoreCanonicalization`. `node scripts/sandbox-setup.mjs --remove`
  takes all of it away.
- **Not observed: a restart of Windows.** The startup task has never run at a real start. NEXUS checks from inside
  at every start and says so if the isolated profile's tools would break.
- **A mistake made on the way and corrected.** The first run of the new setup put an entry for the AppContainer
  itself on `C:\` and `C:\ProgramData`; for about a quarter of an hour no low-integrity program could open
  either. The second run removed it. The setup, the verification and the removal now refuse or remove such an
  entry.
- **busybox-w32 is GPL-2.0.** A build that contains it is for this machine until its source, or a written offer
  for it, goes with the build (`vendor/busybox/README.md`).
- **The restricted profile is no containment against hostile code**, and since the review of git that sentence
  includes: its pins can be replaced and existing objects of the repository overwritten by code that runs as the
  user. Prefer the isolated profile for unattended work.
- **Agents meet two new refusals under the isolated profile**: a git inside a longer command, and a command with
  a bash array. Both say what to do instead. A scratch file under `/tmp` does not work there; agents are told to
  use `$TMPDIR`.
- **Programs with a libuv of their own** (the Node inside Electron's main process, a Node a project installs)
  hang when they start a child with a pipe inside the isolated profile, until they carry libuv 1.53.

## Not in 0.8

What was built after the report of 2026-10-11, and what was decided about the rest, is in `V0_8_PROGRESS.md`; this
session changed none of it. Per-session capabilities (so that one session cannot write another's
directories), an object store of the task's own for git as the user, and a walk of the worktree for reparse
points before the user's git stages it are the hardening this session found and did not do.
