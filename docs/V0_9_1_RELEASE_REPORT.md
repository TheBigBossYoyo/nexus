# NEXUS 0.9.1: release report

**Verdict: PARTIAL against the 0.9.1 brief, released locally on the owner's decision (2026-10-16).** What was proven on
the owner's machine is listed as proven; what was only tested, or not done, is said so. Branch `nexus-0.9.1-voice`,
merged into `main`, tag `v0.9.1`. Nothing was pushed.

## What 0.9.1 adds

**Privilege sessions (brief B).** One UAC prompt per session (a mission, an Overnight run, until idle), a temporary
administrator broker (`native/nexus-elevate`) that NEXUS talks to over a signed pipe, a deterministic policy (absolute
deny list first, capability templates, the Technical Director and the Council), and a receipt of every attempt.
Since the first build it went through **two defensive security reviews, both run as NEXUS missions on itself**
(AUDIT mode), every finding verified against the code before it was fixed:

- First review (13 findings, all verified): the owner's own confirmation of every operation that runs a file NEXUS
  does not ship (an agent may have written or fetched it); a native confirmation before a session's UAC prompt;
  receipts written before an operation runs; refusals only are ever evicted; result and log files only where NEXUS
  says; NEXUS's own scripts no longer refused in an installed NEXUS; approvals with conditions are refusals; secrets
  removed from output by value; the broker's staging folder owned by Administrators and held open while it runs; the
  capability templates enforced by the broker itself; what an installer or a service leaves running is reported.
- **NEXUS installs for all users** (under Program Files, one prompt at install: the owner's decision): the broker,
  the one program started elevated, was in a folder the user can write. The runtime and the broker both refuse a
  session from anywhere else, and the broker refuses unexpected files and environment next to it.
- Second review (3 High, 10 Medium, 13 Low): no session while a mission of an uncontained project runs (its agents act
  as the owner); the owner confirms uninstalls and service stops; privileged requests kept without their secrets in
  the tool history; the relay and the broker deny other processes of the user their memory; NEXUS's scripts only from
  NEXUS's install folder; results and logs written in the broker's staging and returned; a fixed working folder and
  PowerShell module path; .NET-loading variables refused by prefix; and the Low findings listed in the commits.
- **Tamper-evident receipts (M7), built by a NEXUS mission on itself**: each final receipt is chained (SHA-256 and an
  HMAC with a key in protected storage); a missing, edited, reordered or inserted receipt is named at the top of the
  privileged activity report, which never hides a broken record.

**Zero-disturbance testing (brief C).** Commands of uncontained projects run on a desktop of their own; a desktop
meter (`native/nexus-presence`) and the mission page's Test environment panel count UAC prompts, visible windows,
foreground steals, console flashes and dialogs; test instances keep their notifications to their log.

**Missions.** Measured by real missions (self-missions and the owner's own) and fixed:

- Read-only missions (audit, question): one planner; a contained project reads a snapshot inside the sandbox (every
  shell command of an audit was refused before); the report is on the overview; a synthesis gets its dependencies'
  results whole. The owner's audit went from 16.5 to 11 minutes.
- No false boundary requests for an agent's own tool results, for a fetch from loopback of an application NEXUS
  launched, or for a request whose task completed; a mission waiting for one has a button that opens it.
- A refused commit is not a blocker (NEXUS commits what is left); the refusal says what works.
- Git: 37 % fewer git processes (immutable answers kept); contained missions mirror pnpm and leave out the tests that
  cannot run nested; flaky test files rerun once; failures kept at the head of a long test output.
- Progress and estimates honest from the first mission; the task list always reachable on a paused mission.

**Performance.** Missions' work runs below normal priority (the window and the call helper stay normal), checked every
30 s since Chromium resets its own; NEXUS's work folders are not indexed. Owner: "quite smoother, I didn't see any lag
while last time it was horrible". No agent, worker or check fewer.

**Voice (brief A).** The voice line hardening of the first days of 0.9.1 (the commits `feat(director-line, voice)`).

## What was proven on the owner's machine

- A **real privilege session**: one UAC prompt, broker ACTIVE (2026-10-15), after the broker learned the compatibility
  layers Windows 11 sets on an elevated program (`DetectorsAppHealth DetectorsAdminProtection Installer`).
- The **install for all users**: installed, updated four times, the broker's install-folder check passing.
- **Real missions by the owner**: two audits of the privilege broker, a build mission that delivered M7 (10 tasks,
  4 final checks passed, merged after review and a full run of the suite outside the sandbox).
- **The ChatGPT path** of the specification (the Director's recommendations in a mission's specification).
- **The work priority**: below normal on the installed runtime (log and process checked), the owner's verdict above.

## What was not proven, or is open

- **No privileged operation was run through a real session** (the acceptance fixture: install, a failure, its
  repair). The broker's protocol, checks and staging are tested unelevated (`tests/integration/privilege`); what only
  holds elevated (the install-folder and staging ownership checks, the process ACLs against another integrity) was not
  exercised beyond the session starting.
- No Overnight run with administrator recovery.
- Brief A: A1 (the SIP helper in a sandbox) and A3 (call transfer) open; the SIP password rotation is the owner's.
- Brief C: the C7 benchmark (Electron hidden versus a private desktop) not run.
- Licensing (Linphone AGPL, Kroko, espeak-ng GPL, BusyBox GPL) unresolved: blocks any public distribution.
- The broker is unsigned (the owner's decision: no paid certificate): its UAC prompt says "Unknown publisher".
- The second review's remaining Low findings (L5 persistence created by an installer is not reported; L7 the owner is
  shown the path, not the script; L9 a malformed request leaves no receipt; L13 signing).

## Evidence

- Full suite on the release commit: 309 files, 5,670 tests, all passed (outside the sandbox).
- End-to-end tests on the release source: 41 passed, 3 skipped, 1 failed: the known flake 2 of `docs/V0_9_FLAKES.md`,
  which passed alone and is now explained (the test clicked a checkbox the window had not yet enabled) and fixed in
  the test.
- Each review's report and verification: in the commit messages of `1c3df36`, `b28baff`, `f765cab`, `c46ea5f`.
