# NEXUS v0.2 Design: Adaptive Orchestration and Empirical Intelligence

Status: implemented in 0.2. This is the design; the user-facing description is in the README and the behaviour in ORCHESTRATION.md.
Where the code differs from the text below, "Implementation notes" at the end lists the differences.

## Objectives

1. **Dynamic DAG adaptation.** Agents propose graph changes; deterministic code validates and applies them; every applied change is a persisted graph revision.
2. **Consensus planning.** Optional mode: three independent planners, a critic, a synthesizer, then the same plan validation as v0.1.
3. **Adaptive model routing.** One `ModelRouter` decides a capability policy per session from role, complexity, risk, failure history and measured outcomes, and records why.
4. **Empirical performance.** Per task outcome rows aggregated by role, model and task category, with explicit sample sizes.
5. **Repository intelligence.** Evidence-backed facts about a project with provenance, confidence and freshness.
6. **Context Engine V2.** Context packs composed from selected sources, with the composition and the reason for every entry persisted.
7. **Adversarial review V2.** Optional dual review with deduplication and a finding arbiter for high-risk tasks.
8. **Mission control UI** for all of the above.

## Non-goals

- No vector embeddings; retrieval stays metadata + SQLite FTS.
- No automatic merge into the user's branch.
- Agents never mutate scheduler state; no nested subagents.
- No new process sandbox; the v0.1 tool policy is unchanged.
- No invented metrics: token and cost figures only where the SDK reports them.

## Architecture

New main-process modules, each pure where possible:

| Module | Responsibility | Depends on |
|---|---|---|
| `task-graph/proposals.ts` | Validate a `GraphProposal` against current tasks and dependencies; produce a list of graph operations | shared types |
| `routing/model-router.ts` | `routeModel(input)` → policy, tier, reasons | shared types |
| `routing/performance.ts` | Aggregate `TaskOutcome` rows into `PerformanceStat`s; sample thresholds | shared types |
| `review/dedupe.ts` | Merge overlapping findings from several reviewers | shared types |
| `planning/heuristics.ts` | Recommend SINGLE or CONSENSUS from prompt and profile | shared types |
| `intelligence/` | Static and git analysis producing `RepositoryFact`s; freshness fingerprints | git, fs |
| `context/context-engine.ts` | Select entries for a pack, record provenance, render with the v0.1 builder | repos |
| `orchestrator/graph-service.ts` | Apply validated proposals transactionally, persist revisions, approvals | repos, bus |
| `orchestrator/consensus.ts` | Candidate planners, critic, synthesizer | agent runner |

The orchestrator remains the only writer of task and dependency rows.

## Entities (see `src/shared/v2.ts`)

`GraphProposal`, `GraphRevision`, `PlanningCandidate`, `PlanningCritique`, `RoutingDecision`,
`TaskOutcome`, `PerformanceStat`, `RepositoryFact`, `ContextPack`, `ContextPackEntry`.

`RunConfig` gains optional `planningMode` (`single` | `consensus`, default `single`) and
`reviewMode` (`standard` | `dual` | `auto`, default `auto`: dual for high-risk tasks). They live in
the existing `runs.config` JSON, so v0.1 runs read back with the defaults.

## Database migration 002

New tables: `graph_revisions`, `graph_proposals`, `planning_candidates`, `planning_critiques`,
`routing_decisions`, `task_outcomes`, `repository_facts` (+ FTS5 mirror with triggers),
`context_packs`, `context_pack_entries`. No existing table is altered, so a v0.1 database opens,
migrates inside one transaction, and all v0.1 runs stay readable. `schema_migrations` records
version 2. A failed migration rolls back and surfaces `NexusError('database')`; nothing is dropped.

## Dynamic DAG

Agents call the new `mcp__nexus__propose_graph_change` tool. Proposal types: `ADD_TASK`,
`SPLIT_TASK`, `CANCEL_TASK`, `ADD_DEPENDENCY`, `REMOVE_DEPENDENCY`, `REPRIORITIZE`, `REPLAN`.

Validation rules (deterministic, in `task-graph/proposals.ts`):

- task keys stay unique; referenced tasks exist;
- the resulting graph is acyclic;
- completed, failed and cancelled tasks are immutable (no split, cancel, or dependency edits on them);
- a running task may gain a prerequisite only when it is the proposer's own task (it then yields and
  is resumed after the prerequisite merges); it can never lose one silently, and no other running
  task can be given one;
- a split replaces a not-yet-started task, or the proposer's own task; dependants of the original
  are rewired to depend on every subtask, so a cancelled original never satisfies a dependency;
- every added writing task carries at least one acceptance criterion; a split must carry over the
  original's criteria (traceability);
- repair children are managed by the pipeline and cannot be targeted.

Approval policy: `REPLAN`, cancelling another agent's task, proposals adding more than three tasks, and
any dependency (`ADD_DEPENDENCY`, `REMOVE_DEPENDENCY`) or priority (`REPRIORITIZE`) change whose target
is not the proposer's own task need user approval (`ApprovalRequest` kind `graph`); the rest apply
immediately. A graph approval belongs to the run, not to the proposing session: it stays answerable after
the proposer's turn ends and is only closed (proposal rejected with a reason, settings key deleted) when
the run ends, is cancelled or the request expires.

Limits (`task-graph` / `orchestrator/graph-service.ts`):

- at most 5 proposals per proposing task (the task id, so retries, resumes and repair sessions share one
  allowance; an agent without a task is keyed by its agent id; user and system proposals have none);
- run-wide: at most 20 applied proposals and 25 tasks added by proposals (counted from the tasks the
  applied proposals list). Past either, a proposal that adds tasks no longer applies automatically and
  needs user approval; approving it applies it regardless;
- at most 8 new tasks per proposal;
- only ASK and AUDIT runs are read-only: a proposal may not add a writing task there; every other mode
  (build, swarm, repair, mission, loop) may.

State: proposal `proposed` → `applied` | `rejected` | `awaiting_approval` → `applied` | `rejected`.
Each application writes a `graph_revisions` row (version n+1, full snapshot of tasks and
dependencies, the proposal id) in the same transaction as the task changes, and emits
`graph.revised`. Version 1 is the approved plan. Revisions are diffable in the UI.

Scheduler impact: none in `selectRunnable`; it already works from current rows. A yielding task
goes `running → queued` and is picked up again when its new dependency completes. When it starts
again its worktree first merges the integration branch so it sees the prerequisite's result.

## Consensus planning

`planningMode: 'consensus'` runs three planner sessions concurrently, each with a different lens
(risk-first, parallelism-first, minimal-change). Planners never see each other's output. Each
candidate is validated; invalid ones are kept with their errors. With at least two valid candidates
a critic (read-only, structured output) reviews the plans, then a synthesizer produces the final
plan from the candidates, critic findings and the project profile. The final plan goes through the
v0.1 validation and repair loop. With one valid candidate it is used directly; with none the run
falls back to the single-planner path. Candidates, critique, timings and reported usage are
persisted. `recommendPlanningMode` suggests consensus for long, multi-area prompts on larger repos.

## Model routing

Policies: `STRONGEST`, `BALANCED`, `FAST`, `INHERIT` (runtime default model). `routeModel` starts
from the run's role policy and applies ordered rules, each appending a reason: high risk or large
complexity → at least `STRONGEST` for writing roles; second attempt after a failure → promote one
step; repair after a HIGH or CRITICAL finding → `STRONGEST`; ECO preset caps non-gate roles; measured
first-pass rate below 50% with at least 5 samples for this role, model and category → promote (see Implementation notes). The
tier resolves to a concrete model through settings only at session start. Every session persists a
`RoutingDecision` (requested policy, resolved tier and model, reasons) and emits `routing.decided`.

## Performance

A `TaskOutcome` row is written when an implementing task finishes: role, model actually used, tier,
category (task kind), complexity, risk, attempts, first-pass verified, completed, review rejections,
repair count, elapsed time, tokens where reported, failed checks, human interventions.
`aggregatePerformance` groups by role, model and category and reports counts and rates with the
sample size; rates below the minimum sample are flagged as insufficient rather than hidden.

## Repository intelligence

Facts have kind (`language`, `framework`, `module`, `entry_point`, `command`, `dependency`,
`import_relation`, `test_mapping`, `boundary`, `generated_path`, `hot_file`, `hazard`, `interface`,
`decision`), subject, statement, source (`manifest`, `static_analysis`, `git`, `agent`, `verifier`,
`user`), confidence, supporting files, a fingerprint of those files, and verified-at. Refresh runs on
project open and before planning: facts whose supporting files changed are recomputed or marked
stale; stale facts are excluded from context. Agent-recorded decisions become `decision` facts when
their task passes verification.

## Context Engine V2

`composeContext` selects candidate entries from: task spec, criteria, dependency outputs, decisions,
repository facts (matched by the task's files, modules and terms), project memory, routed messages, worktree
state, and prior review findings for the task. Each candidate gets `included` plus a reason
(why selected, or why dropped: not relevant, stale, over budget). The pack and entries are persisted
and rendered through the v0.1 builder. The UI answers "why did this agent receive this context".

## Review V2

`reviewMode` `dual` (or `auto` on high risk) runs two reviewers concurrently with different lenses,
deduplicates findings (same file with overlapping lines, or near-identical titles), then a finding
arbiter checks the findings against the code and accepts or rejects each with a reason.
Only accepted findings can request changes. All three records are persisted.

## Security

Proposals are data validated in code; an agent cannot widen its own tools, paths, or approvals
through them. New tasks inherit the role policy of their role. The proposal tool is rate-limited per
task (see Dynamic DAG for the exact numbers). Agent-written messages can only use the agent message
types (a claimed `user_instruction` or `review_finding` is stored as `information`), subjects are capped
at 200 characters, and the orchestration evidence given to verifiers is rendered as one sanitized,
bounded line per record. Repository analysis reads file names, sizes and bounded import lines only, never secrets
files, and never follows links out of the root.

## UI

Mission header (plan version, planning mode, health), graph with revision markers, plan inspector
(candidates, critique, synthesis, revision diff), task inspector context tab, agent routing reason,
Performance view, Repository Intelligence view, timeline entries for the new events.

## Tests

Unit: proposals, cycle prevention, split, cancellation semantics, router rules and promotion,
performance aggregation and thresholds, fact freshness, context selection and provenance, dedupe,
planning heuristics. Integration: migration from a v0.1 database, new repositories, graph
persistence, intelligence refresh. Scenarios 1 to 10 from the brief with scripted agents. Stress:
the seeded campaign extended with proposal injection.

## Backwards compatibility

v0.1 databases migrate forward; v0.1 runs display with plan version 1 and no v0.2 records. Defaults
keep v0.1 behaviour: single planner, standard review unless a task is high risk.

## Acceptance

All listed tests pass; a real mission exercises a graph revision, routing decisions, repository
facts in a context pack, review and verification; the packaged build launches and migrates.

## Implementation notes

Deviations and additions, each checked against the code (identifiers are in `src/`).

| Topic | Design | Implementation |
|---|---|---|
| Measured-performance routing rule | Samples "for this role, tier and category" | `routeModel` looks up the aggregate for (role, the model that the current tier resolves to, category); `aggregatePerformance` groups by role, model and category, not tier. The rule needs `sufficient` (at least `MIN_ROUTING_SAMPLES` = 5) and a first-pass rate below 0.5, and promotes one step. |
| Router rules not in the design | Five rules | Also: an explicit tier override stored on the task (retry escalation, `repairTier` from the second repair cycle), exempt from the ECO cap like the HIGH/CRITICAL repair rule; and a fallback to `INHERIT` with the runtime default model when no model is configured for the tier. Attempt 2 or later promotes one step; ECO caps rules for non-gate roles (all but `planner` and `verifier`). |
| Which sessions use task history | Not specified | Only `implement`, `diagnose`, `research`, `audit`, `synthesis` and `ask` sessions pass the task's attempt, override and category to the router (`TASK_WORK_PURPOSES`). |
| Outcome recording | A row "when an implementing task finishes" | `recordTaskOutcome` writes only for top-level tasks of kind `implement` or `repair` in state `completed` or `failed`; one row per task id (upsert, id `outcome-<taskId>`), so a retry updates it. In a dual review the arbiter's review row supersedes the reviewers' rows of that attempt. |
| Context selection | Facts "matched by the task's files and FTS" | `selectFactsForTask` is a pure ranking by shared path or module, then command facts, then term overlap, at most 8 facts (`FACT_LIMIT`). The FTS5 index on facts is used only by the Intelligence view search (`intelligence.list` with a query). Excluded entries are capped at 30 per pack (`MAX_EXCLUDED_ENTRIES`). Review findings enter a pack only for `implement` and `diagnose` sessions and only at `critical` or `high` severity. Pack sources also include `failure`, `handoff` and `user_instruction`; repair, resume and rotation prompts are recorded as packs through `packForPrompt`. |
| Fact refresh | "On project open and before planning" | Also on re-profile, on run creation (every mode, before planning; a failure never blocks the run) and on request (`intelligence.refresh`). Analysis-owned facts (sources `manifest`, `static_analysis`, `git`) are rewritten, or marked stale when no longer produced; facts from agents, verifiers or users are never overwritten and are marked stale by fingerprint. Analysis bounds: 4000 files, 5 seconds, 200 000 bytes per file, 200 commits, at most 50 files per fingerprint (path, size, mtime). |
| Decision facts | "Become `decision` facts when their task passes verification" | Written just before the merge, source `agent`, confidence `medium`, statement prefixed "Agent-recorded decision (not independently verified)", supporting files are the changed files (at most 20). |
| Dual review details | Dedupe on "same file with overlapping lines or near-identical titles"; the arbiter checks each significant finding | Lines are the same spot when ranges overlap or are within 3 lines; titles are compared only when neither finding has line information, same file (or both without), same category, token Jaccard of at least 0.6. With no `critical` or `high` finding after deduplication there is no arbiter. Otherwise the arbiter receives every merged finding by index; only accepted `critical` or `high` findings block. If it returns no valid decision, `applyArbitration` accepts only `critical` or `high` findings of `high` confidence. |
| Arbitration storage | "All three records are persisted" | Two reviewer rows and one arbiter row exist in `reviews`; because that table has no arbitration column, the arbiter output is an `artifacts` row of kind `arbitration` titled with the arbiter review's id, attached to review rows by `attachArbitration` when read (`reviews.list`, `tasks.reviews`). |
| Consensus fallbacks | One valid candidate used directly; none falls back to single planning | Also: a failing critic does not stop the synthesis; a synthesis that stays invalid after `MAX_PLAN_ATTEMPTS` (3) attempts is replaced by the preferred candidate (the critic's choice if its label matches, else the first valid one); each round replaces the candidate and critique rows of the previous round; a pause or stop during planning halts it and a resume plans again. The synthesizer also receives up to 10 repository facts. |
| Planning recommendation | "Long, multi-area prompts on larger repos" | A score over prompt length (600 and 1500 characters), number of deliverables (3 and 5), scope keywords and repository files (500 and 2000); consensus at a score of 3 or more. |
| Proposal records | States `proposed`, `applied`, `rejected`, `awaiting_approval` | Input without a valid proposal type is not persisted (the tool still answers with the errors) but counts against the submission limit; otherwise the proposal is stored first as `proposed` and then moves to a final or waiting state. The per-task limit counts every stored proposal and every malformed submission. |
| Graph revisions | Written when a proposal is applied | Version 1 is written at `startExecution` (or lazily by the first change). User changes (`tasks.add`, `tasks.cancel`, `tasks.setPriority`) also write a revision with no proposal. |
| Approval and the proposer | Approval stays answerable | The proposer is told to continue with its own task and not wait; it is not notified when the approval is decided. An approved proposal is validated again and applied (also while the run is paused). Graph approvals are kept across a restart; only `tool` approvals are expired on startup. |
| Yield and resume | Task "resumed after the prerequisite merges" | The yield marker (`graph-yield:<taskId>`) is also honoured after a pause or restart: `restartOrphans` queues an `assigned` or `running` task with unmet prerequisites instead of relaunching it. A prerequisite that completed before the proposer's turn ended still yields. A conflicting sync merge is aborted and left to the agent. |
| Proposal types and tool access | Not specified | Only sessions with a task, role `worker`, `debugger`, `architect` or `researcher` and purpose `implement`, `diagnose` or `research` get the tool; repair attempts propose with no task of their own. `REPLAN` cancels not-started tasks that are not listed and never touches started ones. |
| Evidence limits | "One sanitized, bounded line per record" | 120 characters per agent-written field, 25 records per group, 5000 characters in total, 60 message records for the mission verifier. |
| Migration | "No existing table is altered" | Confirmed: `002-v0-2.ts` only creates tables; `task_id` and `agent_id` columns are plain text without foreign keys, so history survives task deletion during replanning. |
| UI | Mission header, graph with revision markers, plan inspector, Performance and Intelligence views | Implemented as Ctrl+6 (Performance) and Ctrl+7 (Intelligence), a Plan inspector tab and a revision bar in the Run view, a Context tab in the task inspector and a routing section in the agent detail. |
