# NEXUS 0.3 Design: Arena, Adaptive Policy, Speculative Execution, Usage Intelligence, Light UI

Status: design, written before implementation on branch `nexus-0.3`. Deviations found while building are
recorded in "Implementation notes" at the end, as in V0_2_DESIGN.md.

## What 0.3 is for

0.2 chooses an orchestration strategy by rule. 0.3 measures strategies on controlled tasks, records what
happened in real missions, and lets a versioned policy choose a strategy from that evidence, with the
reason, the sample size and the confidence shown. It also makes Claude availability an explicit part of
the system (pause on a usage limit, resume by itself), and replaces the UI.

Not in 0.3: NEXUS changing its own source code, automatic policy promotion, other runtime providers,
token or cost budgets, any claim that one strategy is better in general.

## Baseline (2026-10-04, commit `2b9f208`)

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | 80 files, 1772 tests passed, 189 s |
| `pnpm stress` (default 20 orchestrator seeds, plus overnight stress) | pass |
| `pnpm test:e2e` | 10 of 10 passed |
| `pnpm package` | pass (`release/NEXUS-Setup-0.2.1.exe`) |

## What exists and what is missing (from reading 0.2.1)

| Area | 0.2.1 | Gap for 0.3 |
|---|---|---|
| Quota | `rate_limit_event` rejected, assistant `rate_limit`/`billing_error` or a usage-limit message prefix gives outcome `quota`; the run pauses with reason `quota`; session ids are kept and resumed | Resume is manual, except in Overnight Mode, which waits only when a reset time is known, never probes, and ends the run otherwise. Sibling runs are not paused. |
| Rate-limit data | `agent.rate_limited {status, resetsAt, limitType}` | `utilization`, overage fields and `allowed_warning` are dropped |
| Usage | `agents.metrics`, `usage_snapshots` (written, never read), `task_outcomes` tokens | No aggregation, no service, no UI beyond one agent tab; duration and turn counts per session are not persisted |
| Strategy | Modes differ only in planner guidance; `planningMode`, `reviewMode`, presets | No strategy abstraction, no single-agent path, no speculation, no evidence |
| Learning | `task_outcomes` feeds one routing rule | Nothing at mission level |
| UI | Tokenized Tailwind 4, dark default, a light palette exists, top bar + flat 7-item sidebar | Information architecture, shell, hierarchy, home, new pages |

## What the Claude runtime actually exposes (SDK 0.3.288, read from `sdk.d.ts`)

| Data | Where | Used as |
|---|---|---|
| Per-session token counts per model, turns, duration, cost figure | `result.modelUsage`, `num_turns`, `duration_ms`, `total_cost_usd` | OBSERVED (what NEXUS sessions used; not the account's total) |
| Limit status of the current window | `rate_limit_event.rate_limit_info.status`: `allowed`, `allowed_warning`, `rejected` | EXACT (runtime) |
| Reset time | `rate_limit_info.resetsAt` (epoch seconds), optional | EXACT when present, else UNKNOWN |
| Window type | `rateLimitType`: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`, ... | EXACT when present |
| Utilization of that window | `rate_limit_info.utilization`, optional | EXACT when present. The declaration does not state the unit, so NEXUS stores the raw number and shows a percentage only for the experimental report below, whose unit is documented |
| Account | `accountInfo()`: subscription type, token source, provider | EXACT |
| Plan windows without sending a prompt | `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`: per window `utilization` (documented 0-100) and `resets_at` | EXACT when it answers. It is an official SDK method but declared unstable, so every use is optional, schema-checked, and falls back to UNKNOWN |

There is no "tokens remaining" figure anywhere. NEXUS therefore never shows one. A percentage is shown
only when the runtime supplied that percentage; observed token counts never get a denominator.

NEXUS does not call any Claude web endpoint, read credentials, or parse private files. Everything above
comes through the Agent SDK object model.

## Module map (new or changed)

```
src/shared/v3.ts                 all 0.3 contracts (types + zod): usage, arena, policy, speculation
src/main/modules/
  usage/
    classify.ts        pure: runtime signals -> UsageSignal (availability, reset, source, confidence)
    machine.ts         pure: usage status machine and the quota-wait planner
    service.ts         UsageIntelligenceService: persists events, holds status, aggregates, snapshots
    recovery.ts        QuotaRecoveryController: checkpoint, wait, probe, resume
    probe.ts           availability probe built on the runtime (no prompt when the runtime allows it)
  strategy/
    strategies.ts      OrchestrationStrategy implementations: pure configuration of the one engine
    tournament.ts      pure: rank speculative candidates from objective evidence
  policy/
    profiler.ts        TaskProfiler (pure)
    stats.ts           Wilson interval, evidence labels, recency weights (pure)
    engine.ts          AdaptivePolicyEngine.decide (pure, seeded)
    learning.ts        evidence -> preferences -> PolicyCandidate; shadow evaluation; regression detection
    service.ts         snapshots, candidates, promotion, rollback, pin; decision and outcome recording
    simulator.ts       deterministic policy simulator used by tests and stress
  arena/
    case-format.ts     case definition schema, loading, versioning by evaluator hash
    fixtures.ts        provision an isolated repository per trial
    evaluator.ts       run visible and hidden evaluation outside the agent's reach
    scoring.ts         documented, versioned scoring and ranking (pure)
    campaign.ts        ArenaService: campaigns, trial queue, persistence, recovery, quota pause
arena/cases/<id>/       built-in suite: case.json, fixture/, evaluator/, README.md
```

Changed: `agent-runtime/translate.ts` (keep all rate-limit fields), `agent-runner.ts` (session-level
usage event), `orchestrator` (strategy at run creation, single-task path, speculative implement stage,
global dispatch gate), `overnight/supervisor.ts` (uses the shared quota-wait planner), `persistence`
(migration 004), IPC, and the whole renderer.

Dependency rule stays: pure modules (`classify`, `machine`, `tournament`, `profiler`, `stats`, `engine`,
`learning`, `scoring`) import only `src/shared`.

## Usage Intelligence

### Provenance

Every value the service returns is a `Measured<T> = { value: T | null, source, confidence }`.

| Confidence | Meaning | Example |
|---|---|---|
| `EXACT` | The runtime stated it | reset time from `resetsAt`, plan utilization from the usage report |
| `OBSERVED` | NEXUS counted it from its own sessions | tokens, sessions, turns |
| `ESTIMATED` | Derived by NEXUS from observed values | not used for capacity; only for "expected resume" when probing without a reset time |
| `UNKNOWN` | Not available | subscription remaining |

Sources: `RUNTIME`, `SDK_EVENT`, `ERROR_METADATA`, `LOCAL_AGGREGATION`, `UNKNOWN`. The renderer has one
component for a measured value; it cannot render a percentage or a bar without `EXACT` and a non-null
value. A unit test walks the usage read model and fails if any percentage-typed field is non-null with a
confidence other than `EXACT`.

### Status machine (`usage/machine.ts`, pure)

```
AVAILABLE ──allowed_warning──▶ LIMIT_APPROACHING ──allowed──▶ AVAILABLE
    │  transient throttle (overloaded / short retry-after)
    ├──────────────▶ THROTTLED ──next success──▶ AVAILABLE
    │  rejected / usage-limit error
    └──────────────▶ QUOTA_PAUSED ──checkpoint written──▶ WAITING_FOR_RESET
                                                        │ resume time or probe interval reached
                                                        ▼
                                                     PROBING ──available──▶ AVAILABLE (ramp-up)
                                                        └──still limited──▶ WAITING_FOR_RESET
AUTH_REQUIRED and RUNTIME_UNAVAILABLE are entered from auth and runtime errors and left on a
successful account check.
```

`LIMIT_APPROACHING` is entered only on a runtime `allowed_warning` (or a usage report whose own
utilization is at or above 90). Observed token counts never cause it.

### Quota pause and automatic resume (`usage/recovery.ts`)

1. A session ends with outcome `quota` (classification unchanged from 0.2.1, plus the enriched fields). The
   task keeps its state and its SDK session id; no attempt is consumed; nothing is marked failed.
2. `core.pauseRun(runId, 'quota')` as today. New: the controller records a `quota_pauses` row
   (run, pausedAt, resetAt and its confidence, limit type, a checkpoint id) and, when
   `pauseAllOnGlobalLimit` is on, pauses every other active run with the same reason and closes the
   dispatch gate so no new Claude session starts anywhere. Check commands and merges already in flight
   finish (they are local, deterministic work).
3. A `run_checkpoints` row is written for each paused run (reason `quota`).
4. Plan the wait (`planQuotaWait`, pure):
   - reset time known: `resumeAt = resetAt + resumeDelaySeconds` (default 60);
   - unknown: probe schedule 5, 10, 20, 30, 30... minutes (configurable base and maximum);
   - bounded by `maxQuotaWaitMinutes` when set, and for Overnight runs by the mission deadline.
5. At the planned time the status becomes `PROBING`. The probe asks the runtime for its usage report (no
   prompt, no model call). If that method is missing or fails, the probe is one minimal session
   (`maxTurns: 1`, no tools, fast tier, a fixed one-line prompt). A probe is never run more often than
   the schedule, so a limited account sees at most one small request per interval.
6. Available: the gate opens with a ramp (one new session at a time for the first minute, then the run's
   normal limit), each paused run is resumed through `orchestrator.resumeRun` (existing path: session
   resume when the SDK session is resumable, otherwise the structured handoff of 0.2.1), a
   `quota_resumes` row records the result, and one notification is sent. Still limited: back to
   `WAITING_FOR_RESET` with the next interval.
7. Restart during a wait: the `quota_pauses` row is the durable state. On startup the controller reloads
   open rows and re-plans from the stored reset time; a run that was `paused/quota` stays `paused/quota`
   and is not turned into a recovery pause.
8. Resume is idempotent: a `quota_pauses` row is closed in the same transaction that claims it, and a run
   that is no longer `paused` with reason `quota` is skipped.

Runs paused by the user are never resumed by this controller.

### Overnight

The supervisor keeps ownership of an overnight run's quota wait (deadline, failsafe, final action) but
uses the same `planQuotaWait` and the same probe:

| Situation | 0.2.1 | 0.3 |
|---|---|---|
| Reset known, before the deadline | wait, resume 90 s after | wait, probe, resume (`resumeDelaySeconds`) |
| Reset known, after the deadline | end, `QUOTA_EXHAUSTED` | unchanged |
| Reset unknown | end | probe on the conservative schedule while the next probe is before the deadline; then end |
| Policy `END_RUN` | end | unchanged |

The deadline is not moved by a quota wait. The failsafe therefore never needs to move either: a wait is
only chosen when it ends before the deadline, and the failsafe is later than the deadline by
construction. `EXTEND MISSION` remains the only way to move both, and it is a user action. This is
stricter than the brief allows ("may reschedule its failsafe if policy explicitly allows") and is chosen
because it cannot extend past what the user approved.

### Aggregation

`usage_events` holds one row per session end (tokens per model, turns, duration, outcome) and one per
limit signal. Aggregates are SQL `GROUP BY` queries over indexed columns (run, task, agent, model, day,
strategy, arena campaign); the renderer receives aggregates and paged lists, never the whole history.

## Strategies

`OrchestrationStrategy` is a pure object: `configure(input) -> StrategyPlan`. A `StrategyPlan` is run
configuration for the existing engine; there is no second scheduler.

| Strategy | Plan |
|---|---|
| `SINGLE` | No planner. One `worker` task (strongest tier) with the mission as its specification and the mission criteria as its criteria; normal checks, review, verification and merge. One agent at a time. |
| `BUILD` | Mode `build`, single planner, review `auto`, preset parallelism. |
| `SWARM` | Mode `swarm`, single planner, review `auto`, maximum-preset parallelism. |
| `CONSENSUS` | Mode `build`, consensus planning, dual review. |
| `SPECULATIVE` | As `SINGLE`, but the implement stage runs N candidates (default 2, hard maximum 3). |
| `ADAPTIVE` | Asks the policy engine, records the decision, then runs the chosen strategy's plan. The decision is fixed for the run. |

The strategy and the policy decision id are stored in `runs.config` (JSON, so no table change).

### Speculative execution

Inside the task pipeline, for a task marked speculative:

1. N candidate worktrees are created from the same commit (`nexus/<run>/<task>-cand-a`, `-b`).
2. One implementing session per candidate, concurrently, with the same prompt and context pack. A
   candidate's worktree is outside every other candidate's path boundary, and no message routing exists
   between candidates.
3. The check commands run in every candidate worktree.
4. `rankCandidates` (pure) orders candidates by: checks passed; acceptance commands passed; fewer failing
   check commands; fewer critical/high findings if a review was run; smaller diff; then candidate label.
   Every comparison used is recorded. An LLM opinion is not an input.
5. The winner's branch becomes the task's branch and continues through the unchanged review,
   verification and merge stages. If no candidate passes its checks, the best-ranked one goes through
   the normal repair loop.
6. Losing candidates: diff, check results and metrics are persisted (`candidate_results`), then the
   worktrees are removed and the branches deleted.

In an Arena trial the hidden evaluator is **not** used by the tournament. It would make SPECULATIVE the
only strategy that selects on the hidden test, which would invalidate the comparison. Hidden evaluation
scores the finished trial, for every strategy alike.

Speculation policy: `OFF` (default), `AUTO` (policy engine may choose it for high-risk or
high-complexity bounded tasks), `ALWAYS_FOR_HIGH_RISK`. It is deferred when the usage status is not
`AVAILABLE` or a limit was hit in the last hour (both are runtime facts, not estimates).

## Arena

### Case format

```
arena/cases/<id>/
  case.json        id, version, name, description, category, complexity, risk, languages, frameworks,
                   taskPrompt, visibleAcceptance[], setup[], evaluation{command, timeoutSeconds},
                   budgets, allowedStrategies, scoring overrides
  fixture/         the repository the agent sees (becomes commit 1 of a fresh Git repository)
  evaluator/       hidden tests, copied in only by NEXUS after the run has ended
  README.md
```

JSON instead of the brief's `case.yaml`: no YAML parser is a dependency of NEXUS today and the format
carries no comments that need one. The case version is stored with a SHA-256 over the evaluator
directory; a changed evaluator under an unchanged version is refused.

### Trial isolation

Each (case, strategy, repetition) is one `ArenaTrial`:

- `fixture/` is copied to `<data>/arena/<campaign>/<trial>/repo`, `git init`, one commit. That commit id
  is the recorded baseline. The user's repositories are never involved. For a user-selected repository
  the trial repository is a local clone at the chosen commit.
- The trial runs as a normal NEXUS run on a project row marked `arena` (hidden from the Projects list).
  Project memory, repository facts and task outcomes are per project, and each trial has its own
  project, so nothing learned in one trial is visible to another.
- The evaluator directory is never inside the trial repository or any worktree. Agent path policy already
  refuses paths outside the worktree and project root; a regression test asserts an agent read of the
  evaluator path is denied and that no prompt or context pack of a trial contains evaluator content or
  another trial's id.
- After the run ends: the integration branch head is exported to `<trial>/eval`, the evaluator files are
  copied over it, the case's evaluation command runs there with `runCommandLine` (no shell, timeout,
  output cap). The agent sessions are over before the evaluator files exist anywhere in the trial.
- A trial that produced no integration branch (failed, blocked, timed out) is evaluated as failed
  acceptance; the evaluator is not run on the unmodified fixture.

Recorded per trial: baseline commit, NEXUS version, strategy, policy snapshot id, resolved models,
SDK version, OS, timestamps, task profile, budgets, and the raw metrics of section 22 of the brief
(correctness, quality, efficiency, autonomy, stability, limit behaviour), each null when not measured.

Built-in evaluator commands are trusted because they ship with NEXUS. An imported case shows its
commands and needs one explicit confirmation before its first execution; the confirmation is stored
with the evaluator hash.

### Scoring (`arena/scoring.ts`, version `score-v1`)

Ranking is lexicographic, not a weighted sum:

1. hidden evaluation passed (required acceptance);
2. fewer unresolved critical/high review findings;
3. mission verification passed;
4. fewer repair cycles;
5. shorter wall-clock time, compared in 20 % bands (differences inside a band are ties);
6. fewer observed tokens, in 20 % bands; then fewer sessions.

A trial that fails step 1 can never rank above one that passes it. The displayed convenience score is
`0` for a failed trial and `60 + up to 40` for a passed one (the 40 from steps 2 to 6 with documented
weights 15/10/5/5/5), so it cannot hide a correctness failure. Raw metrics are always stored and shown.
A case may override band width and weights; the score version and overrides are stored with every result.

### Campaigns

`ArenaService` owns a persisted queue: campaign `draft → running ⇄ paused(quota|user) → completed |
cancelled`, trials `queued → running → evaluating → passed | failed | blocked | cancelled`. Budgets:
`maxWallClockMinutes`, `maxTrials`, `maxConcurrentTrials` (default 1), `maxAgentSessions`,
`maxAgentsPerTrial`; presets ECO, BALANCED, RESEARCH. A usage limit pauses the campaign through the same
dispatch gate and it continues after the automatic resume. After a restart, a trial that was `running`
resumes through run recovery; one that was `evaluating` is re-evaluated (evaluation is a pure function of
the integration commit). An Overnight campaign is a campaign started through the supervisor: the
supervisor's deadline and power policy apply; agents never touch power.

### Statistics (`policy/stats.ts`)

Per (context, strategy): n, successes, Wilson 95 % interval for the pass proportion, median and mean
time, repair distribution, mean sessions, mean observed tokens.

| Label | Criterion |
|---|---|
| INSUFFICIENT | n < 5 |
| WEAK | 5 ≤ n < 12 |
| MODERATE | 12 ≤ n < 30 |
| STRONG | n ≥ 30 and Wilson interval width ≤ 0.30 |

No p-values. Two strategies are called different only when their Wilson intervals do not overlap;
otherwise the UI says the evidence does not separate them.

Regression detection compares the pass proportion of the same cases and strategy between two (NEXUS
version, policy version, model) groups and flags `ORCHESTRATION REGRESSION` when the newer group's upper
Wilson bound is below the older group's lower bound; anything less is reported as "lower, not
established".

## Adaptive policy

### TaskProfiler (pure)

Input: prompt, `ProjectProfile`, repository facts, user-specified fields. Output: `TaskProfile` where
every feature is `{ value, basis: MEASURED | INFERRED | USER_SPECIFIED }`. Measured: primary language,
frameworks, file count, module count, test density. Inferred by documented keyword rules: category,
complexity, file scope, ambiguity, risk, security sensitivity, parallelizability. It has no access to
Arena results or outcomes.

### Decision layers

```
DEFAULT POLICY         deterministic table keyed by category/complexity/risk (today's behaviour: BUILD,
                       CONSENSUS for high-risk security work, SINGLE for small localized fixes)
EVIDENCE OVERRIDE      the active snapshot's preference for this context, present only if promoted
EXPLORATION RULE       Thompson sampling, bounded by mode
RESOURCE AVAILABILITY  usage status may reduce parallelism or defer speculation; never picks a
                       strategy from invented capacity
FINAL POLICY           PolicyDecision with reason, evidence summary, exploration flag, snapshot id
```

Context key: `category | complexity | risk`, with fallback to `category`, then global, each fallback
needing its own sufficient evidence.

Evidence weighting: an Arena trial counts 1; a real mission outcome counts 0.5 and is labelled
observational everywhere; both are multiplied by `0.5^(age / halfLifeDays)` (default 90 days) and by 0.5
again when the recorded model differs from the model currently configured for the tier.

Exploration: with probability set by the mode (Off 0, Conservative 0.05, Balanced 0.15, Research 0.40)
the engine draws one sample per allowed strategy from `Beta(1 + successes, 1 + failures)` using a
seeded generator (the seed is stored in the decision) and takes the highest draw. High-risk tasks never
explore outside Research mode. A strategy is suppressed (not eligible for exploitation or exploration)
when it has at least 3 effective samples with zero successes, or 2 scheduler/stability failures, in the
evidence window.

### Learning, candidates, snapshots

`learn()` recomputes `strategy_statistics` and proposes a `PolicyCandidate` for a context only when the
challenger has at least MODERATE evidence, the incumbent has at least WEAK evidence, and the
challenger's Wilson lower bound exceeds the incumbent's upper bound, or their intervals overlap on
correctness, both are MODERATE or better, and the challenger is at least one band better on sessions or
time with a pass proportion not lower than the incumbent's. Thresholds are constants in one file and are
not tuned to make candidates appear.

A candidate is promoted only by the user (default `MANUAL`). Promotion writes a new immutable
`PolicySnapshot` (version n+1) and a `policy_promotions` row. Rollback and pin move the "active" pointer
only; snapshots, decisions and outcomes are never rewritten. Shadow evaluation replays stored task
profiles through a candidate snapshot and reports how many decisions would change; it is labelled as a
sanity check, not as an effect estimate.

Every run records `task_profiles`, `policy_decisions` (when ADAPTIVE) and, at its end, a
`mission_outcomes` row.

## Database migration 004 (additive)

New tables: `usage_events`, `usage_windows`, `quota_pauses`, `quota_resumes`, `arena_cases`,
`arena_case_versions`, `arena_campaigns`, `arena_trials`, `arena_trial_metrics`, `arena_evaluations`,
`task_profiles`, `mission_outcomes`, `policy_snapshots`, `policy_decisions`, `policy_candidates`,
`policy_promotions`, `strategy_statistics`, `speculative_runs`, `candidate_results`,
`tournament_decisions`. The existing `usage_snapshots` table (per-turn token rows since 0.1) is kept
and finally read; availability snapshots are computed from `usage_events` and `usage_windows`, so the
brief's `usage_snapshots` entity needs no second table. One `ALTER TABLE projects ADD COLUMN kind TEXT
NOT NULL DEFAULT 'user'` marks Arena projects; it is the only change to an existing table. Indexes cover
every aggregation key. 0.1, 0.2 and 0.2.1 databases migrate in the existing single transaction.

## UI

Light is the default theme and the design target; dark remains as a token override.

### Tokens

`background, surface, surface-elevated, surface-muted, border, border-strong, text-primary,
text-secondary, text-muted, accent, accent-subtle, success, warning, danger, info, focus-ring`, plus
spacing (4 px grid), radius (4/6/8), type scale (page title 18, section 13 semibold, body 13, secondary
12, caption 11, mono 12), tabular numerals for figures, two densities, one shadow level for popovers and
dialogs only. Off-white background, white surfaces, hairline neutral borders, charcoal text, one indigo
accent. System font stack (Segoe UI Variable), Cascadia for code; no font is downloaded.

### Shell

Collapsible left navigation in three groups (Workspace: Home, Projects, Missions, Agents. Intelligence:
Arena, Policy, Usage, Repository. System: Overnight, Activity, Memory, Settings), Claude status and
version at the bottom. A slim contextual header per page (title, context, actions) replaces the
permanent toolbar; global status (Claude, agents, run, overnight, Git) sits at the right of that header
as short text with popovers. Ctrl+K palette with the actions of the brief.

### Pages

Home; Projects (list, detail, composer with a strategy selector); Mission Control (graph or timeline
left, inspector right, activity bottom, resizable and persisted); Task Inspector tabs Overview, Context,
Files, Messages, Review, Verification, History; Agents; Arena (campaign list, matrix, results); Policy
(current snapshot, per-context preference with evidence, candidates, history, compare, rollback, pin);
Usage (status, current run, history, breakdowns, limit events, efficiency); Overnight; Activity;
Settings. Every page has loading, empty, error and quota-paused states. A quota banner appears on every
page while a wait is active, with the known or unknown reset, the planned resume and the two actions.

Existing `data-testid` hooks are kept where the element still exists so the 0.2.1 E2E flows continue to
prove the same behaviour; tests change only where the interaction itself changed.

## Tests

Unit (pure modules), integration (migration from 0.1, 0.2, 0.2.1; repositories; fixture provisioning;
evaluator isolation; campaign persistence and recovery; quota pause and resume through the real
orchestrator with the scripted runtime and a manual clock), the 18 scenarios of the brief, integrity
regressions, stress (1000 orchestrator seeds, 1000 policy simulations, usage state-machine histories,
campaign state histories), Playwright E2E on the fake runtime including the quota states, and
screenshot comparisons of the listed screens with fixed data and a frozen clock.

## Real-runtime acceptance

A small real campaign (3 cases, 2 strategies), one speculative task, one ADAPTIVE mission, and a real
call of the no-prompt usage report. A real usage limit is not provoked; if none occurs, real quota
exhaustion stays NOT VERIFIED and the recovery path is proven by simulation only.

## Implementation notes

Found while writing the 0.3 documentation from the code. Where the two differ, the documents describe the code.

| Topic | Design | Implementation |
|---|---|---|
| Arena project marker | `ALTER TABLE projects ADD COLUMN kind` is the only change to an existing table | Migration 004 alters no table. Arena projects are identified by `arena_trials.project_id`: `projects.list()` excludes them, `listArena()` returns them |
| Evaluator hash | SHA-256 over the evaluator directory | The hash also covers the evaluation command, the timeout and the whole canonical definition |
| Import trust | The confirmation is stored with the evaluator hash | `trusted` is a boolean on `arena_case_versions`; `trustCaseVersion` re-hashes when trusting and `loadVerifiedCase` re-hashes on every use |
| Case budgets | Case budgets listed | Schema has `maxWallClockMinutes`, `maxAgentSessions`, `maxAgentsPerTrial`, `maxTurnsPerAgent`; the case-level `maxAgentSessions` is read by no code |
| Overnight Arena | A campaign started through the supervisor | Only a stored `overnight` flag on the campaign. Nothing in `overnight/` reads it and the IPC schema does not set it |
| Campaign pause reasons | `user`, `quota`, `budget`, `restart` | Only `user` and `quota` are set. A budget completes the campaign with an error note. Campaign state `failed` is never set |
| `arena.createCampaign` budgets | Full budget set | The IPC input exposes `maxConcurrentTrials` and `maxWallClockMinutes` only; `maxTrials`, `maxAgentSessions`, `maxAgentsPerTrial` and `overnight` are service-only |
| Trial with no integration branch | Evaluated as failed acceptance | An `arena_evaluations` row is written (not passed, skip reason, score 0); the evaluator is not run. Trial state is `failed` or `blocked` by how the run ended. A wall-clock timeout cancels the run and blocks the trial |
| Regression grouping | Groups by (NEXUS version, policy version, model) | See the later row: (NEXUS version, model signature), the two newest groups, common case versions |
| Convenience score | Weights 15/10/5/5/5 | Same weights; findings and repairs use `w/(1+n)`, time and usage use credit relative to the best passing peer of the same case in the same campaign. Scores are recomputed when another trial of the case finishes |
| Policy context of a trial | Case category, complexity and risk | The run's `TaskProfile` context key when present (inferred from the prompt), else the case's declared values |
| Repository-origin cases | A trial repository is a clone at the chosen commit | `provisionFromRepository` exists and is tested; `ArenaService` has no way to create such a case or campaign |
| `usage_snapshots` | Kept and finally read | Still written per turn and read by no service. Aggregation uses `usage_events` and `usage_windows` |
| `RUNTIME_UNAVAILABLE` | Entered from auth and runtime errors | The machine handles a `crashed` signal that nothing in `src/main` produces; only a probe outcome `runtime` enters it |
| `THROTTLED` | Overloaded or short retry-after | `overloaded` and `server_error` only; decays after 120 s or on the next agent message. No retry-after rule |
| Window status from a usage report | Not specified | NEXUS derives it from the percentage: 100 or more is `rejected`, 90 or more is `allowed_warning`. At 100 percent a report only gives `LIMIT_APPROACHING` and pauses nothing |
| Local work while waiting | In-flight checks and merges finish; `allowLocalTasksWhileWaiting` | In-flight checks and merges finish; a closed gate starts no task. The setting was removed: it had no behaviour |
| Overnight quota wait | Uses `planQuotaWait` and the shared probe | As designed, plus: the supervisor writes `quota_pauses` rows of scope `overnight` (with the limit type) and `quota_resumes` rows; `usage.overnightWaitForReset` off, `usage.maxQuotaWaitMinutes` exceeded and `MAX_QUOTA_WAITS` (6) end the run as `QUOTA_EXHAUSTED`. Without a probe object the 0.2.1 margin of 90 s applies |
| Test timing overrides | Not in the design | `NEXUS_USAGE_TICK_MS`, `NEXUS_USAGE_RESUME_DELAY_S`, `NEXUS_USAGE_PROBE_S` (unpackaged builds only) and `NEXUS_USAGE_DEMO_RESET_S` (demo script) |
| `ALWAYS_FOR_HIGH_RISK` | A distinct speculation policy | Only `OFF` is tested anywhere; `AUTO` and `ALWAYS_FOR_HIGH_RISK` behave the same |
| Resource layer | Defers speculation and may reduce parallelism | Also defers SWARM when Claude is not `AVAILABLE` or a limit was hit within the hour; halves the worker count (`THROTTLE_WORKER_DIVISOR` 2) when THROTTLED or LIMIT_APPROACHING |
| Candidate contexts | Proposed for a context | Proposed for exact contexts and category-level contexts (`category`, then wildcards), never the global one |
| Learning trigger | `learn()` recomputes statistics | Runs only through `policy.learn`, a user action; decisions use the statistics of its last run |
| Pooled label | Wilson interval on counts | `poolRow` uses the weighted pass proportion and the Wilson interval on raw Arena counts; the label uses the weighted n and is capped at WEAK below 3 cases, so it can differ from the stored `strategy_statistics` label |
| Fallback sufficiency | Each fallback level needs sufficient evidence | The threshold is WEAK (`levelSufficient`) |
| Outcome recording | A `mission_outcomes` row at the run's end | Also when a run pauses for an intervention, recorded as `blocked`; upserted by run. A completed run with no mission criteria counts as success |
| Explicit strategy | Every run records a decision | A concrete strategy skips the engine: a task profile and the snapshot id are stored, no decision. The `user` layer and `forced` input exist but are unused |
| `USER_SPECIFIED` basis | Profiler takes user-specified fields | The orchestrator and the Arena never pass them, so the basis is not produced in 0.3 |
| Pin and rollback | Pointer moves only | A promotion while pinned builds on the pointer's snapshot while new decisions keep using the pinned one; rollback goes back one step only |
| Policy configuration | Not described | `policy.setConfig` (exploration, speculation) creates a snapshot with origin `config`; no other field can be changed |
| ADAPTIVE without a policy service | Not described | The orchestrator resolves it to BUILD and records nothing |
| Provider abstraction | Not in the 0.3 design | Only the `AgentRuntime` interface with `ClaudeSdkRuntime` and `FakeAgentRuntime` exists; no provider class or registry |
| Speculative candidates | Worktrees `nexus/<run>/<task>-cand-a` | Separate clones (`git clone --no-hardlinks --no-tags`, remote removed) at the base commit; states `running`, `decided`, `adopted`; the winner is fetched and fast-forwarded; messages sent to the task reach every candidate; the tournament order is total |
| Trial outcome | Failed, blocked, passed | `blockKind` (`infrastructure`, `run`, `timeout`) on a blocked trial; `trialOutcome()` counts run and timeout blocks as failures and excludes infrastructure blocks from n and from policy evidence; a result commit that collides with an evaluator path fails the trial as tampering |
| Evidence label in the Arena | Label by n | Capped at WEAK below 3 distinct cases (`MIN_CASES_FOR_EVIDENCE`); `StrategyComparisonRow.cases` and `excludedInfrastructure`; efficiency means over passed trials only; result notes for single-case rows, multiple comparisons, agent caps and passed-only efficiency |
| Wall clock in a trial | Wall clock | `wallClockMs` excludes quota waits; campaign and trial budget clocks are persisted in the settings key/value table and survive a restart |
| Strategy order in a campaign | Repetition outermost | Also counterbalanced: the strategy order rotates by (case index + repetition - 1) |
| Case `case.json` | Version plus evaluator hash | The hash covers the whole definition; the stored definition runs; `.git` entries are refused; imports are capped at 5000 files and 50 MB; all built-in cases are version 2 with an explicit evaluator file and `maxAgentsPerTrial` 8 |
| Budget presets | `maxAgentsPerTrial` 2, 4, 6 | 2, 8, 8, so BALANCED and RESEARCH never cap a strategy below its own parallelism |
| Node for cases | Not covered | A preflight (`arena.status`) requires Node.js 20 or newer on `PATH`; a campaign cannot start without it; an evaluator that runs zero tests is an infrastructure block |
| Unattended trials | Approvals not specified | The Arena answers approvals: tool requests denied, plan, task and graph approvals granted, a high-risk task start denied |
| Command environment | Not in the design | Setup, check and Arena commands run with `projectCommandEnv()`; the Arena also removes `ANTHROPIC_*` and `NODE_TEST_CONTEXT` |
| Trial Git | Not in the design | Hook-free, config-free Git on case content; tamper-safe evaluator copy; `arena.cleanup` removes a finished campaign's trial directories; `arena.trustCase` shows a native confirmation |
| Regression grouping | (NEXUS version, policy version, model) | (NEXUS version, model signature), the two newest groups |
| Campaign end | Learning on demand | A completed campaign calls `PolicyService.learn()` once (`learnOnCampaignEnd`); it never promotes |
| Suppression | At least 3 effective samples with no success, or 2 failures, in the window | Judged per context level on that level's own evidence; stability failures must be at least 2 (weighted) and more than half of the effective observations; a passed trial is never a stability failure |
| Candidate threshold | Challenger MODERATE, incumbent WEAK | Also at least 5 Arena trials from at least 3 distinct cases at the challenger's level; observational evidence alone never produces a candidate; a rejected candidate returns only after 5 more Arena trials; `promote` refuses a stale candidate; `learn()` judges against the head snapshot |
| Model drift | Recorded model differs from the configured one | Exact resolved model id compared with the newest evidence's models |
| Usage service failure in the policy | Not specified | Status `RUNTIME_UNAVAILABLE` with a note, so SWARM and SPECULATIVE are deferred |
| Plain assistant `rate_limit` | Quota | A quota only after a rejected rate-limit event or a usage-limit text; otherwise a throttle. `billing_error` is always a quota and is checked with a minimal session, never from the report alone |
| Later rejection without a reset | Not specified | It keeps a reset already known |
| Probe | Usage report, then minimal session | Window-aware: a stale 100 percent window is not a limit; a rejection with no window type goes to the minimal session |
| Repeated rejection after a resume | Not specified | A rejection within 10 minutes of an automatic resume continues the same wait; after `MAX_FAILED_RESUMES` (6) the wait ends |
| Ended wait across a restart | Not specified | Stays ended; the run waits for a manual resume |
| Gate release in an Overnight wait | Not specified | Every exit releases the gate; a gate nobody owns reopens after `ORPHAN_QUOTA_MS` (30 s) |
| Agents ended by quota or auth | Not specified | State `stopped`, not `failed` |
| Stale plan windows | Not specified | Reset passed or older than `USAGE_WINDOW_MAX_AGE_MS` (30 minutes): no percentage, confidence UNKNOWN |
| `allowLocalTasksWhileWaiting` | A setting | Removed: it had no behaviour |
| Database upgrade | Single transaction | Also keeps `nexus.db.v<old>.bak` before an upgrade |
