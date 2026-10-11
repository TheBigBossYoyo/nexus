# NEXUS 0.8 release report

Written 2026-10-11. Branch `nexus-0.8-isolation-autonomy`, 46 commits on top of `main` (v0.7.2 at `ad3cb43`).

## Verdict: PARTIAL

**Not merged. Not tagged. Version left at 0.7.2. Nothing pushed.**

The core of the theme works and was shown to work with real sessions on this machine: an enrolled project
runs a normal mission with no interruption, inside a containment that Windows enforces, reads the web through
a guarded fetch, and starts and operates its own application. It is PARTIAL and not PASS because parts of the
specification are not built, some of what is built was not verified in the way a release needs, and one
security question raised by the independent review is not closed. Each is listed below. None is presented as
a limitation to be lived with: they are the reasons this is not a release.

## What was asked for, and where it stands

| Pillar | State |
|---|---|
| 1. Windows execution isolation | Built and verified against the operating system. ISOLATED (a sandbox account, low integrity, a job, the firewall) and RESTRICTED (the user at low integrity, a job, labels). No fallback from one to less. One open question (below). |
| 2. Low-friction autonomy | Built and verified. Profiles, capability broker, grants, deduplicated boundary requests, inbox. Real sessions: 0 interruptions in a normal mission; 1 request for one deliberate push. |
| 3. Internet research, application and browser interaction | Research by guarded fetch: built; verified with scripted pages and one real site. Application under test, web and Electron: built and verified under both profiles. A research browser, signed-in browsing and third-party interaction: not built. |
| 4. Reliability, fault injection, long-run hardening | Fault injection and a soak of the containment and application paths: done. A soak of hours, of real sessions, and under ISOLATED: not done. `V0_8_RELIABILITY.md`. |

## Release gates

| Gate | Result | Evidence |
|---|---|---|
| A normal autonomous mission interrupts the user 0 times | **Met**, with real Claude sessions under ISOLATED, in runs 5, 7 and 8 (0 tool approvals, 0 boundary requests, 0 dialogs). Run 6 had one false request, since fixed. | `docs/acceptance/v08-acceptance-2026-10-11T19-45-35-090Z.json` (run 8) |
| One deliberate out-of-scope action is exactly 1 deduplicated boundary request | **Met** for the push in runs 5, 6, 7, 8: one request, nothing on the remote. In runs 7 and 8 a session also met a second, real boundary of its own accord (a read of the remote's directory; a temporary file beside its worktree): each was one request. | same |
| ISOLATED never falls back to STANDARD | **Met.** A profile that was not verified at start runs nothing; tested with the launcher missing, with no account, with a profile not verified. | `integration/isolation/containment`, `scenarios/v8-containment` |
| Contained code cannot read credentials, the runtime, or write outside its roots | **Met** against Windows, for what the security model claims; see its "What is not contained". | 22 containment tests, both profiles |
| No provider credential reaches untrusted code; no personal browser profile; no separately billed API | **Met.** The environment is an allowlist; the browser is NEXUS's own with a profile per session; research uses no provider API. | `contained-env`, `browser/provider.ts` |
| Independent security review with no open finding | **Not met.** 10 findings; 8 fixed with tests, 2 left with reasons, and one residual question open (next section). | `V0_8_SECURITY_MODEL.md`, "Independent review" |
| Independent UX review | **Not done.** | |
| End-to-end and accessibility of the new UI | **Met.** 5 end-to-end tests and the axe audit (light and dark) of the autonomy settings, the boundary inbox and the project panels pass. | `tests/e2e/v8.spec.ts`, `a11y.spec.ts` |
| Full regression | See "Final runs". | |
| Package | An unpacked package builds and contains the launcher, the setup scripts and the browser driver. The packaged application was not started and not accepted. | `test-results/v08/package-1.log` |

## Why not PASS

**Security, open.**

1. *A forged Git index or commit-graph.* Contained code can write the index of its own worktree entry and add
   files to the object store of the enrolled repository. NEXUS checks `HEAD` before it adds to a branch; it
   does not validate an index that contained code wrote before its own git reads it. What a forged one can
   make NEXUS's git (which runs as the user) do is not established. The review could not close it; neither did I.
2. *The critical finding of the review was in code written hours earlier.* An isolated session could have run
   programs as the user through the path that lets git commit. It was fixed (a closed list of git subcommands
   and arguments, pinned directories, regression tests in which contained code plants hooks and
   configuration), and no second review has looked at the fix. A fix of that weight wants one.
3. *Two findings were left as they were*, on reasoning and not on a test: a junction swapped under a file tool
   of the provider (relies on Windows refusing a low-integrity process a junction to what it cannot write),
   and handle inheritance in the launcher without a list.
4. *The elevated setup script* trusts an existing `C:\ProgramData\NexusSandbox` and an existing account of
   that name.

**Specified and not built.**

- A research browser for pages that need script; signed-in browsing; interaction with third-party sites.
- A grant resuming the task that waited for it. In 0.8 the mission pauses and the user resumes it.
- Rules for unattended work (overnight, arena) in enrolled projects.
- `RoleCapabilityContract` in planning: the contract exists at the gate (a role is refused a capability that
  is not its own); the planner is not told of it.
- Context Graph nodes for research artifacts.
- The pipe's explicit DACL and per-kind dispatch.
- Release of a held download into a worktree; a setting for what a project's application may reach besides itself.
- Desktop applications that are not Electron.

**Built and not verified as a release needs.**

- The setup of the sandbox account from the window (`isolation.setup`): never run. The account on this machine
  was made by `scripts/sandbox-setup.mjs`, which shares its steps.
- The packaged application: built, not started, not accepted. Every acceptance ran the development build.
- A real mission under RESTRICTED (the profile a user has before the one-time setup). All real runs were ISOLATED.
- A real mission with an Electron application under test. Tests cover it; real sessions used a web application.
- The search results page against the real site in a mission. Real sessions read one real page
  (`nodejs.org`); search was exercised by scripted tests only.
- Protection of the user's real credential folders: the labels are applied only by a packaged build or when
  asked (`NEXUS_PROTECT_USER_STORES=1`); neither was done here. Tested on a scratch directory.
- One fix (a session reads the worktrees of its own mission) has no unit test; the acceptance covers it.
- The stress campaign of the orchestrator (1,000 seeds) was not rerun for 0.8.
- The 0.7.2 deferred findings: triaged in `V0_8_DEFERRED_FINDINGS_TRIAGE.md`; those absorbed into 0.8 were not
  all implemented.

## What real use found

Eight acceptance runs with real Claude sessions (Max subscription; no separately billed API). Runs 2, 3, 4 and
6 failed and each failure was a defect: git unusable for the sandbox account outside commands that were git
alone; a harmless git message read as failure; four ordinary actions put to the user as boundary requests;
verifiers failing correct work for lack of evidence only NEXUS held. All fixed, each with a regression test
except the one noted. Runs 5, 7 and 8 passed; run 8 is on the final code. A mission of this size took about
three minutes and cost about 0.56 USD-equivalent of subscription usage as the SDK reports it.

Two things the user should know about how these runs were made:

- The first attempt put the enrollment confirmation on the screen without warning. Confirmations are shown by
  the runtime process, not by the window the script had stubbed. Since then a development build puts
  confirmations to the off-screen window when the acceptance asks; a packaged build never does.
- Run 6's first attempt was stopped from outside when the machine ran low on memory. It left nothing behind.

## Final runs

| What | Result |
|---|---|
| Full suite (`npx vitest run`), final commit | 220 files, 4,461 tests, all passed (748 s) |
| Full suite before the last test-helper fix | 218 of 220 files, 4,441 tests passed; 2 files (20 tests) could not bundle the new browser dependency; fixed, both pass |
| End-to-end, new UI | 5 of 5 |
| Accessibility | 2 of 2 (the existing audit and the 0.8 one) |
| The older end-to-end specs | NOT RERUN for 0.8 |
| Soak | 400 contained commands, 40 application launches: nothing left behind |
| Lint, typecheck | clean |
| Acceptance, real sessions, final code | run 8: every gate |

## What exists on the branch

Security and autonomy model: `V0_8_SECURITY_MODEL.md`, `AUTONOMY_MODEL.md`. Research: `INTERNET_RESEARCH.md`.
Applications and the browser: `APP_BROWSER_AUTOMATION.md`. Reliability: `V0_8_RELIABILITY.md`. The log of the
work, with every measurement and every rejected approach: `V0_8_PROGRESS.md`. Research behind the decisions:
`WINDOWS_ISOLATION_RESEARCH.md`, `BROWSER_AUTOMATION_RESEARCH.md`, `UNTRUSTED_CONTENT_SECURITY.md`,
`CLAUDE_WEB_TOOLS_RESEARCH.md`.

On this machine, outside the repository: the local account `NexusSandbox`, the directory
`C:\ProgramData\NexusSandbox`, two firewall rules, and `%LOCALAPPDATA%\NexusSandbox` (the account's record and
its protected credential). `node scripts/sandbox-setup.mjs --remove` undoes them (one elevation prompt).

## To reach PASS

In order: a second independent review of the git path and of the index question, with the launcher's handle
list; the setup from the window, run once with the user present; a real mission under RESTRICTED and one with
an Electron application; the packaged application accepted; the older end-to-end specs; then the unbuilt items
the user still wants in 0.8, or their explicit move to 0.9.
