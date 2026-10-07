# NEXUS 0.7.1 progress

Branch `nexus-0.7.1-token-intelligence`, from `main` at `v0.7.0`. Not merged, not tagged. Work stopped on
2026-10-07 at the user's request (the machine was being closed); everything is committed.

## Done

- Research: `TOKEN_OPTIMIZATION_RESEARCH.md`, `CONTEXT_GRAPH_RESEARCH.md`. Baseline: `V0_7_1_BASELINE.md`.
- Context Graph: schema (migration 12), projection of the existing stores, freshness, conflicts,
  supersession, notes and write policy, hygiene, navigation, retrieval, rendering.
- Context Engine V3 (hybrid packs), four agent tools, wiring into the orchestrator.
- Token Intelligence Engine: per-request cache events, context breakdowns, prefix registry, cache diagnosis,
  prompt auditor, failure-first check output, session efficiency, budget, quality gate, provider capabilities.
- UI: Context view, Usage sections (Cache, Context, Context techniques), agent Context tab, Tokens settings.
- IPC: `knowledge.*`, `tokens.*`.
- Documents: `CONTEXT_GRAPH`, `MEMORY_ARCHITECTURE`, `CONTEXT_ENGINE_V3`, `TOKEN_INTELLIGENCE`,
  `PROMPT_CACHING`, `CONTEXT_LIFECYCLE`; README, ARCHITECTURE, ORCHESTRATION, USAGE_INTELLIGENCE, ARENA,
  PROGRAMS, WORKSPACES, CONTROL_PLANE updated.
- Version in `package.json` is 0.7.1.

## Evidence so far

| What | Result | Where |
| --- | --- | --- |
| Unit suite | 2,953 passed after the two expectation updates (run before the last features; rerun needed) | |
| Token unit tests | 45 passed | `tests/unit/token` |
| Graph integration, benchmark, IPC | passed | `tests/integration/context-graph`, `tests/integration/ipc/v71.test.ts` |
| 0.7.1 scenarios | 13 passed, three runs in a row | `tests/scenarios/v71-token-context.test.ts` |
| Retrieval benchmark, 18 tuning cases | 0.7.0 selection 86.5% recall and 4 non-current records shown; graph 100% and 0; V3 100% and 0 | `docs/acceptance/retrieval-benchmark-*.json` |
| Retrieval benchmark, 7 held-out cases | 0.7.0 54.8%; graph alone 85.7%; V3 100% | same |
| Stress | 100,000 nodes and 500,000 edges; 5,000 histories; 125,000 accounting sessions: passed in 1,413 s | `tests/stress/context-graph-stress.test.ts`, `docs/acceptance/context-graph-scale-*.json` |
| Real cache acceptance | Sessions of one role share the prefix across worktrees without any option; another role shares nothing; upfront tool loading changes nothing | `docs/acceptance/cache-acceptance-*.json` |
| Real paired mission (n=1) | Both passed hidden evaluation and review. With the graph: 45 turns vs 39, cache read 345k vs 294k | `docs/acceptance/context-graph-acceptance-*.json` |
| New E2E spec | passed | `tests/e2e/v71.spec.ts` |

Defaults that follow from this: failure-first check output ON; stable prefix OFF; upfront tool loading OFF;
pressure rotation OFF; Context Graph in agent context OFF (retrieval evidence is good, the one real pair
showed more tokens and no quality difference, and the quality gate needs eight pairs).

## Not done (in order)

1. **Fix the security review findings** (review finished; no CRITICAL or HIGH):
   - MEDIUM: titles of one program's knowledge reach other runs through section summaries and the map.
     Sections under `programs/<id>` have no `programId`; `describeChildren` names program-scoped children;
     `renderMap` lists children unfiltered. Fix: give sections under a program its `programId`
     (`projection.ts` `Builder.section`), name only children visible to the parent in `describeChildren`
     (`service.ts`), and pass the run's program to `renderMap` (`render.ts`, `orchestrator/context-graph.ts`).
   - LOW-MEDIUM: no cap on notes per run; `rebuildSummaries` pages every derived node on each note write.
     Fix: cap (for example 50 notes per run) in `writeNote`; fetch `onlyIds` by id instead of paging.
   - LOW: `renderDetail` prints source file names without `oneLine` (`render.ts`, the "Source files" line).
   - LOW: the duplicate-note check in `writeNote` ignores `programId`.
   - LOW (optional): facts built from README text are labelled verified.
2. **Rerun the two reviews that were stopped before reporting**: graph and memory correctness; token
   accounting, SDK use and test quality. Their prompts are in the session that launched them; the scopes are
   the files listed under "Done". Fix what they find.
3. **Full regression**: `pnpm typecheck`, `pnpm lint`, `pnpm test` (was stopped mid-run, no result),
   `pnpm test:e2e` (the sidebar gained "Context": stored screenshots need `--update-snapshots` after review),
   the existing stress suites, `pnpm package`.
4. `TEST_STATUS.md`, `BUILD_PROGRESS.md`, `V0_7_1_RELEASE_REPORT.md` (not written yet). The README release
   history still says "Use 0.7.0".
5. Release gate, then merge and tag only on PASS.

## Known limits to state in the release report

- No Arena campaign compared a 0.7.1 context variant with 0.7.0; the Arena has no context-variant dimension.
- One real paired mission only. Engineering-quality delta of the Context Graph: NOT VERIFIED.
- Compaction fidelity and rotation fidelity with real sessions: NOT VERIFIED (no baseline session compacted).
- Reviewer and verifier prompts carry no graph section.
- A `summary` context breakdown is the runtime's estimate (it over-stated a real request by about half).
- Usage-window change per mission was not sampled.
