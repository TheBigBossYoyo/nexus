# NEXUS: readiness for 1.0, as of 0.9.0 (2026-10-13)

0.9.0 was closed on the owner's decision of 2026-10-13 to leave the long items out and take shortcuts
(`V0_9_RELEASE_REPORT.md`). This page says, category by category, what that leaves. A category is READY only
on evidence from the 0.9.0 source or from a run named here; "not run" is never READY.

**Recommendation: NOT READY for a 1.0 release candidate.** The blockers are listed at the end; there are
eight, and none is new architecture.

| Category | State | On what evidence | What is missing |
|---|---|---|---|
| SECURITY | READY_WITH_LIMITATION | Second independent review done; 1 CRITICAL and the HIGH findings fixed with tests; a capability per session; the containment holds after a real restart | Ten MEDIUM findings on the elevated setup, the launcher's start and git grants are open; reading between sessions is not closed; the launcher was read, not attacked, by the second party; no final review after the fixes |
| AUTONOMY | READY_WITH_LIMITATION | The 0.8.0 missions (0 interruptions) and the scenario tests on 0.9.0 | No real mission was run on the 0.9.0 source |
| QUALITY | NOT_READY | The suite | No Arena campaign, no AUTO evidence, no comparison with 0.8 |
| RELIABILITY | NOT_READY | The suite; the limits of a soak are fixed and its analyzer tested | No soak, no crash campaign, no database or disk-pressure campaign on 0.9 |
| INSTALLATION | NOT_READY | The package is built and checked | The installer was not run |
| UPGRADE | NOT_READY | Migrations and the backup before an upgrade are tested in the suite | 0.8.0 to 0.9.0 was not done on an installed state |
| UNINSTALL | NOT_READY | none | Not run; the removal script has an open finding (W2-F12) |
| PROVIDER RESILIENCE | READY_WITH_LIMITATION | The usage and capacity scenarios in the suite | No real quota event observed in 0.9; no synthetic matrix beyond the suite |
| LONG-RUN | NOT_READY | none on 0.9 | Everything |
| PROGRAMS | READY_WITH_LIMITATION | Program scenarios and stress in the suite | No real Program of hours |
| WORKSPACES | READY_WITH_LIMITATION | Workspace scenarios in the suite; another project is kept out of a project's cache and sessions (test) | No real multi-repository Workspace run |
| OVERNIGHT | READY_WITH_LIMITATION | Overnight scenarios and end-to-end tests | No unattended night on 0.9; the real power action was never exercised |
| APP AUTOMATION | READY_WITH_LIMITATION | The browser and Electron tests of the suite under the new capabilities | No reliability campaign |
| INTERNET RESEARCH | READY_WITH_LIMITATION | The research tests; the screen of URLs an agent names | No current-web acceptance on 0.9 |
| OPERATIONAL AUTONOMY | READY_WITH_LIMITATION | Progress and ETA, network resilience and the Director Line are in the application with about 420 tests on simulated networks and transports | Nothing real: no outage, no paired phone, no night; voice unconfigured |
| UX | NOT_READY | End-to-end tests | No independent review |
| ACCESSIBILITY | READY_WITH_LIMITATION | The accessibility checks inside the end-to-end suite | No manual keyboard pass, no review |
| DISTRIBUTION | READY_WITH_LIMITATION | Release folder with manifest, bill of materials, notices, checksums read back | No update channel; a build was never given to anybody |
| LICENSING | READY | busybox-w32's license, notices and complete source go beside the installer; the build fails closed on another binary | The author's reading of the GPL, not legal advice |
| SIGNING | NOT_READY (external) | `CODE_SIGNING.md`: no certificate; the check of signatures is tested | A certificate the owner can obtain; Microsoft's own service is closed to individuals outside the United States and Canada |

## What blocks a 1.0 release candidate

0. **The operational-autonomy pillar is built and not proven on anything real** (ledger, section H): a real
   outage, a real paired phone, one unattended night with both, and a second reading of the new code.
1. **The installer lifecycle was never run**: clean install, upgrade from 0.8.0, uninstall, reinstall, a
   restart after the install.
2. **The open MEDIUM findings of the review** (ledger, section E): the elevated scripts and where they write,
   the credential folder's access list, entries left on a user's repository after a crash, the removal's
   recursion, the launcher's current directory, operators that pass the check for `cmd`, what the sandbox reads
   of the user's Git directory.
3. **Reading between sessions is open**: a session cannot write another's files or touch its processes, and can
   still read another's worktree.
4. **No long run**: a soak of 12 hours against the limits already fixed, and the crash campaign.
5. **No measurement of quality on this source**: the Arena campaign, with AUTO.
6. **No real work on this source**: one long Program, one multi-repository Workspace, one unattended night.
7. **A final independent review after the fixes**, with the launcher attacked and not only read.

Not blockers: a signing certificate (public distribution, not the product), the real power action (needs the
owner's presence; the path is tested without Windows being shut down), the LOW findings.
