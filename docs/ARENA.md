# Arena (0.3)

The Arena runs the same task under different orchestration strategies, each in its own fresh
repository, scores every result with a hidden test suite the agents never see, and keeps the raw
metrics. It exists to put numbers, with their sample sizes, under the question "which strategy suits which
kind of task".

NEXUS does not claim universal superiority of any strategy. Arena results describe the cases, models and
versions that were run, and nothing else.

Code: `src/main/modules/arena/` (`case-format.ts`, `fixtures.ts`, `evaluator.ts`, `metrics.ts`,
`scoring.ts`, `campaign.ts`, `preflight.ts`, `env.ts`), contracts in `src/shared/v3.ts` and `src/shared/v3-read.ts`, IPC in
`src/main/modules/ipc/v3-handlers.ts`, cases in `arena/cases/`. How results are scored and read:
[BENCHMARK_METHODOLOGY.md](BENCHMARK_METHODOLOGY.md). How the policy consumes trials:
[ADAPTIVE_POLICY.md](ADAPTIVE_POLICY.md).

## Vocabulary

| Term | Meaning |
|---|---|
| Case | A task with a fixture repository, a visible prompt and criteria, and a hidden evaluator |
| Case version | One immutable `(case id, version)`; stored with its whole definition, the hash of its evaluator and the hash of its fixture |
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
| Neither `fixture/` nor `evaluator/` may contain a `.git` entry (any case, any depth) | `listFilesRecursive` |
| A case directory is capped at `MAX_CASE_FILES` = 5000 files and `MAX_CASE_BYTES` = 50 MB | `listFilesRecursive`, `loadCaseDirectory` |
| `fixtureHash` = SHA-256 over sorted relative paths and file contents. Text files are hashed with LF line endings, so autocrlf does not change a case's identity | `hashDirectory`, `normalizedBytes` |
| `evaluatorHash` = SHA-256 over the evaluator directory hash, the evaluation command and timeout, and the canonical JSON of the whole validated definition (setup, checks, prompt, criteria, budgets, allowed strategies, scoring). Any change to the files or to `case.json` is a different hash | `hashEvaluator`, `hashCaseEvaluator` |
| A new `version` creates a new `arena_case_versions` row | `registerLoadedCase` |
| The same `version` with a different evaluator hash or fixture hash is refused: bump `version` | `registerLoadedCase` |
| A version lower than the latest registered one is refused: versions only increase | `registerLoadedCase` |
| A case id registered with one origin cannot be re-registered with another (an imported case cannot take over a built-in id) | `registerLoadedCase` |
| Before every provisioning and every evaluation the directory is re-read and re-hashed; a mismatch with the stored hashes refuses the trial. The definition that runs is the one stored with the version, not the one now on disk (whole-definition pinning) | `loadVerifiedCase` |

The design said the evaluator hash covered the evaluator directory. The code also hashes the whole definition,
so editing `case.json` under an unchanged `version` is refused like editing the evaluator.

### Trusted and imported cases

| Origin | `trusted` | How it is created |
|---|---|---|
| `builtin` | true on registration | `ArenaService.syncBuiltinCases()` at startup, from `arena/cases` (dev) or `resources/arena/cases` (packaged, `electron-builder.yml`). Throws when a shipped evaluator changed without a version bump |
| `imported` | false | `arena.importCase` opens a folder picker; `importCase` registers the directory and returns the full list of commands (`setup:`, `check:`, `hidden evaluation:`). Nothing from the case is executed at import |
| `repository` | n/a | The type exists (`ArenaCase.origin`, and `provisionTrial` accepts a `repository` input that clones a local repository at a commit). No code path creates such a case or campaign: see Limits |

`arena.trustCase` marks an imported version trusted. The main process first shows a native Windows confirmation
(`ctx.confirmTrust` in `ipc/v3-handlers.ts`) that lists every `setup`, check and evaluation command; declining
refuses the call. The renderer's own dialog is a convenience, the native one is the control, because a script in the
renderer cannot click it. The service then re-reads the directory and refuses when the
version, evaluator hash or fixture hash differ from what was stored at import, so a case edited after the
user reviewed its commands cannot be trusted by accident. `createCampaign` refuses any untrusted case
version. The trust flag is a boolean on the version row; the design said the confirmation is stored with
the evaluator hash. In the code the hash is re-checked at trust time and on every later load.

## Built-in cases

Twelve cases, all version 2, all JavaScript (node:test, no dependencies), all allowing all five concrete
strategies. Visible check: `node --test`. Hidden evaluation: `node --test hidden-tests/<case id>.test.mjs`, an
explicit file per case, timeout 120 s. Every case has `maxAgentsPerTrial` 8. Per-case budgets are
`wall-clock minutes / agent sessions / agents per trial / turns per agent`.

| Id | Category | Complexity | Risk | Budgets | What it measures |
|---|---|---|---|---|---|
| `bugfix-localized` | bugfix | small | low | 20 / 20 / 8 / 60 | One-token defect in a pagination helper: a last page holding one item is lost |
| `bugfix-cross-module` | bugfix | medium | medium | 25 / 30 / 8 / 60 | Wrong totals and stock when an order is priced or reserved twice; the cause is in a shared helper |
| `bugfix-concurrency` | bugfix | large | high | 30 / 40 / 8 / 70 | Semaphore, job queue, read-through cache and `mapLimit` misbehave under concurrency, failure and cancellation |
| `feature-small` | feature | small | low | 20 / 20 / 8 / 60 | A well-specified group-by-and-sort summary function in a small report library |
| `feature-multi-module` | feature | large | medium | 40 / 60 / 8 / 80 | Priorities and due dates in a todo library: model, versioned storage with backwards compatibility, service, rendering, flags |
| `refactor-extract` | refactor | medium | medium | 20 / 20 / 8 / 60 | Behaviour-preserving extraction of line pricing duplicated in three modules into one shared module |
| `migration-schema` | migration | medium | high | 30 / 30 / 8 / 70 | Versioned, idempotent, non-lossy v1 to v2 migration of a JSON contact store, with backup and corrupt-entry reporting |
| `performance-optimization` | performance | medium | low | 25 / 30 / 8 / 60 | A correct log-analytics toolkit that collapses on realistic sizes; remove algorithmic hot spots without changing results |
| `security-hardening` | security | large | high | 40 / 40 / 8 / 80 | Classic vulnerabilities in a static-serving, upload, config, templating and auth helper library |
| `testing-gap` | testing | medium | low | 25 / 30 / 8 / 60 | A cron library with shallow tests; write a regression suite strong enough to catch behavioural bugs in every module |
| `ui-state-bug` | ui | medium | low | 25 / 30 / 8 / 60 | Framework-free state layer of a to-do panel mutates state and derives counts from the wrong data |
| `recovery-persistence` | infrastructure | large | high | 40 / 50 / 8 / 80 | An embedded key/value store with journal and snapshots that loses data after a crash |

Two evaluators are not plain assertions. `performance-optimization` measures scaling by timing: each operation is timed
at 2000 and at 16000 items, in batches of at least 40 ms, the best of 7 batches is kept, and the ratio must stay below 24
(about 8 is linear, about 64 is quadratic). `testing-gap` applies equivalent edits to the sources as controls: the
agent's tests must still pass on them, so a suite that hashes or greps the sources fails. Each case's `README.md`
states what it measures and why its hidden tests are fair; fairness was not probed exhaustively (see Limits). The `architecture`
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
   first attempt. A guard (`gitGuard`) is created for every Git command the Arena runs on case content:
   `core.hooksPath` points at an empty directory, `core.fsmonitor=false`, `GIT_CONFIG_NOSYSTEM=1` and an empty
   `GIT_CONFIG_GLOBAL`; `git init` and `git clone` use `--template=` and the baseline commit uses `--no-verify`. No hook
   of a case or of the machine runs.
4. `fixture/` is copied (not linked, symlinks dereferenced) to `<trial>/repo`.
5. The case's `setup` commands run there with `cleanEnv()` (see "Command environment"). Timeout 10 minutes
   each, output capped at 64 KiB. A failing setup command fails provisioning.
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
facts and task outcomes cannot reach another trial.

Nobody is present in a trial, so the Arena answers approval requests itself (`answerApproval`, on each
`approval.requested` event and for any still pending). Every strategy gets the same rule, the one an unattended
Overnight run uses: a tool request is denied (the agent is told and continues another way); a plan, task or graph
approval is granted, except the start of a task the planner marked high-risk, which is denied. Without this rule a
run waited on a tool approval until the case's time budget ran out and the strategy was blamed for it. A run that still
reaches `awaiting_approval` is cancelled and the trial is `blocked` (kind `run`). A run paused for any reason other
than `quota` or `recovery` is cancelled and the trial is `blocked` (kind `run`) with the pause error.

### Waiting for the run (`waitForRunEnd`)

Run events (`run.completed`, `run.failed`, `run.cancelled`, `run.paused`, `run.resumed`,
`run.state_changed`) wake the job; a poll every 2000 ms is a safety net. The trial clock runs while the
run is active. It stops while the run is paused for `quota`. At the case's `maxWallClockMinutes` the run is
cancelled (`timeout`) and the trial ends `blocked`, kind `timeout`, with the detail "Trial exceeded the case
wall-clock budget". The trial clock is stored in the settings key/value table (`arena.clock.trial.<trial id>`) and
reloaded after a restart. A run paused for `recovery` after a restart is resumed once through the host.

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
5. Otherwise: the case is re-verified by hash; `<trial>/eval` is created by a guarded `git clone --no-hardlinks
   --no-checkout --template= -c core.symlinks=false` of the trial repository (a symlink in the agent's commit
   becomes a plain file), the result commit is checked out detached and `.git` is removed (a plain file export with
   no link back). Then the tamper check: if any top-level name of the evaluator already exists in the export (a
   planted `hidden-tests/`, a junction), the evaluator is not run and the trial fails as tampering. Otherwise
   the evaluator's top-level entries are copied in with `force: false`, `errorOnExist: true` and no symlink
   dereference, so nothing is overwritten and no link is followed. The evaluation command runs there with
   `cleanEnv()`, the case timeout and a 16 KiB output cap (tail kept). `eval/` is removed in a `finally`, whatever
   the outcome.
6. Passed means exit code 0, no timeout, and (for a `node --test` command) at least one test reported. An evaluator
   that executes zero tests (`# tests 0`, no summary with a clean exit, or a missing test file) is an infrastructure
   error: nothing was learned about the strategy. An evaluator that cannot start is also an infrastructure error.
7. The evaluator runs only in `<trial>/eval`. It does not run the case's `setup` commands.

### Final state of a trial

| Condition | State | Detail |
|---|---|---|
| Hidden evaluation passed | `passed` | |
| Run `completed`, evaluation failed | `failed` | `Hidden acceptance failed (exit n)` or `Hidden evaluation timed out` |
| Result commit collides with an evaluator path | `failed` | `Tampering: ...` |
| Run `failed` | `failed` | `The run failed: <error>` |
| Case wall-clock budget exceeded | `blocked`, kind `timeout` | `Trial exceeded the case wall-clock budget` |
| Run needed an intervention, or paused for a reason other than quota or recovery | `blocked`, kind `run` | the reason |
| Provisioning or run start failed, evaluator not runnable or ran zero tests, run cancelled from outside the Arena, resume after restart failed | `blocked`, kind `infrastructure` | `Provisioning failed: ...`, `Could not start the run: ...`, `The evaluator executed no tests` |
| Campaign cancelled or budget closed while queued or running | `cancelled` | |

`blockKind` (`TrialBlockKind`: `infrastructure`, `run`, `timeout`) is stored on a blocked trial (column
`arena_trials.block_kind`) and is null otherwise. `trialOutcome()` in `scoring.ts` decides how a trial counts in
comparisons:

| Trial | Counts as |
|---|---|
| `passed` | pass |
| `failed` (including tampering) | fail |
| `blocked`, kind `run` or `timeout` | fail: a failure of the strategy; dropping it would be survivorship bias |
| `blocked`, kind `infrastructure` or no recorded kind | excluded from n and from policy evidence; counted as `excludedInfrastructure` |
| `queued`, `running`, `cancelled` and the rest | ignored |

### Command environment (`env.ts`, `process/run-process.ts`)

Every command the Arena runs for a case (setup, evaluator, the Node preflight) gets `cleanEnv()`: `projectCommandEnv()`
(the process environment without `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`NODE_OPTIONS` and `NODE_PATH`) minus every `ANTHROPIC_*` variable and `NODE_TEST_CONTEXT`. Credentials of the user's
Claude account never reach a case command, and nothing can redirect how Node loads code or runs the test runner.

### Evaluation records

A trial that fails does not stop the campaign. Evaluations are stored in `arena_evaluations`: the command,
exit code, timeout flag, duration, output tail, `passed`, the skip reason (or the infrastructure error), `evaluatorHash`,
`scoreVersion` (`score-v1`), the score and its breakdown. Each evaluation inserts a new row, so a re-evaluation after a
restart keeps the earlier one; readers use the latest row of a trial (`latestForTrial`). The output is for people; it is
never sent to an agent.

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
campaign cut short by a budget still has balanced strategies. The strategy order is counterbalanced: for case index `i`
and repetition `r` the allowed strategies are rotated by `(i + r - 1) mod k`, so no strategy always runs first. A
`(case, strategy)` pair is planned only if the case allows the strategy. Duplicate strategies are removed. Creation fails when no case or no
strategy is chosen, a case is untrusted, no pair is allowed, or the trial count exceeds `maxTrials`. The
trials are inserted `queued` with their `ordinal` in one transaction; execution order follows the
ordinal. The environment (platform, OS release, Node, SDK version, Git version, model tier aliases), the
NEXUS version and the active policy snapshot id are recorded on the campaign. The Node version recorded is the one
that will run the cases (see "Node.js preflight"), not the application's own runtime.

### Budget presets (`ARENA_BUDGET_DEFAULTS`)

| Preset | `maxWallClockMinutes` | `maxTrials` | `maxConcurrentTrials` | `maxAgentSessions` | `maxAgentsPerTrial` |
|---|---|---|---|---|---|
| `eco` | 120 | 12 | 1 | 120 | 2 |
| `balanced` | 360 | 40 | 1 | 400 | 8 |
| `research` | 720 | 120 | 2 | 1500 | 8 |

`maxAgentsPerTrial` is a cap, not a setting: each strategy keeps its own parallelism below it (SWARM uses up to 8). The
preset defaults (2, 8, 8) leave every strategy at its usual limit (SINGLE 1, BUILD and CONSENSUS 4, SPECULATIVE 3, SWARM 8;
2 for any non-SINGLE strategy in ECO). When a campaign's cap is below a strategy's usual limit, the results carry a note
saying so.

The UI (IPC `arena.createCampaign`) can override `maxConcurrentTrials` (1 to 4) and
`maxWallClockMinutes`. The service also accepts `maxTrials`, `maxAgentSessions`, `maxAgentsPerTrial` and
`overnight`, but the IPC schema does not carry them. `repetitions` is 1 to 20, at most 50 cases and 5
strategies per request.

### What each budget does

| Budget | Checked | Effect when reached |
|---|---|---|
| `maxTrials` | At creation only | The campaign is refused |
| `maxWallClockMinutes` | A timer re-armed every 5 s while the campaign is `running`; counts active time only (a quota pause or a user pause stops the clock). The elapsed time is written to the settings key/value table (`arena.clock.campaign.<id>`) and reloaded after a restart | `exhaust`: queued trials cancelled, running trials stopped (run cancelled), campaign completes with `error = "Budget: maxWallClockMinutes (n) reached"` |
| `maxAgentSessions` | Before a trial is scheduled and after each trial ends (sum of `sessions` in stored trial metrics) | Same, with `Budget: maxAgentSessions (n) reached`. A running trial can overshoot the limit before the check |
| `maxAgentsPerTrial` | At run creation | Cap on parallel agents, lower of campaign and case value |
| `maxConcurrentTrials` | At scheduling | At most this many jobs per campaign, started in ordinal order |
| Case `maxWallClockMinutes` | Per trial, while the run is active | Run cancelled, trial `blocked` |
| Case `maxTurnsPerAgent` | Passed to the run | Run limit |
| Case `maxAgentSessions` | Not read by any code | None |

A stopped trial after a campaign budget is `cancelled`, not evaluated.

### Node.js preflight (`preflight.ts`)

The built-in cases are Node.js projects and NEXUS ships no Node. `checkNode()` resolves `node` on `PATH` the way
`runCommandLine` does, runs `node --version` with `cleanEnv()` and requires `MIN_NODE_MAJOR` = 20. `arena.status`
returns `{ nodeFound, nodeVersion, ok, message }` for the UI. `start()` refuses with that message when Node is missing or
too old, and `createCampaign` with `start: true` does the same. A trial whose evaluator cannot start or runs zero tests is an
infrastructure block, excluded from the statistics.

### Pause, resume, cancel

| Action | Effect |
|---|---|
| `arena.pause` | Campaign `paused`, reason `user`. No new trial starts. Running trials continue and are evaluated. It does not pause their runs |
| `arena.resume` | Back to `running`, scheduling continues |
| `arena.cancel` | Queued trials cancelled, running trials stopped and their runs cancelled, campaign `cancelled` |
| `arena.start` | Only for a `draft`, and only when the Node preflight passes |
| `arena.cleanup` | `cleanupCampaign`: for a finished campaign (`completed`, `cancelled`, `failed`) with no trial still finishing, removes each trial's run worktrees through the host and then its trial directory under `<data>/arena/`. Database rows are kept. Nothing calls it automatically |

### Overnight Arena

A campaign can run under the overnight supervisor (`overnight.startArena`): explicit authorization, a hard
wall-clock deadline, the failsafe armed before the first trial, a final report and an end action of `NONE`,
`SHUTDOWN`, `SLEEP` or `HIBERNATE`. The Arena keeps doing what it does for any campaign (queue, quota pause,
restart recovery, evaluation, policy candidates); the supervisor owns the deadline and the power lifecycle.
`ArenaService.suspend` stops a campaign without ending it and `idleCampaign` waits until none of its trials
is being worked on. See [OVERNIGHT_MODE.md](OVERNIGHT_MODE.md), "Workloads".

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
| `evaluating` | Evaluated again. Evaluation is a function of the result commit; a new evaluation row is added and the earlier one is kept |
| `running` or `paused` campaign | Campaign and trial budget clocks reloaded from the settings key/value table. Time while the application was closed is not counted |

The clocks are saved on every state change, on each timer tick and in `dispose()`. A crash loses at most the time since
the last save.

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
| `wallClockMs` | int or null | `run.finishedAt - run.startedAt - quotaWaitMs`, floored at 0. Quota waits are excluded | The run has no start or finish time |
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

How a trial counts is decided by `trialOutcome()` (see "Final state of a trial"): passed and failed trials count,
blocked trials count as failures when the block was the run's (`run`) or the case's time budget (`timeout`), and
harness-blocked trials (`infrastructure`) are left out and shown as `excludedInfrastructure`. Queued, running and
cancelled trials are ignored. Each `StrategyComparisonRow` has `n`, `cases` (distinct cases behind `n`),
`excludedInfrastructure`, the Wilson interval and the label. The label is capped at WEAK while `cases` is below 3
(`MIN_CASES_FOR_EVIDENCE`): repetitions of one case are not independent. Time, sessions, tokens and repairs are summarised
over passed trials only, so a fast failure does not look efficient.

`resultNotes` states in words: n below 5, a single-case row, trials excluded as infrastructure, which pairs are separated
and which are not, the multiple-comparison caveat when more than two strategies are compared, the agent cap of a
campaign (ECO) and that efficiency figures cover passed trials only.

Regression detection groups trials by (NEXUS version, model signature: the sorted `role=model` pairs of the trial),
takes the two newest groups by the earliest campaign creation time, and compares, per strategy, only the case
versions both groups ran. Policy versions are not compared and older groups are ignored.

## How the policy consumes trials

`PolicyService.learn()` reads trials finished within the evidence window (`evidenceWindowDays`, default
365). Each trial becomes one observation:

| Aspect | Rule |
|---|---|
| Context | The `contextKey` of the trial's `TaskProfile` when the run produced one; else `category | complexity | risk` from the case definition |
| Skipped | `cancelled`, `queued`, `provisioning`, `running`, `evaluating`, and trials blocked by infrastructure |
| Success | `hiddenPassed === true` |
| Stability failure | Never for a passed trial; otherwise `blocked` by the run or the time budget, or `crashedAgents > 0`, or `schedulerFailures > 0` |
| Weight | 1, times the recency weight (half-life 90 days by default), times `modelDriftWeight` (0.5) when the recorded models differ from the models now configured |

Arena trials are kept as `kind = 'arena'` in `strategy_statistics`; real-mission outcomes are `kind =
'mission'`, weighted `missionWeight` (0.5) and flagged observational. Arena evidence is controlled;
mission history is observational and weighted lower; neither is pooled in displayed counts ("18 of 21
Arena trials and 4 of 6 real missions (observational)"). Runs of Arena trials record an outcome flagged
`isArena` and are excluded from mission evidence. Policy changes only by explicit promotion, and learning
never rewrites NEXUS source code. Details: [ADAPTIVE_POLICY.md](ADAPTIVE_POLICY.md).

A trial blocked by infrastructure is left out of both the results table and the policy evidence. A finished campaign
calls `PolicyService.learn()` once (`learnOnCampaignEnd` in `policy/wiring.ts`, wrapped around the Arena's push when
the campaign reaches `completed`): statistics are refreshed and candidates may be proposed. It never promotes.

## IPC channels

All are in the `v3-handlers.ts` registry and validated by the schemas in `src/shared/ipc.ts`.

| Channel | Input | Returns |
|---|---|---|
| `arena.status` | none | `{ nodeFound, nodeVersion, ok, message }`: whether this computer can run the cases |
| `arena.cases` | none | `ArenaCaseSummary[]` (case row and latest version) |
| `arena.importCase` | none; opens a folder picker | `{ summary, commands }` or null when cancelled; registered untrusted |
| `arena.trustCase` | `caseVersionId` | the trusted `ArenaCaseVersion`; shows a native confirmation listing the commands first |
| `arena.campaigns` | `limit` 1 to 100, `offset` | `{ campaigns, total }` with state counts |
| `arena.createCampaign` | `name`, `caseIds`, `strategies`, `repetitions`, `modelPreset`, `budgetPreset`, optional `maxConcurrentTrials`, `maxWallClockMinutes`, `start` | `ArenaCampaign` |
| `arena.campaign` | `campaignId` | detail: cases, matrix, comparison, usage totals |
| `arena.trials` | `campaignId`, `limit` 1 to 200 (default 100), `offset` | `{ trials, total }` with metrics, score, hidden result, run state |
| `arena.trial` | `trialId` | trial, case, metrics, evaluation, task profile |
| `arena.start`, `arena.pause`, `arena.resume`, `arena.cancel` | `campaignId` | `ArenaCampaign` |
| `arena.cleanup` | `campaignId` | `{ removed }`: trial directories deleted |
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
| `arena_trials` | Campaign, case version, strategy, repetition, ordinal, state, `block_kind`, project, run, repo path, baseline and result commit, policy snapshot, task profile, resolved models, detail, times. Index `idx_arena_trials_project` on `project_id` |
| `arena_trial_metrics` | One row per trial, the fields above |
| `arena_evaluations` | The hidden evaluation and the score; one row per evaluation, history kept |

Also written for Arena runs: `task_profiles.arena_trial_id`, `mission_outcomes.is_arena`,
`usage_events.arena_campaign_id`. The design planned `projects.kind`; the migration adds no column to
`projects`. A trial's project is identified through `arena_trials.project_id`.

## Retrieval and token comparisons (0.7.1)

Two instruments were added beside the Arena. Neither is an Arena campaign and neither changes one.

**The retrieval benchmark** (`pnpm bench:retrieval`, `tests/helpers/retrieval-benchmark.ts`). A fixture
project with knowledge in every store, 18 tuning cases across the task kinds NEXUS runs (localized bug,
cross-module bug, architecture, security, UI, database, large refactor, Program, Workspace, memory recall,
adversarial) and 7 held-out cases written after tuning. Each case lists the records a task cannot be done
well without and the records it would be wrong to present as current. Variants: the 0.7.0 selection, the
graph alone, V3 (both), every current node, and ablations of the retrieval signals. It is deterministic and
uses no model. It measures whether the right knowledge reaches the prompt, which is necessary for
engineering quality and is not the same thing.

**The quality non-regression gate** (`evaluateGate`, `token/quality-gate.ts`). Takes baseline and optimized
trial outcomes paired by case (the Arena's trial metrics have the fields it needs: hidden evaluation,
acceptance, findings by severity, repairs, turns, tokens, wall time) and answers IMPROVED, NON_INFERIOR,
INFERIOR or INSUFFICIENT_EVIDENCE. It needs 8 paired cases (16 for high-risk profiles). A technique that
changes what a model sees may become a default only on IMPROVED or NON_INFERIOR.

**What has not been run.** No Arena campaign compared a 0.7.1 context variant against the 0.7.0 one. The
only real comparison is one paired mission (`pnpm accept:graph`), which is far below the gate's minimum. The
Arena does not yet take a context variant as a campaign dimension; that is the missing piece for running the
gate on real trials, and it is recorded as not done in `V0_7_1_RELEASE_REPORT.md`.

## Limits

- Repository-origin cases: `provisionTrial` can clone a user repository at a commit, but
  `ArenaService` has no method to create such a case or campaign. Only built-in and imported case
  directories can be run.
- Arena cases need Node.js 20 or newer on `PATH`; NEXUS does not ship Node. Without it a campaign cannot start.
- An overnight campaign that is finalized (deadline, usage limit that cannot be waited on, lapse after a
  restart) has its trials in flight cancelled. Their partial work is not evaluated.
- Pausing a campaign does not pause running runs; they finish and are evaluated.
- Budgets are checked after each trial (`maxAgentSessions`) or on a 5 s timer (`maxWallClockMinutes`);
  `maxTrials` only at creation. The session budget can be exceeded by the trial that is running.
- Case `budgets.maxAgentSessions` is part of the schema and is not enforced.
- Regression detection compares only the two newest (NEXUS version, model signature) groups.
- Unattended trials deny every tool approval request, so a strategy cannot be credited for work that needs one.
- The `performance-optimization` evaluator decides by timing. It keeps the best of several batches to resist load, but it
  runs on whatever machine runs the campaign, which is a single machine with no isolation from other load.
- Evaluator fairness was checked with a reference solution per case, not probed exhaustively with alternative correct
  solutions.
- Scores are relative to the passing trials of the same case in the same campaign and are recomputed when
  another trial of that case finishes. They are not comparable across campaigns. Compare pass rates and
  raw metrics.
- Campaign state `failed` exists and is never set. An overnight campaign in which no trial produced a
  result is finalized with the terminal reason `FAILED`; the campaign row itself is `completed`.
- Evaluators are checked for presence in the trial repository at provisioning. A result commit that contains an
  evaluator's top-level path fails the trial as tampering; the evaluator is never copied over agent files.
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
