# Build Progress

Factual log. Test and build status lives in TEST_STATUS.md.

## Completed

| Phase | What exists |
|---|---|
| 0 Environment + design | Repo scaffold, electron-vite + React + strict TypeScript, ESLint, Vitest projects, ARCHITECTURE.md from inspecting SDK 0.3.288 |
| 1 Domain + database | SQLite schema and migrations, repositories, event bus, state machines, task graph |
| 2 Claude runtime | `AgentRuntime` interface, `ClaudeSdkRuntime`, event translation, auth status, model discovery, `FakeAgentRuntime`, real smoke test |
| 3 Git/worktrees | `GitService`, `WorktreeManager`, process runner, temp-repo integration tests |
| 4 Planner + scheduler | Validated plan schema with repair, deterministic scheduler, retries and escalation |
| 5 Workers + messaging | Agent runner, context packs, routed messages, in-process `nexus` MCP tools, handoff and rotation |
| 6 Review + verification | Check commands, reviewer, verifier, repair loop, mission-level verification, bounded iterations |
| 7 Control-plane UI | Projects, mission composer, DAG, task inspector, agents view, diff, timeline, approvals drawer, settings, memory, auth |
| 8 Memory + context | Project/run memory with FTS and provenance, ContextBuilder |
| 9 Crash recovery | Startup recovery, stale agents, worktree reconciliation, Resume / Inspect / Cancel |
| 10 Windows packaging | NSIS installer; installed build launched and verified |
| 11 Hardening | Six-dimension review with adversarial verification; 19 confirmed findings fixed with regression tests |
| 12 Acceptance | Real mission completed on the final installed build; evidence in `docs/acceptance/` |

## Known failures and open items

- One intermittent scenario failure has no established cause (TEST_STATUS.md, item 3).
- `electron.exe` in `node_modules` was quarantined by antivirus and is not restored; E2E was last run
  before the final packaging.
- The temporary test installation under `%LOCALAPPDATA%\Temp\nexus-install-test` is still present.
- Results are not merged into the user's branch by NEXUS; the user runs `git merge` on the
  integration branch.
- WebFetch private-address checks are name based; a public DNS name resolving to a private address
  is not caught.
- Check-command side effects on tracked files (for example `lint --fix`) are discarded, not merged.
- See README.md "limitations" for the rest.

## Decisions

See ARCHITECTURE.md "Key decisions". Later additions:

- The SDK's `StructuredOutput` tool is exempt from the role tool policy for sessions that request
  structured output; it has no side effects and is how the runtime returns the result.
- The mission duration limit measures active (non-paused) time.
- Task worktree creation and merges are serialized per run.
- NEXUS-owned worktrees are reset after check commands so merges always start clean; paths outside
  the worktrees root are refused.

## Next steps

1. Restore `electron.exe`, re-run `pnpm test:e2e`, uninstall the temporary test installation.
2. Establish or rule out the cause of the intermittent `scheduling.test.ts` pause.
3. Exercise the repair loop, messaging and recovery with the real runtime.
4. Optional approval-gated action to merge the integration branch into the user's branch.
