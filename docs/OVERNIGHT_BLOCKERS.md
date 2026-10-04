# Overnight Blockers

Items that could not be completed or proven during the overnight run of 2026-10-03/04.

## 1. Mandatory shutdown was not performed

- **Blocker:** both shutdown commands in the brief (`shutdown.exe /s /f /t 36000` at the start as a
  failsafe, `shutdown.exe /s /f /t 60` at the end) are refused by Claude Code's permission system, which
  classifies a forced shutdown as irreversible local destruction.
- **Evidence:** the first call was denied at the start of the run. The denial applies to the outcome, so
  it was not retried through another tool, script or sub-agent.
- **Current state:** no shutdown is scheduled. The computer stays on after the run.
- **Safest next step:** run the command yourself, or add a permission rule that allows `shutdown.exe` if
  you want future unattended runs to power off.

## 2. Dynamic graph proposals were not exercised by real Claude agents

- **Blocker:** in both real v0.2 missions the consensus plan already contained the prerequisite that the
  fixture was designed to leave out (`config`), so no agent needed to call `propose_graph_change`.
- **Evidence:** `docs/acceptance/v02-acceptance-*.json`: `v2.proposals` is empty and only revision 1 exists.
- **Current state:** proposals, validation, approval gating, yield/resume and revisions are covered by
  scripted-agent scenarios (`tests/scenarios/dynamic-graph.test.ts`, `audit-fixes.test.ts`), the seeded
  stress campaign, and the Playwright E2E run (plan v2 from a scripted proposal). Not by a real session.
- **Safest next step:** run a mission with single planning on a repository where a prerequisite is only
  discoverable during implementation, and inspect `graph_proposals`.

## 3. Root cause of the original intermittent `paused` scenario not proven

- **Evidence:** the symptom appeared once in about 35 full-suite runs on v0.1. After task worktree creation
  was serialized with merges it did not recur in 1,000 seeded stress runs on v0.1, nor in the later
  campaigns. The failing run's pause reason was never captured.
- **Current state:** explained by inference (git lock contention between concurrent `git worktree add` and
  ref updates), not by a reproduction.
- **Safest next step:** the scenario harness now prints the pause reason and task errors for every
  intervention pause; if it recurs, that output identifies the cause.

## 4. NSIS installer was built but not installed

- **Blocker:** on 2026-10-03 Bitdefender Advanced Threat Defense flagged the silent uninstall of a test
  installation and the session was killed. A silent install/uninstall was therefore not repeated unattended.
- **Current state:** `release/NEXUS-Setup-0.2.0.exe` exists. Launch, database migration, authentication and
  project opening were verified on the unpacked packaged build `release/win-unpacked/NEXUS.exe`, which
  contains the same application files the installer lays down.
- **Safest next step:** install it by hand while present, and add an Advanced Threat Defense exception for
  the installed `NEXUS.exe`, or code-sign the build.

## 5. Left on disk

- The 0.1.0 test installation at `%LOCALAPPDATA%\Temp\nexus-install-test` (its uninstaller is in quarantine).
- Disposable mission repositories and data directories under `%LOCALAPPDATA%\Temp\nexus-adv-*`,
  `nexus-v02-*`, `nexus-accept-*`, `nexus-migrate-check`. They are safe to delete.
