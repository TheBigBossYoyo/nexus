# Arena (0.3)

The Arena runs the same task under different orchestration strategies, each in its own fresh
repository, scores every result with a hidden test suite the agents never see, and keeps the raw
metrics. It exists to put numbers, with their sample sizes, under the question "which strategy suits which
kind of task".

NEXUS does not claim universal superiority of any strategy. Arena results describe the cases, models and
versions that were run, and nothing else.

Code: `src/main/modules/arena/` (`case-format.ts`, `fixtures.ts`, `evaluator.ts`, `metrics.ts`,
`scoring.ts`, `campaign.ts`), contracts in `src/shared/v3.ts` and `src/shared/v3-read.ts`, IPC in
`src/main/modules/ipc/v3-handlers.ts`, cases in `arena/cases/`. How results are scored and read:
[BENCHMARK_METHODOLOGY.md](BENCHMARK_METHODOLOGY.md). How the policy consumes trials:
[ADAPTIVE_POLICY.md](ADAPTIVE_POLICY.md).

## Vocabulary

| Term | Meaning |
|---|---|
| Case | A task with a fixture repository, a visible prompt and criteria, and a hidden evaluator |
| Case version | One immutable `(case id, version)`; stored with the hash of its evaluator and its fixture |
| Campaign | A persisted set of trials: cases x strategies x repetitions, with budgets |
| Trial | One `(case version, strategy, repetition)`: one provisioned repository, one NEXUS run, one evaluation |
| Strategy | One of `CONCRETE_STRATEGIES`: `SINGLE`, `BUILD`, `SWARM`, `CONSENSUS`, `SPECULATIVE` (`ADAPTIVE` is not an Arena strategy: it would pick one of these) |

## Case format

```
arena/cases/<id>/
  case.json     the definition, validated by ArenaCaseDefinitionSchema (strict: unknown keys are refused)
  fixture/      the repository the agent sees; becomes commit 1 of a fresh Git repository
  evaluator/    hidden tests; copied in by NEXUS only after the run has ended
  README.md     optional; what the case measures and why the hidden tests are fair
```

JSON is used instead of YAML: no YAML parser is a dependency.

### `case.json`

| Field | Type and limits | Meaning |
|---|---|---|
| `id` | string, 1 to 64, `^[a-z0-9][a-z0-9-]*$` | Kebab-case id; also the directory name by convention |
| `version` | integer, at least 1 | Case version. Versions only increase |
| `name` | string, 1 to 120 | Display name |
| `description` | string, non-empty | One-paragraph summary |
| `category` | `bugfix`, `feature`, `refactor`, `migration`, `performance`, `security`, `testing`, `ui`, `infrastructure`, `architecture` | Declared task category |
| `complexity` | `small`, `medium`, `large` | Declared complexity |
| `risk` | `low`, `medium`, `high` | Declared risk |
| `languages`, `frameworks` | string arrays | Informational |
| `taskPrompt` | string, non-empty | The task text given to the run |
| `visibleAcceptance` | array of non-empty strings, at least 1 | Criteria given to the agents; appended to the prompt as `Acceptance criteria:` and stored as the run's mission criteria |
| `checks` | `{ build, test, lint, typecheck }`, each a command line or `null` | Visible check commands; become the run's check commands |
| `setup` | array of command lines | Run once in the trial repository before the baseline commit |
| `hiddenEvaluation` | `{ command, timeoutSeconds }`; timeout 5 to 3600 | The evaluator command line and its timeout |
| `budgets` | `maxWallClockMinutes` 1 to 1440, `maxAgentSessions` 1 to 500, `maxAgentsPerTrial` 1 to 16, `maxTurnsPerAgent` 5 to 400 (integers) | Per-trial limits, see "Budgets" |
| `allowedStrategies` | array of concrete strategies, at least 1 | Strategies a campaign may run on this case |
| `scoring` | optional `{ band?: 0.01 to 1, weights?: { findings, verification, repairs, time, usage: 0 to 40 } }` | Override of `score-v1` parameters; stored with the result. `weights`, when present, must give all five |
| `metadata` | optional string map | Informational |

Every command in a case (`setup`, `checks`, `hiddenEvaluation.command`) is parsed with
`tokenizeCommandLine` when the case is loaded. A command with a shell operator is refused: cases never
rely on a shell. Commands run through `runCommandLine`, which does not use a shell.

### Loading and versioning (`case-format.ts`)

| Rule | Where |
|---|---|
| `case.json` must be valid JSON and pass the schema; the error lists every issue with its path | `loadCaseDirectory` |
| `fixture/` and `evaluator/` must each contain at least one file | `loadCaseDirectory` |
| A case directory may not contain symbolic links | `listFilesRecursive` |
| `fixtureHash` = SHA-256 over sorted relative paths and file contents. Text files are hashed with LF line endings, so autocrlf does not change a case's identity | `hashDirectory`, `normalizedBytes` |
| `evaluatorHash` = SHA-256 over the evaluator directory hash, the evaluation command and its timeout. Changing the files, the command or the timeout is a different evaluator | `hashEvaluator` |
| A new `version` creates a new `arena_case_versions` row | `registerLoadedCase` |
| The same `version` with a different evaluator hash or fixture hash is refused: bump `version` | `registerLoadedCase` |
| A version lower than the latest registered one is refused: versions only increase | `registerLoadedCase` |
| A case id registered with one origin cannot be re-registered with another (an imported case cannot take over a built-in id) | `registerLoadedCase` |
| Before every provisioning and every evaluation the directory is re-read and re-hashed; a mismatch with the stored hashes refuses the trial | `loadVerifiedCase` |

The design said the evaluator hash covered the evaluator directory; the code also hashes the command
and timeout.

### Trusted and imported cases

| Origin | `trusted` | How it is created |
|---|---|---|
| `builtin` | true on registration | `ArenaService.syncBuiltinCases()` at startup, from `arena/cases` (dev) or `resources/arena/cases` (packaged, `electron-builder.yml`). Throws when a shipped evaluator changed without a version bump |
| `imported` | false | `arena.importCase` opens a folder picker; `importCase` registers the directory and returns the full list of commands (`setup:`, `check:`, `hidden evaluation:`). Nothing from the case is executed at import |
| `repository` | n/a | The type exists (`ArenaCase.origin`, and `provisionTrial` accepts a `repository` input that clones a local repository at a commit). No code path creates such a case or campaign: see Limits |

`arena.trustCase` marks an imported version trusted. It re-reads the directory first and refuses when the
version, evaluator hash or fixture hash differ from what was stored at import, so a case edited after the
user reviewed its commands cannot be trusted by accident. `createCampaign` refuses any untrusted case
version. The trust flag is a boolean on the version row; the design said the confirmation is stored with
the evaluator hash. In the code the hash is re-checked at trust time and on every later load.

## Built-in cases

Twelve cases, all version 1, all JavaScript (node:test, no dependencies), all allowing all five concrete
strategies. Visible check: `node --test`. Hidden evaluation: `node --test hidden-tests/**/*.test.mjs`,
timeout 120 s (the glob is expanded by Node, not a shell). Per-case budgets are
`wall-clock minutes / agent sessions / agents per trial / turns per agent`.

| Id | Category | Complexity | Risk | Budgets | What it measures |
|---|---|---|---|---|---|
| `bugfix-localized` | bugfix | small | low | 20 / 20 / 4 / 60 | One-token defect in a pagination helper: a last page holding one item is lost |
| `bugfix-cross-module` | bugfix | medium | medium | 25 / 30 / 4 / 60 | Wrong totals and stock when an order is priced or reserved twice; the cause is in a shared helper |
| `bugfix-concurrency` | bugfix | large | high | 30 / 40 / 4 / 70 | Semaphore, job queue, read-through cache and `mapLimit` misbehave under concurrency, failure and cancellation |
| `feature-small` | feature | small | low | 20 / 20 / 4 / 60 | A well-specified group-by-and-sort summary function in a small report library |
| `feature-multi-module` | feature | large | medium | 40 / 60 / 4 / 80 | Priorities and due dates in a todo library: model, versioned storage with backwards compatibility, service, rendering, flags |
| `refactor-extract` | refactor | medium | medium | 20 / 20 / 4 / 60 | Behaviour-preserving extraction of line pricing duplicated in three modules into one shared module |
| `migration-schema` | migration | medium | high | 30 / 30 / 4 / 70 | Versioned, idempotent, non-lossy v1 to v2 migration of a JSON contact store, with backup and corrupt-entry reporting |
| `performance-optimization` | performance | medium | low | 25 / 30 / 3 / 60 | A correct log-analytics toolkit that collapses on realistic sizes; remove algorithmic hot spots without changing results |
| `security-hardening` | security | large | high | 40 / 40 / 4 / 80 | Classic vulnerabilities in a static-serving, upload, config, templating and auth helper library |
| `testing-gap` | testing | medium | low | 25 / 30 / 3 / 60 | A cron library with shallow tests; write a regression suite strong enough to catch behavioural bugs in every module |
| `ui-state-bug` | ui | medium | low | 25 / 30 / 3 / 60 | Framework-free state layer of a to-do panel mutates state and derives counts from the wrong data |
| `recovery-persistence` | infrastructure | large | high | 40 / 50 / 4 / 80 | An embedded key/value store with journal and snapshots that loses data after a crash |

Each case's `README.md` states what it measures and why its hidden tests are fair. The `architecture`
category exists in the schema; no built-in case uses it.

Reference solutions live outside the case directories, in `tests/fixtures/arena-solutions/<id>/`. An
integration test (`tests/integration/arena/builtin-cases.test.ts`) checks for each case that the visible
tests pass on the fixture, the hidden evaluator fails on the unmodified fixture, and the evaluator passes
on the reference solution. A case directory contains exactly `README.md`, `case.json`, `evaluator`,
`fixture`.

## Trial lifecycle

Trial states (`TRIAL_STATES`): `queued`, `provisioning`, `running`, `evaluating`, `passed`, `failed`,
`blocked`, `cancelled`. Terminal: `passed`, `failed`, `blocked`, `cancelled`.

```
queued -> provisioning -> running -> evaluating -> passed | failed | blocked
   \          \              \            \
    +----------+--------------+------------+--> cancelled   (campaign cancelled / budget)
              \-> blocked (provisioning or run start failed)
```

### Provisioning (`fixtures.ts`, `provisionTrial`)

1. The trial directory is `<data>/arena/<campaign short id>/<trial short id>/`. It may not contain, or be
   inside, the case directory.
2. The case is re-read and re-hashed (`loadVerifiedCase`).
3. The trial directory is removed if it exists, then created: a re-provisioned trial is identical to a
   first attempt.
4. `fixture/` is copied (not linked, symlinks dereferenced) to `<trial>/repo`.
5. The case's `setup` commands run there. Timeout 10 minutes each, output capped at 64 KiB. A failing
   setup command fails provisioning.
6. `assertNoEvaluatorFiles` checks that no evaluator file exists in the repository, by relative path
   (case-insensitive) or by content hash. An evaluator file that is byte-identical to a fixture file is
   allowed (that content is already visible to the agent).
7. `git init --initial-branch=main`, local config (`NEXUS Arena <arena@nexus.invalid>`,
   `commit.gpgsign=false`, `core.autocrlf=false`), `git add -A`, one commit `Arena baseline <id>@<version>`
   with author and committer date fixed at `2000-01-01T00:00:00Z`. The baseline commit id is therefore a
   function of the fixture alone: two trials of one case version share it.
8. A project is opened on `<trial>/repo` (`projects.open`). The hidden project is found through
   `arena_trials.project_id` (`repos.projects.listArena`), and Projects and Activity lists leave it out.

The repository-origin path (`provisionFromRepository`) exists but is unreachable from the service: it
clones with `--no-hardlinks`, checks out the commit on a branch `arena-baseline`, removes the `origin`
remote, runs setup, checks for evaluator files, and fails if the source repository's HEAD, branch or
status changed meanwhile.

### The run

The Arena calls `ArenaRunHost.createRun` (adapted to the real orchestrator in `src/main/index.ts`) with:

| Input | Value |
|---|---|
| `mode` | `build` |
| `preset` | the campaign's `modelPreset` (`eco`, `balanced` or `maximum`), the same for every strategy |
| `prompt` | `taskPrompt` plus `Acceptance criteria:` and the `visibleAcceptance` bullets |
| `acceptanceCriteria` | `visibleAcceptance` |
| `strategy`, `arenaTrialId` | the trial's concrete strategy and id |
| `overrides` | `requirePlanApproval: false`; `maxParallelAgents: min(campaign.maxAgentsPerTrial, case.maxAgentsPerTrial)`; `maxTurnsPerAgent`; `maxDurationMinutes` = case wall-clock; `checks` = case checks; `respectProjectClaudeConfig: false` |

In an Arena run `maxParallelAgents` is a cap: `Orchestrator.createRun` applies
`min(strategy plan parallelism, cap)`, so each strategy keeps its own parallelism below the cap (see
[ORCHESTRATION.md](ORCHESTRATION.md)). Each trial has its own project, so project memory, repository
facts and task outcomes cannot reach another trial. Tool approvals cannot be given in a trial: a run that
reaches `awaiting_approval` is cancelled and the trial is `blocked`. A run paused for any reason other
than `quota` or `recovery` is cancelled and the trial is `blocked` with the pause error.

### Waiting for the run (`waitForRunEnd`)

Run events (`run.completed`, `run.failed`, `run.cancelled`, `run.paused`, `run.resumed`,
`run.state_changed`) wake the job; a poll every 2000 ms is a safety net. The trial clock runs while the
run is active. It stops while the run is paused for `quota`. At the case's `maxWallClockMinutes` the run is
cancelled (`timeout`) and the trial ends `blocked` with the detail "Trial exceeded the case wall-clock
budget". A run paused for `recovery` after a restart is resumed once through the host.

### Hidden evaluation (`evaluator.ts`, `evaluateTrial`)

1. The service waits until the run has no active agents (`agentSettleMs`, default 10 s). If agents are
   still active the trial is `blocked`: the evaluator never runs next to an agent.
2. The result commit is the head of the run's integration branch, resolved in the trial repository. It is
   set only when the run ended `completed`. A run that failed, was cancelled, timed out or blocked has no
   result commit.
3. Raw metrics are collected and stored before the evaluator runs, so a failing evaluator still leaves
   numbers.
4. With no result commit the evaluator does not run. The evaluation row records `passed = false`, the
   skipped reason and score 0. The evaluator is not run on the unmodified fixture.
5. Otherwise: the case is re-verified by hash; `<trial>/eval` is created by `git clone --no-hardlinks
   --no-checkout` of the trial repository, the result commit is checked out detached, `.git` is removed
   (a plain file export with no link back), and the evaluator directory is copied over it (evaluator files
   win over same-named files from the agent). The evaluation command runs there with the case timeout and
   a 16 KiB output cap (tail kept). `eval/` is removed in a `finally`, whatever the outcome.
6. Passed means exit code 0 and no timeout. An evaluator that cannot start is a failed evaluation with the
   reason in the output.
7. The evaluator runs only in `<trial>/eval`. It does not run the case's `setup` commands.

### Final state of a trial

| Condition | State | Detail |
|---|---|---|
| Hidden evaluation passed | `passed` | |
| Run `completed`, evaluation failed | `failed` | `Hidden acceptance failed (exit n)` or `Hidden evaluation timed out` |
| Run `failed` | `failed` | `The run failed: <error>` |
| Run cancelled, timed out, blocked, no integration commit | `blocked` | the reason |
| Provisioning or run start failed, evaluation threw | `blocked` | `Provisioning failed: ...`, `Could not start the run: ...`, `Evaluation failed: ...` |
| Campaign cancelled or budget closed while queued or running | `cancelled` | |

A trial that fails does not stop the campaign. Evaluations are stored in `arena_evaluations`: the command,
exit code, timeout flag, duration, output tail, `passed`, the skip reason, `evaluatorHash`, `scoreVersion`
(`score-v1`), the score and its breakdown. The output is for people; it is never sent to an agent.

## Campaigns

`ArenaService` owns a persisted queue. Campaign states (`CAMPAIGN_STATES`): `draft`, `running`, `paused`,
`completed`, `cancelled`, `failed`. The service sets `draft`, `running`, `paused`, `completed` and
`cancelled`; nothing in the code sets `failed`.

```
draft -> running <-> paused (user | quota) -> completed
                \-> cancelled (any non-final state)
```

### Creating a campaign

`createCampaign` expands `repetition x case x strategy` with repetition as the outermost loop, so a
campaign cut short by a budget still has balanced strategies. A `(case, strategy)` pair is planned only
if the case allows the strategy. Duplicate strategies are removed. Creation fails when no case or no
strategy is chosen, a case is untrusted, no pair is allowed, or the trial count exceeds `maxTrials`. The
trials are inserted `queued` with their `ordinal` in one transaction; execution order follows the
ordinal. The environment (platform, OS release, Node, SDK version, Git version, model tier aliases), the
NEXUS version and the active policy snapshot id are recorded on the campaign.

### Budget presets (`ARENA_BUDGET_DEFAULTS`)

| Preset | `maxWallClockMinutes` | `maxTrials` | `maxConcurrentTrials` | `maxAgentSessions` | `maxAgentsPerTrial` |
|---|---|---|---|---|---|
| `eco` | 120 | 12 | 1 | 120 | 2 |
| `balanced` | 360 | 40 | 1 | 400 | 4 |
| `research` | 720 | 120 | 2 | 1500 | 6 |

The UI (IPC `arena.createCampaign`) can override `maxConcurrentTrials` (1 to 4) and
`maxWallClockMinutes`. The service also accepts `maxTrials`, `maxAgentSessions`, `maxAgentsPerTrial` and
`overnight`, but the IPC schema does not carry them. `repetitions` is 1 to 20, at most 50 cases and 5
strategies per request.

### What each budget does

| Budget | Checked | Effect when reached |
|---|---|---|
| `maxTrials` | At creation only | The campaign is refused |
| `maxWallClockMinutes` | A timer re-armed every 5 s while the campaign is `running`; counts active time only (a quota pause or a user pause stops the clock) | `exhaust`: queued trials cancelled, running trials stopped (run cancelled), campaign completes with `error = "Budget: maxWallClockMinutes (n) reached"` |
| `maxAgentSessions` | Before a trial is scheduled and after each trial ends (sum of `sessions` in stored trial metrics) | Same, with `Budget: maxAgentSessions (n) reached`. A running trial can overshoot the limit before the check |
| `maxAgentsPerTrial` | At run creation | Cap on parallel agents, lower of campaign and case value |
| `maxConcurrentTrials` | At scheduling | At most this many jobs per campaign, started in ordinal order |
| Case `maxWallClockMinutes` | Per trial, while the run is active | Run cancelled, trial `blocked` |
| Case `maxTurnsPerAgent` | Passed to the run | Run limit |
| Case `maxAgentSessions` | Not read by any code | None |

A stopped trial after a campaign budget is `cancelled`, not evaluated.

### Pause, resume, cancel

| Action | Effect |
|---|---|
| `arena.pause` | Campaign `paused`, reason `user`. No new trial starts. Running trials continue and are evaluated. It does not pause their runs |
| `arena.resume` | Back to `running`, scheduling continues |
| `arena.cancel` | Queued trials cancelled, running trials stopped and their runs cancelled, campaign `cancelled` |
| `arena.start` | Only for a `draft` |

### Quota pause

The Arena derives a quota pause; it does not run a second recovery. The campaign becomes `paused` with
reason `quota` when the usage dispatch gate is closed (`usage.canDispatch()` false) or when a running
trial's run is paused for `quota`. It returns to `running` by itself when both clear. While the gate is
closed no trial starts. A user pause is not undone when the gate opens. The trial's own timeout clock stops
during the quota pause. The run itself is resumed by the quota recovery controller, see
[QUOTA_RECOVERY.md](QUOTA_RECOVERY.md). `quotaPauses`, `quotaWaitMs` and `autoResumeSuccesses` are
recorded per trial.

### Recovery after a restart (`ArenaService.recover()`)

Called at startup after `syncBuiltinCases()`.

| Found | Action |
|---|---|
| Open trials of a finished or cancelled campaign | Cancelled, `Campaign ended before the trial finished` |
| `queued`, campaign closed by a budget (`error` starts with `Budget:`) | Cancelled |
| `provisioning`, or `running` with no run | Back to `queued`; re-provisioned from scratch in a clean directory |
| `running` with a run | Re-attached: waits for the run (a run paused for `recovery` is resumed) and evaluates it |
| `evaluating` | Evaluated again. Evaluation is a function of the result commit; the old evaluation row is replaced |
| `running` campaign | Wall-clock budget clock preloaded as `now - startedAt` |

The preload counts the whole elapsed time since `startedAt`, including any time the application was
closed or paused. It is not exact.

## Raw metrics

`collectTrialMetrics` reads durable rows only, after the run ended and the agents stopped. Null means not
measured and is never replaced by a guess. A count that is zero because nothing happened is zero. The
metrics row is stored in `arena_trial_metrics` (one per trial, replaced on re-evaluation).

| Field | Type | Measured as | Null when |
|---|---|---|---|
| `buildPassed`, `typecheckPassed`, `testsPassed` | bool or null | Newest mission-level `checks` verification: the command named `build`, `typecheck`, `test` exited 0 without timeout | No mission-level checks verification, or that command was not part of the run |
| `hiddenPassed` | bool or null | Hidden evaluator result | The evaluator result is not yet known (first row, before evaluation) |
| `acceptanceTotal`, `acceptancePassed` | int or null | Mission-level criteria (task id null), total and those with status `passed` | The run has no mission-level criteria |
| `verifierPassed` | bool or null | Newest mission-level `verifier` verification | No verifier ran |
| `criticalFindings`, `highFindings`, `mediumFindings` | int | Findings standing at the end: for each task only its last review counts, and only when its verdict was `changes_requested`; findings the dual-review arbiter rejected are excluded | Never null |
| `repairs` | int | Tasks with a parent task, of kind `repair`, or with key prefix `mission-fix-` | Never null |
| `wallClockMs` | int or null | `run.finishedAt - run.startedAt`. Includes quota waits | The run has no start or finish time |
| `sessions` | int | Rows in the session table over every agent of the run | Never null |
| `turns`, `toolCalls` | int or null | Sum of agent metrics | The run has no agents |
| `inputTokens`, `outputTokens` | int or null | Sum of the agents' reported token counts, ignoring agents that reported none | No agent reported any |
| `humanInterventions` | int | `user.intervention` events (up to 2000) | Never null |
| `approvals` | int | Approvals that are no longer pending | Never null |
| `manualRetries` | int | Intervention events with action `retry_task` | Never null |
| `blockers` | int | Messages of type `blocker` | Never null |
| `crashedAgents` | int | Distinct agents in state `failed` or named by an `agent.failed` event | Never null |
| `recoveredSessions` | int | `run.recovered` events | Never null |
| `schedulerFailures` | int | `task.lease_expired` events | Never null |
| `unfinishedTasks` | int | Tasks neither `completed` nor `cancelled` | Never null |
| `quotaPauses` | int | `quota_pauses` rows of the run (run-scoped; a global gate pause has no run) | Never null |
| `quotaWaitMs` | int | Sum of pause durations; an open pause counts to the run's end or now | Never null |
| `autoResumeSuccesses` | int | `quota_resumes` rows of kind `resume` with result `resumed` | Never null |
| `throttleEvents` | int | `usage_events` of type `throttle` for the run (first 500) | Never null |

Observed tokens are what NEXUS's own sessions reported. They have no denominator.

## Results

`arena.campaign` returns the campaign, a case x strategy matrix with each trial's state and score, a
per-strategy comparison and the usage totals of the campaign. `arena.results` returns the same comparison
over all finished trials (optionally one campaign or the last `sinceDays`, default 3650), a per-case
breakdown, regression flags and plain-language notes. Statistics, labels and notes are defined in
[BENCHMARK_METHODOLOGY.md](BENCHMARK_METHODOLOGY.md).

A trial counts in pass proportions when it is `passed`, `failed` or `blocked` and has an evaluation row.
A trial that never reached evaluation (provisioning failure, cancellation) does not count.

Regression detection compares only the oldest and the newest NEXUS version group (by the earliest
creation time of the group's campaigns), over case versions that both groups ran. It does not compare
policy versions or models, and it ignores groups in between.

## How the policy consumes trials

`PolicyService.learn()` reads trials finished within the evidence window (`evidenceWindowDays`, default
365). Each trial becomes one observation:

| Aspect | Rule |
|---|---|
| Context | The `contextKey` of the trial's `TaskProfile` when the run produced one; else `category | complexity | risk` from the case definition |
| Skipped | `cancelled`, `queued`, `provisioning`, `running`, `evaluating` |
| Success | `hiddenPassed === true` |
| Stability failure | State `blocked`, or `crashedAgents > 0`, or `schedulerFailures > 0` |
| Weight | 1, times the recency weight (half-life 90 days by default), times `modelDriftWeight` (0.5) when the recorded models differ from the models now configured |

Arena trials are kept as `kind = 'arena'` in `strategy_statistics`; real-mission outcomes are `kind =
'mission'`, weighted `missionWeight` (0.5) and flagged observational. Arena evidence is controlled;
mission history is observational and weighted lower; neither is pooled in displayed counts ("18 of 21
Arena trials and 4 of 6 real missions (observational)"). Runs of Arena trials record an outcome flagged
`isArena` and are excluded from mission evidence. Policy changes only by explicit promotion, and learning
never rewrites NEXUS source code. Details: [ADAPTIVE_POLICY.md](ADAPTIVE_POLICY.md).

Note that learning counts every `blocked` trial as a failure of its strategy, including a trial blocked
by a provisioning failure, which the Arena results table leaves out.

## IPC channels

All are in the `v3-handlers.ts` registry and validated by the schemas in `src/shared/ipc.ts`.

| Channel | Input | Returns |
|---|---|---|
| `arena.cases` | none | `ArenaCaseSummary[]` (case row and latest version) |
| `arena.importCase` | none; opens a folder picker | `{ summary, commands }` or null when cancelled; registered untrusted |
| `arena.trustCase` | `caseVersionId` | the trusted `ArenaCaseVersion` |
| `arena.campaigns` | `limit` 1 to 100, `offset` | `{ campaigns, total }` with state counts |
| `arena.createCampaign` | `name`, `caseIds`, `strategies`, `repetitions`, `modelPreset`, `budgetPreset`, optional `maxConcurrentTrials`, `maxWallClockMinutes`, `start` | `ArenaCampaign` |
| `arena.campaign` | `campaignId` | detail: cases, matrix, comparison, usage totals |
| `arena.trials` | `campaignId`, `limit` 1 to 200 (default 100), `offset` | `{ trials, total }` with metrics, score, hidden result, run state |
| `arena.trial` | `trialId` | trial, case, metrics, evaluation, task profile |
| `arena.start`, `arena.pause`, `arena.resume`, `arena.cancel` | `campaignId` | `ArenaCampaign` |
| `arena.results` | optional `campaignId`, `sinceDays` 1 to 730 | comparison, by case, regressions, notes, total trials |

The service pushes `{ kind: 'arena', campaignId }` after every state change. `home.*` channels summarize
the latest campaign.

## Database

Migration 004 (`src/main/modules/persistence/migrations/004-v0-3.ts`), additive.

| Table | Content |
|---|---|
| `arena_cases` | Case id, name, origin, category, complexity, risk, latest version, source path |
| `arena_case_versions` | `(case_id, version)` unique; definition JSON, `evaluator_hash`, `fixture_hash`, `trusted` |
| `arena_campaigns` | State, pause reason, case version ids, strategies, repetitions, model preset, budgets, `overnight`, policy snapshot id, NEXUS version, environment, error, times |
| `arena_trials` | Campaign, case version, strategy, repetition, ordinal, state, project, run, repo path, baseline and result commit, policy snapshot, task profile, resolved models, detail, times |
| `arena_trial_metrics` | One row per trial, the fields above |
| `arena_evaluations` | The hidden evaluation and the score |

Also written for Arena runs: `task_profiles.arena_trial_id`, `mission_outcomes.is_arena`,
`usage_events.arena_campaign_id`. The design planned `projects.kind`; the migration adds no column to
`projects`. A trial's project is identified through `arena_trials.project_id`.

## Limits

- Repository-origin cases: `provisionTrial` can clone a user repository at a commit, but
  `ArenaService` has no method to create such a case or campaign. Only built-in and imported case
  directories can be run.
- Overnight Arena under the supervisor is not implemented in 0.3. `ArenaCampaign.overnight` is stored
  and the IPC schema does not set it; nothing in `overnight/` reads it. A campaign is a normal campaign
  that stops on its own budgets.
- Pausing a campaign does not pause running runs; they finish and are evaluated.
- Budgets are checked after each trial (`maxAgentSessions`) or on a 5 s timer (`maxWallClockMinutes`);
  `maxTrials` only at creation. The session budget can be exceeded by the trial that is running.
- Case `budgets.maxAgentSessions` is part of the schema and is not enforced.
- Regression detection compares the oldest and newest NEXUS version group only.
- `wallClockMs` includes quota waits; the budget clocks do not. Compare `quotaWaitMs`.
- Scores are relative to the passing trials of the same case in the same campaign and are recomputed when
  another trial of that case finishes. They are not comparable across campaigns. Compare pass rates and
  raw metrics.
- Campaign state `failed` exists and is never set.
- Evaluators are checked for presence in the trial repository only at provisioning. A later agent write of
  a file with the evaluator's name is not an error: the evaluator copy overwrites it.
- Every built-in case is a small JavaScript project. Results say nothing about other languages, large
  repositories, or work that needs network access or services.
- A trial uses the real Claude runtime and spends the account's usage. A `research` campaign can plan up to
  120 trials.

## Not verified

- A real Arena campaign has not been run at the time of writing: see V0_3_RELEASE_REPORT.md. All campaign,
  isolation, evaluation, budget, quota and restart behaviour is covered by unit, integration, scenario and
  seeded stress tests with the scripted runtime (`FakeAgentRuntime`) only.
- The real runtime's behaviour during an Arena quota pause is not verified; see
  [QUOTA_RECOVERY.md](QUOTA_RECOVERY.md).
