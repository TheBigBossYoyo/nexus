# Build Progress

Factual log. Test and build status lives in TEST_STATUS.md.

Note, 2026-10-05: tag `v0.5.0` (commit `389d95f`) does not contain the "v0.5.0" section of this page. It was
committed afterwards as `f8e5a67`, which is not in the history of `v0.5.0`. The tag was not moved. See "Release
history and supported versions" in `README.md`; 0.2.1 to 0.5.0 also contain security defects fixed in 0.6.0.

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

## v0.2 (2026-10-04)

| Area | What exists |
|---|---|
| Dynamic graph | Validated proposals, approval policy, limits, yield/resume, persisted revisions |
| Consensus planning | Three planners, critic, synthesizer, fallbacks |
| Model routing | `routeModel` for every session, persisted decisions with reasons |
| Performance | Task outcomes, aggregation with sample thresholds |
| Repository intelligence | Facts with provenance and freshness, refresh on open and before planning |
| Context Engine V2 | Persisted context packs with per-entry reasons |
| Review V2 | Dual review, deduplication, finding arbiter |
| UI | Plan inspector, revision diff, routing reasons, context tab, Performance and Intelligence views |
| Validation | 1267 tests, 4 E2E, 1000-seed stress, audit with all findings fixed, a completed real mission, packaged 0.2.0 verified against a v0.1 database |

Open items for v0.2 are in `docs/OVERNIGHT_BLOCKERS.md` and `docs/OVERNIGHT_FINAL_REPORT.md`.

## v0.2.1 (2026-10-04)

| Area | What exists |
|---|---|
| Overnight Mode | `OvernightSupervisor` (main process): run-level authorization, failsafe armed before any agent, deadline, quota wait, watchdog, budgets, checkpoints, idempotent finalization with the report saved before any power action, recovery |
| Power control | `PowerController` interface, `WindowsPowerController` (argument arrays, no shell), `FakePowerController` for every automated test, `pnpm smoke:power` |
| Authorization | Composer confirmation plus a native main-process dialog; sealed (HMAC) authorization and policy in `overnight_runs`; power audit log |
| Lifecycle | Tray icon, hide to tray, quit question during an overnight run, keep-awake request, off-screen window for automated launches |
| Evidence | `TaskEvidenceBuilder` as the single source of reviewer, verifier and repair evidence, including decision text and the agent's reported result |
| Shell policy | Command classes; heredoc commits and in-worktree heredoc file writes allowed; power commands, the NEXUS database, exec-capable `git config` keys and Git redirection outside the worktree refused or gated; project scripts as verification commands |
| Persistence | Migration 003 (`overnight_runs`, `power_audit`, `run_checkpoints`), additive |
| Real-runtime gates | Dynamic graph proposal and session rotation proven with real Claude sessions (`docs/acceptance/`) |

The release record is `docs/V0_2_1_RELEASE_REPORT.md`.

## v0.3.0 (2026-10-04)

| Area | What exists |
|---|---|
| Usage intelligence | `UsageIntelligenceService`: usage events with provenance, plan windows from the runtime, status machine, aggregation; nothing is estimated as remaining capacity |
| Quota recovery | `QuotaRecoveryController`: checkpoint, wait, availability check without a prompt where the runtime allows it, automatic resume, dispatch gate; Overnight checks before resuming and keeps waiting on an unknown reset until the deadline |
| Strategies | SINGLE, BUILD, SWARM, CONSENSUS, SPECULATIVE and ADAPTIVE as configuration of the one engine |
| Speculative execution | Candidates in separate clones, objective tournament, durable adoption, cleanup |
| Arena | Case format with pinned definitions, 12 built-in cases with hidden evaluators, isolated trials, versioned scoring, campaigns with budgets, quota pause and restart recovery |
| Adaptive policy | Task profiler, evidence aggregation, engine with seeded exploration, candidates, manual promotion, rollback, pin, mission outcomes, simulator |
| UI | Light design system, new shell and navigation, Home, Mission Control, inspector, Agents, composer with strategy selector, Arena, Policy, Usage, Overnight, Activity, Settings |
| Overnight workloads | `AutonomousWorkload` lifecycle under the overnight supervisor; missions and Arena campaigns (Overnight Arena) as workloads; migration 005 |
| Persistence | Migration 004 (20 tables, additive); a copy of the database is kept before a schema upgrade |
| Validation | 2399 tests, 17 E2E, 1000-seed stresses, three code audits and a UI review with fixes, real ADAPTIVE mission, real speculative task, real Arena campaign, packaged 0.3.0 verified against 0.1, 0.2.0 and 0.2.1 databases |

Released as `v0.3.0` on 2026-10-05. The release record is `docs/V0_3_RELEASE_REPORT.md`; the log of the work is `docs/V0_3_PROGRESS.md`.

## v0.4.0 (2026-10-05)

| Area | What exists |
|---|---|
| Programs | `ProgramEngine`: roadmap of milestones, one mission per milestone, deterministic gates, verifier judgment, program branch that only fast-forwards |
| Planning and replanning | Planner and replanner sessions (read-only), validated plans, stored revisions with diffs, plan approval by policy |
| Backlog and memory | Persistent backlog with evidence; validated program memory, selected per mission; expertise profiles |
| Budgets, usage, windows | Mission, session and time budgets; usage waits; work windows; `ProgramWorkload` under the overnight supervisor |
| Background engineering | `BackgroundEngineering`: off by default, read-only, proposals only |
| UI | Programs list and page, new-program dialog, plan approval with a diff, roadmap, backlog, memory, decisions, Home section |
| Persistence | Migration 006 (11 tables, additive) |
| Validation | 2497 tests, 20 E2E, 1000-seed stresses, a code audit and a UI review with fixes, a real program (15 of 15 gates), packaged 0.4.0 verified against 0.1, 0.2.0 and 0.2.1 databases |

Released as `v0.4.0` on 2026-10-05. The release record is `docs/V0_4_RELEASE_REPORT.md`.

## v0.5.0 (2026-10-05)

| Area | What exists |
|---|---|
| Workspaces | `WorkspaceEngine`: enrolled repositories, roles, policy (publishing fixed to `never`), memory, decisions |
| Organization graph | Dependencies from manifests, contracts and the user, with provenance; dependency order and cycles |
| Contracts | Six kinds read into surfaces, versions, consumers and copies, `compareSurfaces` |
| Cross-repository missions | Planner session, validated plan always held for approval, one mission per repository in dependency order, context passed between tasks |
| Global verification and release trains | Checks that ran, contracts against the mission's own base, consumers in step; prepared, never published |
| Workspace programs, overnight | An ordered series of cross-repository missions; `WorkspaceMissionWorkload` under the overnight supervisor |
| UI | Workspaces list and page with seven tabs |
| Persistence | Migration 007 (additive) |
| Validation | 2606 tests, 22 E2E, 1000-seed stresses, a code audit and a UI review with fixes, two real cross-repository missions (15 of 15 gates each), packaged 0.5.0 verified against 0.1, 0.2.0 and 0.2.1 databases |

Released as `v0.5.0` on 2026-10-05. The release record is `docs/V0_5_RELEASE_REPORT.md`.

## v0.6.0 (2026-10-05)

| Area | What exists |
|---|---|
| Providers | `AgentRuntimeProvider`; Claude required and unchanged; Codex through its own command line tool, read-only; Gemini detected only |
| Router | `ProviderService.router` is an `AgentRuntime`; `routeSession` decides; fallback with recorded reasons or refusal |
| Policy, records, usage | Provider policy off by default; `provider_sessions` (migration 008); usage per provider, isolated from Claude's; `provider:model` in evidence |
| UI | Providers page; provider and model of every agent in the mission inspector |
| Security hardening | NEXUS's git runs nothing a repository configures and does not write through a rewritten worktree pointer; `git config` and Git's own files are gated; provider tools found on PATH only |
| Validation | 2650 tests, 24 E2E, 1000-seed stresses, a security audit and a UI review with fixes, an adversarial boundary review, two real missions reviewed by a real Codex session (14 of 14 gates each), packaged 0.6.0 verified against 0.1, 0.2.0 and 0.2.1 databases |

Released as `v0.6.0` on 2026-10-05. The release record is `docs/V0_6_RELEASE_REPORT.md`.

## Known failures and open items (v0.1 record)

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

## v0.7.0 (2026-10-07)

Secure Control Plane. Report: `V0_7_RELEASE_REPORT.md` (PASS). Design: `V0_7_DESIGN.md`. Log: `V0_7_PROGRESS.md`.

- Three process roles from one executable: the window (a client), the persistent runtime (database, queue,
  scheduler, engines, schedules, overnight supervisor), and one worker process per agent session.
- A local protocol over a named pipe with a mutual handshake; the window reconnects and re-reads everything.
- Worker manager with durable leases and heartbeats; a lost worker's session ends as crashed and its task is
  decided from what is on disk.
- Scheduler: aging against starvation, dispatch pause, recorded decisions, schedules that fire once per
  occurrence across restarts; notifications; the tray belongs to the runtime.
- Execution security: trust classes, capabilities, interpreter and package-script policy with provenance, the
  RESTRICTED profile, the decision log. Not a sandbox.
- Git safety beyond 0.6: NEXUS names the Git directory and the branch of its worktrees itself.
- Control Center: confirmations, the load error, blocked work, the inspector, runtime diagnostics, connection
  states.
- Migrations 010 (workers, leases, worker events, schedule firings, scheduler decisions) and 011 (security
  decisions, file provenance), both additive.
- Next: `V0_8_PROPOSAL.md` (isolation and reliability). Nothing of 0.8 is implemented.

## v0.7.1 (2026-10-07)

Context, memory and token intelligence. Report: `V0_7_1_RELEASE_REPORT.md`. Research:
`TOKEN_OPTIMIZATION_RESEARCH.md`, `CONTEXT_GRAPH_RESEARCH.md`. Baseline: `V0_7_1_BASELINE.md`.

- Context Graph (`src/main/modules/context-graph`, migration 12, additive): an index over repository facts,
  project memory, program memory and workspace knowledge. One parent per node, typed edges with provenance,
  trust kept apart from status, freshness from file state, incremental refresh from the git diff, conflicts by
  subject, supersession, history and versions, notes with a write policy, hygiene. It projects the existing
  stores and owns no fact.
- Retrieval without embeddings: path, typed relations, full text (FTS5), hierarchy when broad; confidence and
  widening; scope by project, workspace and program.
- Context Engine V3: the 0.7.0 pack plus a "Project knowledge" section and four agent tools
  (`context_open`, `context_search`, `context_related`, `context_note`). Off for agents by default.
- Token Intelligence Engine (`src/main/modules/token`): per-request cache events, context breakdowns, prefix
  registry, cache diagnosis, prompt auditor, failure-first check output, session efficiency, quality gate,
  provider capabilities, decision log.
- Runtime: per-request usage, context usage and compaction events from the SDK, through the worker protocol.
- Interface: Context view; Usage sections Cache, Context, Context techniques; agent Context tab; Tokens settings.
- Defaults follow the measurements: failure-first check output on; stable prefix, upfront tool loading,
  pressure rotation and the graph in agent context off.
- Three independent reviews (security; graph and memory correctness; token accounting, SDK use and test
  quality): 3 HIGH and 11 of 12 MEDIUM findings fixed with regression tests; the twelfth is a documented limit.
- Nothing of 0.8 is implemented.
