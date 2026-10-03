# Test Status

Factual status as of 2026-10-03, commit `4503709` plus the documentation commit that follows it.

## Automated (no Claude usage)

| Command | Result | When |
|---|---|---|
| `pnpm typecheck` | pass | last run after the hardening fixes |
| `pnpm lint` | pass | same |
| `pnpm test:unit` | 29 files, 812 tests passed | same |
| `pnpm test:integration` | 18 files, 219 tests passed (includes `tests/scenarios`) | same |
| `pnpm test` | 47 files, 1031 tests passed | same, and again after the antivirus incident below |
| `pnpm test:e2e` | 4 Playwright tests passed | before packaging the final build; not re-run since |
| `pnpm build` | pass | part of `pnpm package` |
| `pnpm package` | produced `release/NEXUS-Setup-0.1.0.exe` (about 207 MB) | final build |

### Intermittent failures seen

During repeated full-suite runs after the hardening fixes (about 35 runs in total), three single-test
failures occurred:

1. `happy-path.test.ts`: the parallelism assertion saw 1 concurrent worker instead of 2. Cause: the
   test's first worker could finish before git had created the second worktree. The test now holds
   the first worker until the second has started.
2. `collaboration.test.ts`: timed out after 20 s with the run legitimately in `verifying`, while a
   second test loop was loading the machine. Harness timeouts were raised to 60 s (test timeout 90 s).
3. `scheduling.test.ts`: a run ended `paused` instead of `completed`, once. **Cause not established.**
   Task worktree creation is now serialized with merges (concurrent `git worktree add` and ref updates
   can collide on git lock files), and the harness now logs the reason and task errors for every
   intervention pause. It did not recur in about 25 later runs, which does not prove it is fixed.

## Manual, with the real Claude runtime (consumes usage)

| Check | Result |
|---|---|
| `pnpm smoke:claude` | 3 tests passed: account info (authenticated, subscription), read-only session reporting the package name, Write attempt denied by policy |
| Installed build probe | Installed `NEXUS.exe` launched; SQLite opened; Git detected; packaged `claude.exe` reported auth and model list; a project opened |
| Acceptance mission, attempt 1 | **Failed** in planning: the policy hook denied the SDK's `StructuredOutput` tool. Fixed in the adapter. Evidence: `docs/acceptance/mission-2026-10-03T19-21-27-590Z.json` |
| Acceptance mission, attempt 2 (pre-hardening build) | Completed. Evidence: `docs/acceptance/mission-2026-10-03T19-26-27-508Z.json` |
| Acceptance mission, attempt 3 (final installed build) | Completed: 2/2 tasks, 2 parallel workers in separate worktrees, 8 SDK sessions, 2 reviews approved, 3 verifications passed, `npm test` exit 0; independent `node --test` on the integration worktree: 15 pass, 0 fail. Two medium-risk shell approvals were raised and denied by the script; the workers continued with file tools. Evidence: `docs/acceptance/mission-2026-10-03T20-45-55-133Z.json` |

Not exercised with the real runtime (covered by scripted-agent scenarios and E2E only): the repair
loop after a rejected review, inter-agent messages, quota pause, session rotation, crash recovery.

## Environment incident

After the final acceptance run, Bitdefender quarantined files on the development machine. Source
files and all commits are intact. `node_modules/electron/dist/electron.exe` is missing and could not
be restored (`Access denied`), so `pnpm dev` and `pnpm test:e2e` cannot run until it is restored
(`node node_modules/electron/install.js` once the antivirus allows it). The uninstaller of the
temporary test installation was also removed, so that installation was not uninstalled.
