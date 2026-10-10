# NEXUS 0.7.1 progress

Branch `nexus-0.7.1-token-intelligence`, from `main` at `v0.7.0`. Closed on 2026-10-10: release gate PASS,
merged into `main` and tagged `v0.7.1` (not pushed). What closed it is in `V0_7_1_RELEASE_REPORT.md`, section
"Closing work, 2026-10-10": the real campaign against 0.7.0, compaction on a real session, the security review
of tool-definition sharing, and the Context Graph on by default. The rest of this page is the state of
2026-10-07.

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

## State on 2026-10-07, end of work

Everything under "Not done" in the earlier version of this note is done: the security findings are fixed
(`39727d0`), both remaining reviews ran and their findings are fixed (`db9c9dc`), the full regression, the
stress suites, packaging and the migration campaign are green, and the documents are written.

The release gate is PARTIAL (`V0_7_1_RELEASE_REPORT.md`): not merged, not tagged. Missing for PASS: the
paired real campaign over eight task categories, to be run after the usage window resets on 2026-10-10.
