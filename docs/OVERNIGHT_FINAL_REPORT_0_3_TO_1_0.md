# Overnight Final Report: 0.3 to 1.0 Readiness

Unattended release train of 2026-10-04 to 2026-10-05, authorized by the user ("Run the pasted plan please").
Times are local (UTC+1). The running log with the detail of every step is
`docs/OVERNIGHT_0_3_TO_1_0_READINESS.md`.

## Summary

| | |
|---|---|
| Start | 2026-10-04 22:35 |
| Finish | 2026-10-05 10:36 (the failsafe; see "How the night ended") |
| Duration | 12 hours; the session itself worked from 22:35 to about 07:15 |
| Hard limit | 2026-10-05 10:36 (12 hours) |
| Initial commit | `2b9f208` lineage; `nexus-0.3` at `b11129b` before the first change of the night; `main` at `v0.2.1` |
| Final commit of `main` | `0a2874f` |
| Highest release | 0.6.0 (`v0.6.0`) |
| 1.0 readiness | **NOT READY FOR 1.0 RC** |
| `v1.0.0` | not created. No release candidate tag or branch was created |

Four releases passed their gates and were merged and tagged (0.3.0, 0.4.0, 0.5.0, 0.6.0). 0.7 is partial and stays
on its branch. Three things found tonight matter more than the count of releases, and are in this report in
full: a defect in the released 0.4.0, a set of security defects that had been in every release, and the fact
that the comparison of NEXUS with plain Claude was not run.

## 0.3.0

| | |
|---|---|
| Verdict | PASS |
| Merge and tag | `main` merge `af3e3ed`, tag `v0.3.0` |
| Tests | `pnpm test` 126 files, 2399 passed; stress 1000 seeds, 6 files; E2E 17; packaged validation 17 of 17 on three older databases |
| Installer | `release/NEXUS-Setup-0.3.0.exe`, 207,250,922 bytes, SHA-256 `2d905b9e10835472a9bd79abcccb1d870fc0e47e98cbdfb86eebbd29eb38e650` |
| Built tonight | Overnight Arena, the generalized workload lifecycle, UI review closure |
| Limitations | A real usage limit and the installer NOT VERIFIED. The stress ran while the checkout was switched between branches (its code was loaded at the start). Found later: a failsafe bookkeeping defect (see 1.0 readiness), fixed on the 0.6 line |
| Report | `docs/V0_3_RELEASE_REPORT.md` |

## 0.4.0

| | |
|---|---|
| Verdict | PASS |
| Merge and tag | `main` merge `3e1b8b3`, tag `v0.4.0` |
| Tests | `pnpm test` 132 files, 2497 passed; stress 1000 seeds (orchestrator 997 in the run, three timeouts under load, 60 of 60 alone); E2E 20; packaged validation 18 of 18 |
| Real acceptance | A real program: 15 of 15 gates, first attempt |
| Installer | `release/NEXUS-Setup-0.4.0.exe`, 207,299,109 bytes, SHA-256 `3990d22858e55c275e8e61d57619b23e6734b68722e8c483b535c270cd91df3e` |
| Limitations | **A defect found after the release** by the 5000-history campaign: a milestone whose result was built on an older state of the program branch could never be accepted and blocked again on every resume. Fixed in 0.5.0; `v0.4.0` is unchanged |
| Report | `docs/V0_4_RELEASE_REPORT.md` |

## 0.5.0

| | |
|---|---|
| Verdict | PASS |
| Merge and tag | `main` merge `389d95f`, tag `v0.5.0` |
| Tests | `pnpm test` 137 files, 2606 passed; stress 1000 seeds, 8 files (before the audit fixes; workspace and program stresses again after them); E2E 22; packaged validation 19 of 19 |
| Real acceptance | Two real cross-repository missions on three repositories: 15 of 15 gates each, first attempt |
| Audit | 1 HIGH (verification passed for a repository whose checks never ran), fixed before the release; 5 of 7 MEDIUM fixed |
| Installer | `release/NEXUS-Setup-0.5.0.exe`, 207,343,181 bytes, SHA-256 `bbc711e549f7045bfebf952c8f3312e9bf8372c3e1dab7c7eabaac4f625927cc` |
| Limitations | The status pages (TEST_STATUS, BUILD_PROGRESS) for 0.5.0 missed the tagged commit because a script stopped halfway; the release report is in the tag, the status pages are on the 0.6 line. Does not contain the security hardening of 0.6 (below) |
| Report | `docs/V0_5_RELEASE_REPORT.md` |

## 0.6.0

| | |
|---|---|
| Verdict | PASS |
| Merge and tag | `main` merge `0a2874f`, tag `v0.6.0` |
| Tests | `pnpm test` 139 files, 2650 passed; stress 1000 seeds, 8 files (before the security hardening; 100 orchestrator seeds after it); E2E 24; packaged validation 20 of 20 |
| Real acceptance | Two real missions implemented and verified by Claude and reviewed by a real Codex session, read-only: 14 of 14 gates each. A real Codex review that finds a planted defect and cannot write |
| Audit | 1 HIGH (the Codex tool could be resolved from the working directory) and 4 MEDIUM, fixed; 3 HIGH of the UI review (consent on the Providers page), fixed |
| Security hardening | Fixes for two HIGH defects that are in every earlier release (the worktree pointer, `git config`), found by the boundary review |
| Installer | `release/NEXUS-Setup-0.6.0.exe`, 207,358,553 bytes, SHA-256 `eb1a885599cfb2d6b0de44b196ca3304ab2502fd52c58d0f86fdb591de4e65ba` |
| Limitations | Codex is read-only, so no heterogeneous speculation with a real provider; Gemini detected only; one HIGH open by design (below) |
| Report | `docs/V0_6_RELEASE_REPORT.md` |

## 0.7

| | |
|---|---|
| Verdict | PARTIAL. Not merged, not tagged |
| Branch | `nexus-0.7` at `30038a9` |
| Built | The control plane core in the NEXUS process: global queue, allocation of agent capacity across workloads, adoption, schedules, health, notifications, Control Center page, IPC, schema 9 |
| Not built | A runtime process of its own, the client and runtime boundary, the worker manager. Each is a gate item |
| Tests | `pnpm test` 141 files, 2688 passed; control plane stress 5000 histories: passed, 472 s; E2E: 25 of 25 passed (1 capture-only test skipped by design), 8.2 min, run in the continuation. The first full E2E run failed four resume tests because of a defect in the new gate, fixed |
| Reports | `docs/V0_7_RELEASE_REPORT.md`, `docs/CONTROL_PLANE.md`, `docs/GLOBAL_SCHEDULER.md`, `docs/WORKERS.md` |

## 1.0 readiness

**NOT READY FOR 1.0 RC.** `docs/ONE_DOT_ZERO_READINESS.md`.

| | |
|---|---|
| Simulations | 10,000 scheduler; 5,000 control plane; 5,000 program; 5,000 workspace; 5,000 usage; 2 x 5,000 overnight; orchestrator 1,000 per release. Two real defects found (programs, overnight), both fixed, 5,000 passed after each fix |
| Fault injection | No new campaign. Existing suites cover session crashes, quota events, restarts, provider outage, evaluator failure; not covered: database failures, network loss, worker death (there are no workers) |
| Security | Three independent reviews. 5 HIGH found, 4 fixed tonight (one in 0.5.0, three on the 0.6 line), **1 open by design**: a writing agent can write a script and run it uninspected, so nothing an agent's shell can reach is truly out of its reach, the overnight shutdown included. 6 MEDIUM open |
| Arena comparison | **Not run.** No evidence that NEXUS is better than plain Claude |
| Migrations | Nine real databases from 0.1 to 0.6 opened by the 0.7 development build: no row lost, everything opens |
| Blocking issues | 0.7 unfinished; the agent boundary is not an operating-system boundary; no Arena evidence; thin real-runtime evidence; installer never executed |

## Main branch

`main` is at `0a2874f` = 0.6.0 (`v0.6.0`). Every merge into `main` tonight was a release that passed its gate, with
`--no-ff`.

## Branches preserved

| Branch | Head | State |
|---|---|---|
| `main` | `0a2874f` | 0.6.0 (`v0.6.0`) |
| `nexus-0.3` | `2ad9c3e` lineage, merged | released as `v0.3.0` |
| `nexus-0.4` | merged | released as `v0.4.0` |
| `nexus-0.5` | merged | released as `v0.5.0` |
| `nexus-0.6` | merged | released as `v0.6.0` |
| `nexus-0.7` | `30038a9` | PARTIAL, unmerged; contains everything of 0.6 |

Three further clones of the repository were made tonight for long runs and for the reviewers to read:
`%LOCALAPPDATA%\NexusValidation`, `%LOCALAPPDATA%\NexusCampaign`, `%LOCALAPPDATA%\NexusAudit06`. Everything in
them that matters was pulled into this repository. They can be deleted.

## Tags

`v0.3.0`, `v0.4.0`, `v0.5.0`, `v0.6.0` created tonight. Earlier: `v0.2.1` and before. Nothing was pushed: this
repository has no remote that NEXUS or this session used.

## Installers

| Version | Path | Size | SHA-256 | Commit |
|---|---|---|---|---|
| 0.3.0 | `release/NEXUS-Setup-0.3.0.exe` | 207,250,922 | `2d905b9e10835472a9bd79abcccb1d870fc0e47e98cbdfb86eebbd29eb38e650` | `0902f0a` |
| 0.4.0 | `release/NEXUS-Setup-0.4.0.exe` | 207,299,109 | `3990d22858e55c275e8e61d57619b23e6734b68722e8c483b535c270cd91df3e` | `a08acf9` (source of `8dcf855`) |
| 0.5.0 | `release/NEXUS-Setup-0.5.0.exe` | 207,343,181 | `bbc711e549f7045bfebf952c8f3312e9bf8372c3e1dab7c7eabaac4f625927cc` | `9f030e9` |
| 0.6.0 | `release/NEXUS-Setup-0.6.0.exe` | 207,358,553 | `eb1a885599cfb2d6b0de44b196ca3304ab2502fd52c58d0f86fdb591de4e65ba` | `bf0f782` |

None was executed. `release/` is not committed. `release/win-unpacked` holds the last build made.

## What was found that the user should read first

1. **Security defects in every release so far, fixed on the 0.6 line only.** An agent's shell could rewrite a
   task worktree's `.git` pointer so that NEXUS's next commit, reset or clean acted on the user's repository;
   and a `git config` check could be bypassed so that a configured program ran inside NEXUS's own git calls
   with NEXUS's environment. Both have tests that fail without the fix. `v0.3.0`, `v0.4.0` and `v0.5.0` do not
   contain the fixes. `v0.6.0` does.
2. **One HIGH is open by design.** A writing agent can write a script and run it. The classifier does not look
   inside files. `SECURITY.md` says what follows from that.
3. **0.4.0 has a known defect** (programs, a stale result after a restart), fixed in 0.5.0.
4. **The real second provider is Codex, read-only.** The Codex command line tool on this computer is signed in
   through its own login; NEXUS drove it for three real read-only reviews and one test session per run. Its
   default model was refused by the service for the installed tool version (0.130.0); `gpt-5.5` works. Nothing
   was installed, upgraded or signed in by this session.
5. **Usage.** The five-hour Claude window reached 93 percent at 03:53; no agent or real run was started between
   02:36 and the reset at 04:10. The seven-day window was at about 70 percent at the end. Real runs tonight: one
   program (0.4), two cross-repository missions (0.5), one mission with a Codex review (0.6), all small.

## Unfinished work

- 0.7: the runtime process, the boundary, the worker manager; package, real acceptance and audit of 0.7.
- The open findings of the audits and UI reviews, listed in the release reports of 0.5 and 0.6 and in
  `SECURITY.md`.
- The Arena comparison; performance, scale and soak tests; a full UI and accessibility review of the latest
  application; fault-injection and repository-safety campaigns as campaigns.
- A patch release of 0.4 and 0.5 with the security hardening was not made.

## Shutdown supervisor

The detached `DevelopmentOvernightSupervisor` (NEXUS code, `scripts/dev-supervisor/`, using the
`WindowsPowerController`) was started at 22:36 as process 27120 and armed a failsafe shutdown for the hard
limit, 2026-10-05 10:36. This session did not call `shutdown.exe` (one mistaken `shutdown /a` through Git Bash at
the start printed the usage text and did nothing). The session ends by sending `finish-now` to the supervisor,
which cancels the failsafe and schedules the final forced shutdown about 90 seconds later: that was the plan. That is not how it went; see the next section.

## How the night ended

The session did not reach its own end. At about 07:15 a tool call was declined ("the user doesn't want to
proceed") and the session stopped and waited, as it must. At that moment 0.6.0 had been released, the 0.7 record
runs and a small Arena comparison were in progress, and this report, the readiness report and the 0.7 report
existed as drafts outside the repository. `finish-now` was never sent. The supervisor's state file shows it
still ARMED with no finish request, and the processes that were running ended with the exit code Windows gives
at shutdown, so the failsafe did what it is for: it shut the computer down at the hard limit, 10:36. Nothing
was lost: every piece of work was committed on its branch before 07:15, except the three reports.

The session was continued by the user on 2026-10-05 at 20:19. In that continuation: the 0.7 end-to-end run, the
migration campaign and the control plane stress were run again (they had been cut off), and the three reports
were written into the repository. No shutdown was triggered in the continuation: the unattended session it
belonged to was over and the user was at the computer.

Consequences for what is said above:

- The Arena comparison started at 06:49 was cut off after one evaluated trial and left no evidence.
- A patch of the Control Center's three HIGH UI findings was not made.
- `main` was not touched after the release of 0.6.0. These reports are on the branch `nexus-0.7`, which is the
  branch checked out in the repository.
