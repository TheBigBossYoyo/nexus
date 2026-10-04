# Adaptive Policy (0.3)

The adaptive policy chooses an orchestration strategy for a mission from recorded evidence, and records
why. It is a small deterministic table plus statistics. It never edits NEXUS source code, and it changes
only when a person promotes a candidate.

NEXUS does not claim universal superiority of any strategy. A preference says that, for one kind of
task, one strategy passed more often in the cases, models and versions that were run. See
BENCHMARK_METHODOLOGY.md for how that evidence is produced and ARENA.md for the controlled trials.

Code: `src/main/modules/policy/` (`profiler.ts`, `defaults.ts`, `engine.ts`, `learning.ts`, `stats.ts`,
`snapshots.ts`, `service.ts`, `simulator.ts`, `wiring.ts`), `src/main/modules/strategy/strategies.ts`,
contracts in `src/shared/v3.ts` and `src/shared/v3-read.ts`.

## Rules that hold everywhere

| Rule | Where it is enforced |
|---|---|
| Policy changes only by explicit promotion (`policy.promote`, a user action). `learn()` only proposes. | `PolicyService.learn/promote` |
| Learning never rewrites NEXUS source code. It writes rows: statistics, candidates, snapshots. | whole module |
| Arena evidence is controlled; mission history is observational and weighted lower. They are kept as separate counts (`arenaN`, `missionN`) and never added in displayed counts. | `poolRow`, `describeCounts` |
| Remaining quota is never an input. The engine receives only a usage status and a "limit hit within the last hour" flag. | `DecideInput` |
| The profiler cannot see evidence. Its input type holds no Arena result, outcome or statistic and the file imports no persistence or learning code (a test asserts it). | `profiler.ts` |
| The decision is fixed for the whole run and stored. | `Orchestrator.applyStrategy` |

## Strategies

`SINGLE`, `BUILD`, `SWARM`, `CONSENSUS`, `SPECULATIVE` are concrete (`CONCRETE_STRATEGIES`). `ADAPTIVE`
is a request that resolves to one of them. A strategy is run configuration for the one orchestration
engine (`StrategyPlan`); it schedules nothing itself.

| Strategy | Planning | Review | Max parallel agents | Speculative candidates |
|---|---|---|---|---|
| SINGLE | none (one worker task) | auto | 1 | 0 |
| BUILD | single planner | auto | `presetMaxAgents(preset)` | 0 |
| SWARM | single planner, mode `swarm` | auto | `presetMaxAgents('eco')` for ECO, else `presetMaxAgents('maximum')` | 0 |
| CONSENSUS | consensus | dual | `presetMaxAgents(preset)` | 0 |
| SPECULATIVE | none | auto | N | N (2 default, 3 maximum, clamped) |

SINGLE and SPECULATIVE use the `balanced` tier for the single worker in ECO and `strongest` otherwise.
See SPECULATIVE_EXECUTION.md and ORCHESTRATION.md.

## TaskProfiler

`profileTask` (`profiler.ts`, `PROFILER_VERSION = 'profiler-v1'`) is pure. It returns a `TaskProfile`
with a `contextKey` of the form `category|complexity|risk`. Each feature carries a basis.

| Basis | Meaning |
|---|---|
| `MEASURED` | Counted or read from the project profile or repository facts |
| `INFERRED` | Produced by the keyword and counting rules below |
| `USER_SPECIFIED` | Set by the caller; wins over inference (category, complexity, risk only) |

| Feature | Basis | Source |
|---|---|---|
| `category` | INFERRED (USER_SPECIFIED if given) | `CATEGORY_RULES` |
| `complexity` | INFERRED (USER_SPECIFIED if given) | score from category, length, deliverables, breadth, files |
| `risk` | INFERRED (USER_SPECIFIED if given) | `STRONG_RISK_PATTERN`, `MODERATE_RISK_PATTERN`, category base |
| `primaryLanguage` | MEASURED | `profile.languages[0]`, else first `language` fact; null if neither |
| `frameworks` | MEASURED | `profile.frameworks`, else `framework` facts |
| `repoFileCount` | MEASURED | `profile.fileCount`; null without a profile |
| `moduleCount` | MEASURED | number of live `module` facts; null if none |
| `testDensity` | MEASURED | test files per 100 source files from `test_mapping` facts; null when there are none ("unknown", not "no tests") |
| `fileScope` | INFERRED | `single`, `few`, `many` |
| `ambiguity` | INFERRED | `low`, `medium`, `high` |
| `securitySensitive` | INFERRED | category is `security` or `SECURITY_SENSITIVE_PATTERN` matches |
| `parallelizability` | INFERRED | `low`, `medium`, `high` |

Stale repository facts are ignored.

### Category

Each rule counts matches of its pattern in the lower-cased prompt, at most `MAX_MATCHES_PER_CATEGORY = 3`
per rule, and adds `matches x weight`. Highest score wins; ties go to the earlier entry of
`CATEGORY_PRIORITY`. No match gives `DEFAULT_CATEGORY = 'feature'`.

| Category | Weight | Pattern keywords (abridged) |
|---|---|---|
| security | 2 | security, vulnerab*, cve, xss, csrf, injection, sanitiz*, authenticat*, authoriz*, auth, permission(s), encrypt*, secret(s), credential(s), password(s), exploit* |
| migration | 1.5 | migrat*, upgrade, port(ing) to, convert ... to, schema change, move from/to |
| performance | 1.5 | performance, slow*, speed up, optimi[sz]*, latency, faster, memory leak, throughput, cache, bottleneck |
| architecture | 1.5 | architect*, redesign, rewrite, from scratch, system design, microservice(s), monolith, module boundar* |
| infrastructure | 1.5 | ci, cd, pipeline(s), docker*, kubernetes, k8s, terraform, github actions, deploy*, infrastructure, packaging, build system, release process |
| testing | 1.5 | coverage, flaky, unit/integration/e2e tests, add/write tests, test suite, test cases |
| ui | 1 | ui, ux, button, page, layout, css, styl*, theme, dark mode, modal, dialog, screen, responsive, frontend, sidebar, tooltip, icon |
| refactor | 1.5 | refactor*, cleanup, restructur*, renam*, simplif*, extract*, dedup*, reorgani[sz]*, tidy |
| bugfix | 1 | fix*, bug(s), crash*, broken, regress*, error(s), fail*, not working, incorrect, wrong, typo, exception |
| feature | 0.5 | add, implement*, create, build, introduce, support, new, feature, enable |

`CATEGORY_PRIORITY` order: security, migration, performance, architecture, infrastructure, testing, ui,
refactor, bugfix, feature. The exact regular expressions are the exported `CATEGORY_RULES`.

### Complexity

Score = `CATEGORY_COMPLEXITY_BASE[category]` + length points + deliverable points + breadth points + file
points - narrowing, floored at 0.

| Component | Points |
|---|---|
| Category base | bugfix 0, testing 0, refactor 1, feature 1, ui 1, performance 1, infrastructure 1, security 1, migration 2, architecture 3 |
| Length (`LENGTH_POINTS`) | 150 words or more: 3; 60 or more: 2; 15 or more: 1 |
| Deliverables (`countDeliverables`: list items if there are 2 or more, else distinct deliverable verbs, minimum 1) | 6 or more: 2; 3 to 5: 1 |
| Breadth (`BREADTH_PATTERN`: across, entire, whole, every, throughout, codebase, system-wide, end-to-end, multiple, all files/modules...) | 1 per match, at most 2 |
| File mentions (`FILE_MENTION_PATTERN`) | 3 or more distinct files: 1 |
| Narrowing (`NARROWING_PATTERN`: typo, one-line, tiny, trivial, small, simple, single, just, only, a variable) | any match: -1 |

`COMPLEXITY_THRESHOLDS`: score 0 is `small`, 1 to 3 `medium`, 4 or more `large`.

### Risk

Score = 2 x `STRONG_RISK_PATTERN` matches + 1 x `MODERATE_RISK_PATTERN` matches + `CATEGORY_RISK_BASE`
(security 1, migration 1). `RISK_THRESHOLDS`: 0 `low`, 1 `medium`, 2 or more `high`.

| Pattern | Keywords (abridged) |
|---|---|
| Strong (2 points each) | production, prod, payment(s), billing, charge, money, data loss, drop table/database, delete all/every/user/customer, irreversible, credential(s), pii, gdpr, customer data, secret(s) |
| Moderate (1 point each) | migrat*, schema, auth*, permission(s), security, vulnerab*, encrypt*, password(s), delete, remove all, force push, rollback, infrastructure, deploy* |

### File scope, ambiguity, parallelizability

| Feature | Rule |
|---|---|
| `fileScope` | 1 distinct file mentioned: `single`; 2 or 3: `few`; 4 or more: `many`; none mentioned: `many` if a breadth word is present, else by complexity (small `single`, medium `few`, large `many`) |
| `ambiguity` | Start 1, or 0 if the prompt names a file or has 2 or more `EXPECTATION_PATTERN` matches (should, must, when, expect*, so that, ensure, return(s), acceptance, criteria). Add 1 per `VAGUE_PATTERN` match (at most 2) and 1 if under `SHORT_PROMPT_WORDS = 8` words. 2 or more `high`, 1 `medium`, 0 `low` |
| `parallelizability` | `PARALLEL_PATTERN` matches minus `SEQUENTIAL_PATTERN` matches; +1 if scope `many`; -1 if scope `single`; +1 if 3 or more deliverables. 2 or more `high`, -1 or less `low`, else `medium` |

These are keyword rules. They are cheap and reproducible and they are wrong on prompts that do not use
the expected words. The profile is stored with its basis so a reader can see which values were inferred.

## Default policy

`defaults.ts`, `DEFAULT_RULES`. The first matching row wins. It describes what NEXUS did before 0.3
(BUILD) with two refinements.

| Order | Id | Strategy | Matches |
|---|---|---|---|
| 1 | `consensus-high-stakes` | CONSENSUS | (category `security` or risk `high`) and complexity `medium` or `large` |
| 2 | `single-small-localized` | SINGLE | category `bugfix` or `testing`, complexity `small`, risk `low` or `medium`, `fileScope` not `many` |
| 3 | `build` | BUILD | everything else |

SWARM and SPECULATIVE are never defaults. A context key with `*` components (a fallback level) matches
a rule only where the rule's tests on the known components hold; `fileScope` is absent from a key, so
rule 2 applies to a context key without checking scope.

## Decision layers

`decide` (`engine.ts`) is pure. The same input, including `seed`, gives the same decision.

| Layer | What it does |
|---|---|
| 0 Forced | If `forced` is set the policy decides nothing: layer `user`, no other layer runs. `PolicyService` never sets it (see Limits). |
| 1 Default | `defaultStrategy(features)` |
| 2 Evidence override | `preferenceFor(snapshot, contextKey)`: the most specific promoted preference along the fallback chain `category|complexity|risk`, `category|*|*`, `*|*|*`. Used if the strategy is allowed and not suppressed. A SPECULATIVE preference is inert while speculation is `OFF`. |
| 3 Safety | If the strategy so far is suppressed or not allowed, replace it with the best remaining strategy by posterior mean `(1 + successes) / (2 + n)` over effective counts, ties by `STRATEGY_ORDER` (BUILD, CONSENSUS, SINGLE, SWARM, SPECULATIVE). If every strategy is suppressed, keep the default. |
| 4 Exploration | See below. |
| 5 Resource availability | See below. |

`allowedStrategies`: all five, except SPECULATIVE when `config.speculation` is `OFF`.

### Exploration

`EXPLORATION_RATES`: `off` 0, `conservative` 0.05, `balanced` 0.15, `research` 0.40. The default
snapshot uses `conservative`.

1. Skipped when the rate is 0.
2. Skipped for `risk = high` unless the mode is `research`; the reason then says so.
3. Otherwise `seed = input.seed >>> 0` is stored on the decision and `mulberry32(seed)` is the generator.
4. If the first draw is below the rate, take one `Beta(1 + successes, 1 + failures)` sample (Gamma draws,
   Marsaglia and Tsang) per allowed, unsuppressed strategy, using effective counts, in `STRATEGY_ORDER`.
   The highest sample becomes the strategy. The decision records `exploration = true` and layer
   `exploration`, even if the draw picked the exploiting strategy.

`seed` is null when exploration was not possible (rate 0, or high risk outside `research`). When the
rate is above 0 and the context allows it, the seed is stored whether or not the exploration draw fired.

### Suppression

A strategy is suppressed for a context when, at the context or any fallback level (`suppressedStrategies`),
the pooled row has at least `suppressMinEffectiveSamples = 3` effective samples and zero effective
successes, or at least `suppressStabilityFailures = 2` stability failures. A suppressed strategy is never
chosen by layers 2 to 4. A stability failure is a blocked Arena trial or one with crashed agents or
scheduler failures, or a mission outcome with terminal `blocked`.

### Resource layer

Skipped when `forced`. `available` is `usageStatus === 'AVAILABLE'` and no limit within one hour.

| Condition | Effect |
|---|---|
| Not available and strategy is SWARM | Replace with the first allowed, unsuppressed of BUILD, SINGLE, CONSENSUS. If none, SWARM stays and the note says so. |
| Not available and strategy is SPECULATIVE | Replace with the first allowed, unsuppressed of the default, BUILD, SINGLE, CONSENSUS. If none, the default strategy is used. |
| Status `THROTTLED` or `LIMIT_APPROACHING` (`THROTTLED_STATUSES`) and worker count above 1 | `workerCount = max(1, floor(workerCount / THROTTLE_WORKER_DIVISOR))`, `THROTTLE_WORKER_DIVISOR = 2` |

The usage status is read from `UsageIntelligenceService.status()`, a runtime fact (USAGE_INTELLIGENCE.md).
If the usage service throws, `PolicyService.usageNow` reports `AVAILABLE` with `recentLimit = true`, so
SWARM and SPECULATIVE are deferred.

### Decision record

`PolicyDecision`, table `policy_decisions`: run, project, task profile, snapshot id and version, context
key, `evidenceContextKey`, strategy, planning mode, `workerCount`, review depth, speculative candidates,
model policies (from `presetRolePolicy`), layer, `exploration`, `seed`, `reason` (plain-language sentences
with counts and the evidence label), `evidenceSummary` rows, `resourceNotes`, usage status, time.

## Evidence

### What counts

| Source | Counted when | Success |
|---|---|---|
| Arena trial (kind `arena`) | state is not `cancelled`, `queued`, `running`, `provisioning`, `evaluating`; finished inside the evidence window | `metrics.hiddenPassed === true` |
| Mission outcome (kind `mission`) | not an Arena run (`isArena`), terminal not `cancelled`, inside the window | `MissionOutcome.success` |

Each observation is added to its exact context key and to every fallback level (`category|*|*`, `*|*|*`).

### Weights

| Constant (`DEFAULT_POLICY_CONFIG`) | Value | Use |
|---|---|---|
| `evidenceWindowDays` | 365 | Older evidence is ignored entirely |
| `recencyHalfLifeDays` | 90 | Weight x `0.5^(age / 90 days)` (`recencyWeight`) |
| `missionWeight` | 0.5 | Base weight of a mission outcome; an Arena trial has base weight 1 |
| `modelDriftWeight` | 0.5 | Extra factor when any role's recorded model differs from the model the tier resolves to now (`modelDrifted`, `sameModel`: equal, or one contains the other; unknown on either side is not drift) |
| `scoringVersion` | `score-v1` | Recorded in the snapshot |

Only `exploration` and `speculation` can be changed by the user (`policy.setConfig`). The other fields
are fixed at their defaults.

### Statistics

`aggregateEvidence` writes one `strategy_statistics` row per (context, strategy, kind): raw `n` and
`successes`, weighted `effectiveN` and `effectiveSuccesses`, pass proportion, Wilson 95% interval on the
raw counts, median and mean duration, mean sessions, mean observed tokens (input plus output), mean
repairs, repair distribution, stability failures, evidence label. The interval formula, the label
thresholds (`EVIDENCE_THRESHOLDS`: weak 5, moderate 12, strong 30, strong max width 0.30) and the rule
that no p-values are computed are in BENCHMARK_METHODOLOGY.md.

For decisions, `poolRow` combines the Arena and mission rows of a strategy: counts are kept apart for
display, `effectiveN` and `effectiveSuccesses` are summed for the pass proportion, the interval and the
label (these use the weighted counts, so a pooled label can differ from a `strategy_statistics` label).
Efficiency figures (sessions, tokens, median time) come from Arena rows when there are any, else from
mission rows.

### Context fallback

`summarize` walks exact, `category|*|*`, `*|*|*` and takes the first level where some strategy has at
least `levelSufficient = WEAK` evidence. `evidenceContextKey` records which level was used; it is null
when no level qualifies.

### Statistics are refreshed only by `learn()`

Decisions read `strategy_statistics` as it was at the last `learn()`. Nothing calls `learn()`
automatically: it runs when the user triggers `policy.learn`. New Arena trials and outcomes do not affect
decisions until then.

## Candidates

`proposeCandidates` runs inside `PolicyService.learn()`. It examines every context key that has statistics
(exact keys and `category|*|*` keys; `*|*|*` is excluded). Candidates are therefore proposed for exact and
category-level contexts, never global.

For each context the incumbent is the active snapshot's preference, else the default. Every other
strategy is judged against it by `judgeChallenger`:

| Step | Rule |
|---|---|
| 1 | The challenger is not suppressed |
| 2 | The challenger has at least `challengerMin = MODERATE` evidence (n of 12 or more) |
| 3 | The incumbent has at least `incumbentMin = WEAK` evidence (n of 5 or more) |
| 4a | Challenger's lower Wilson bound is above the incumbent's upper bound: proposed (rule `separated`) |
| 4b | Challenger's interval lies entirely below the incumbent's: refused |
| 4c | Intervals overlap: both need `overlapBothMin = MODERATE`, the challenger's pass proportion must be at least the incumbent's, and the challenger must be at least `efficiencyBand = 0.20` lower (20%) on mean sessions or median duration (`betterByBand`): proposed (rule `overlap-efficiency`) |

SPECULATIVE is skipped as a challenger while speculation is `OFF`. Among passing challengers a
`separated` one beats an `overlap-efficiency` one; within a rule the higher pass proportion wins. At
most one candidate per context. When none qualifies the reason is returned as a note
(`LearnResult.notes`), for example that the incumbent has too little evidence.

A candidate stores the two strategies, counts, label, `expected` lines (counts, mean sessions, median
time), a reason sentence, the evidence rows, a shadow evaluation, status (`proposed`, `promoted`,
`rejected`, `superseded`) and the snapshot it was based on. On each `learn()` an identical proposal
(same context, strategies, base snapshot, counts and label) is kept; any other `proposed` row is marked
`superseded`. Thresholds are constants in `POLICY_THRESHOLDS` and are not tuned to make candidates appear.

### Shadow evaluation

`shadowEvaluate` applies the candidate to the base snapshot in memory and replays up to the 500 most
recent stored task profiles that do not belong to Arena trials. It reports `profilesReplayed`,
`decisionsChanged` (profiles whose base strategy, default plus evidence layers only, would differ) and
`changedWithKnownOutcome` (those with a recorded real mission under the new strategy in that context). It
does not model exploration or availability, and it says nothing about whether those missions would have
gone better. The note on the result states that.

## Snapshots, pointer, pin, rollback

A `PolicySnapshot` is immutable: version, origin (`default`, `promotion`, `config`), parent, preferences,
`PolicyConfig`, routing (tier to model at that time) and a note. Table `policy_snapshots`.

The pointer is the settings value `policy-pointer` (`POLICY_POINTER_KEY`): `{ activeId, previousId, pinnedId }`.

| Action | Channel | Effect |
|---|---|---|
| Default | startup (`ensureDefault`, called from `src/main/index.ts`) | Writes version 1 (no preferences, `DEFAULT_POLICY_CONFIG`) and the pointer if missing. Idempotent. |
| Promote | `policy.promote` | Candidate must be `proposed`. New snapshot version n+1 with the preference added for that context (`applyPromotion`; promoting the default strategy removes the preference). Built on the pointer's active snapshot, not a pinned one. Pointer: `activeId` = new, `previousId` = old. Candidate becomes `promoted`. Row in `policy_promotions`. |
| Reject | `policy.reject` | Candidate becomes `rejected`; no snapshot. Row in `policy_promotions`. |
| Config | `policy.setConfig` | `exploration` and/or `speculation`. New snapshot (origin `config`), same pointer move as a promotion. No-op if nothing changes. |
| Rollback | `policy.rollback` | `activeId` = `previousId`, `previousId` = null. Only one step. Error if there is no earlier snapshot. |
| Pin / unpin | `policy.pin` | `pinnedId` set or cleared. A pinned snapshot is used for new decisions regardless of promotions. A pin to a missing snapshot is ignored. |

`PolicyService.active()` returns the pinned snapshot if any, else the pointer's active one. Rollback and
pin move the pointer only. Snapshots, decisions and outcomes are never rewritten. A rollback changes
only future decisions. All actions are recorded with `by = 'user'`.

## Using the policy

`Orchestrator.applyStrategy` (called from `createRun`):

1. `PolicyService.decideForRun` profiles the task (`task_profiles` row, always) and, for `ADAPTIVE`,
   decides and stores a `policy_decisions` row. For a concrete strategy it returns that strategy's plan
   unchanged and records no decision.
2. For ADAPTIVE the plan's `maxParallelAgents` is replaced by the decision's `workerCount`.
3. `runs.config.strategy` stores `RunStrategyInfo`: requested, resolved, speculative candidates,
   decision id, snapshot id, task profile id, Arena trial id. Every run names the snapshot it ran under.
4. Events `policy.decided` (ADAPTIVE only) and `strategy.selected` are emitted in one transaction.
5. If the orchestrator has no policy service, ADAPTIVE resolves to BUILD and nothing is recorded.

`policy.preview` computes what ADAPTIVE would do for a project and prompt, stores nothing, and draws a
fresh seed.

## Mission outcomes

`attachOutcomeRecording` (`wiring.ts`, attached in `src/main/index.ts`) subscribes to the event bus and
calls `PolicyService.recordOutcome(runId)` on `run.completed`, `run.failed`, `run.cancelled`, and
`run.paused` with cause `intervention`. It then emits `outcome.recorded`. It reads durable rows only and
never throws into the orchestrator. The row is upserted by run (`mission_outcomes.run_id` is unique), so
a run that is blocked and later finished replaces its earlier row.

| Field | How it is derived |
|---|---|
| `terminal` | `completed`, `failed`, `cancelled`, or `blocked` (paused for intervention) |
| `success` | `terminal === 'completed'` and (the run has no mission-level criteria, or all of them passed) |
| `verificationPassed` | all mission criteria passed; if none, the last mission-level verifier result; else null |
| `repairs` | tasks of kind `repair` plus tasks with key `mission-fix-*` |
| `sessions`, `agents`, `tasks`, `tasksCompleted`, `reviews`, `reviewRejections` | counted from rows; a review decision is the arbiter's if arbitrated, else "changes requested" if any reviewer asked |
| `elapsedMs` | active time from `run-active:<runId>` when present, else start to finish |
| `inputTokens`, `outputTokens` | sum over agents that reported tokens; null when none did |
| `quotaPauses`, `quotaWaitMs` | from `quota_pauses` |
| `humanInterventions` | count of `user.intervention` events |
| `isArena` | an Arena trial row exists for the run |

Nothing is recorded when: the run has no `config.strategy` (created before 0.3); no task profile exists;
the run is in any other state (for example `paused` for quota or by the user, or still running); or the
run is unknown. Failures are logged and swallowed. Mission evidence ignores `cancelled` outcomes and
Arena runs (those are counted as trials). Real outcomes carry `success` judged by NEXUS's own
verification, not by a hidden test.

## Policy simulator

`simulator.ts` (`simulate`, `PolicySimulator`) is deterministic and in memory. A synthetic world gives
each (context, strategy) a hidden pass rate, crash rate, sessions and duration. The simulator generates
Arena trials and mission outcomes from it and feeds them through the real `aggregateEvidence`,
`proposeCandidates`, `decide` and promotion code. Options: seed, steps, world, exploration mode,
speculation policy, `autoPromote`, `learnEvery` (default 10), `arenaPerStep`, `missionsPerStep` (default
1), `stepDays` (default 1), a usage function per step. One seed reproduces a history. It is used by
tests and the stress test only; it is not in the UI.

## IPC channels

All are in `src/main/modules/ipc/v3-handlers.ts`.

| Channel | Input | Result |
|---|---|---|
| `policy.overview` | none | Active snapshot, pointer, evidence totals, per-context rows, candidates (100 most recent), history (100), snapshot list |
| `policy.snapshot` | `snapshotId` | One snapshot (`not_found` if missing) |
| `policy.compare` | `a`, `b` | `PolicyDiff` between two snapshots (preferences added, removed, changed; config fields) |
| `policy.learn` | none | `LearnResult`: statistics count, proposed candidates, notes |
| `policy.promote` | `candidateId` | Updated overview |
| `policy.reject` | `candidateId` | Updated overview |
| `policy.rollback` | none | Updated overview |
| `policy.pin` | `snapshotId` or null | Updated overview |
| `policy.setConfig` | `exploration`, `speculation` (optional) | Updated overview |
| `policy.decisions` | `limit` (default 50), `offset` | Recent decisions |
| `policy.preview` | `projectId`, `prompt` | `PolicyPreview` (profile, decision); nothing stored |
| `policy.run` | `runId` | Strategy info, profile, decision, outcome of one run |

Push message `{ kind: 'policy' }` is sent after every change.

## Tables (migration 004)

`task_profiles`, `mission_outcomes`, `policy_snapshots`, `policy_decisions`, `policy_candidates`,
`policy_promotions`, `strategy_statistics`. The pointer is a row in the existing settings store. Runs keep
their strategy in `runs.config` (JSON).

## Tests

`tests/unit/policy/` (profiler, defaults, engine, learning, stats, simulator), `tests/integration/policy/service.test.ts`,
`tests/scenarios/v3-adaptive.test.ts`, `tests/stress/policy-stress.test.ts` (`NEXUS_POLICY_STRESS_RUNS`,
default 1000 simulations). All use synthetic evidence or the scripted runtime (`FakeAgentRuntime`). No
real ADAPTIVE mission result is stated here: see V0_3_RELEASE_REPORT.md.

## Limits

- `ALWAYS_FOR_HIGH_RISK` behaves as `AUTO` in 0.3. Only `OFF` is tested (`allowedStrategies`,
  `preferenceFor`, `proposeCandidates`). SPECULATIVE is never a default under any setting.
- Candidates are proposed for exact and category-level contexts, never global (`*|*|*`).
- Learning runs only when the user calls `policy.learn`. Decisions use the statistics of the last run of it.
- A run created with a concrete strategy records a task profile and the snapshot id but no decision. A run
  without a strategy in its config (pre-0.3) records no outcome at all.
- A mission outcome is observational. Its `success` is NEXUS's own verification, and runs that finish
  without mission criteria count as successful when completed.
- Small samples: nothing is proposed below `MODERATE` (12) for the challenger and `WEAK` (5) for the
  incumbent, and even `MODERATE` evidence is a small sample. No p-values are computed.
- The context is three coarse buckets from keyword rules. Two different tasks in one bucket are treated
  as the same.
- The user's explicit strategy choice does not go through the policy engine, so the `user` layer and the
  `forced` input exist in the engine but are not used by `PolicyService`. The profiler's `user` input
  (`USER_SPECIFIED`) is likewise not supplied by the orchestrator or the Arena in 0.3.
- Rollback goes back one step only. Only `exploration` and `speculation` are configurable. Candidate
  promotion is manual only; there is no automatic mode.
- The usage status and the one-hour limit flag are the only resource inputs. The policy cannot know how
  much quota is left and does not try to.
- The simulator checks the machinery against synthetic worlds. It does not show that any real strategy is
  better.

## Not verified

- A real ADAPTIVE mission on the real runtime, and a policy built from real Arena campaigns: see
  V0_3_RELEASE_REPORT.md.
- Whether the keyword-based profile matches how real users describe tasks.
- Whether the default weights (mission 0.5, drift 0.5, half-life 90 days) are the right ones. They are
  fixed constants, chosen in the design, not fitted.

Related: ARENA.md, BENCHMARK_METHODOLOGY.md, USAGE_INTELLIGENCE.md, SPECULATIVE_EXECUTION.md,
ORCHESTRATION.md.
