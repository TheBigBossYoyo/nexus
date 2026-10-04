# Benchmark methodology (0.3)

How the Arena produces numbers, what it guarantees about them, and what they cannot tell you. The
mechanics of cases, campaigns and trials are in [ARENA.md](ARENA.md). This document is about whether the
numbers can be trusted and how to read them.

NEXUS does not claim universal superiority of any strategy. Arena results describe the cases, models and
versions that were run. Arena evidence is controlled; mission history is observational and weighted
lower; neither is pooled in displayed counts.

Code: `src/main/modules/arena/scoring.ts` (`score-v1`, comparison, regression),
`src/main/modules/policy/stats.ts` (intervals and labels), `src/main/modules/arena/metrics.ts`.

## What is held constant in a campaign

| Held constant for every trial of a campaign | Source |
|---|---|
| Model preset (`eco`, `balanced`, `maximum`), so every strategy gets the same tier mapping | `ArenaCampaign.modelPreset` |
| The task prompt, visible acceptance criteria and check commands of the case | `case.json` |
| The starting repository: same fixture, same baseline commit id (fixed author and commit date, `core.autocrlf=false`) | `provisionTrial` |
| The hidden evaluator (same files, command and timeout; its hash is stored with every evaluation) | `evaluatorHash` |
| Budgets: per-trial wall clock and turns from the case; agent cap = lower of campaign and case limit | `case.json`, campaign budgets |
| Run options: mode `build`, no plan approval, `respectProjectClaudeConfig: false` | `provisionAndStart` |
| Scoring version and its parameters | `SCORE_VERSION = 'score-v1'`, `DEFAULT_SCORING`, case overrides |
| Trial order: deterministic by `ordinal`, repetition outermost, strategy order rotated by `(case index + repetition - 1)` so none always runs first | `createCampaign` |
| Unattended behaviour: tool approval requests are denied, plan, task and graph approvals are granted (a high-risk task start is denied), the same for every strategy | `ArenaService.answerApproval` |
| Command environment: no Claude credentials, no `NODE_OPTIONS` or `NODE_PATH` | `arena/env.ts`, `projectCommandEnv` |

What differs between trials of one case is the strategy (and the repetition number). Each strategy keeps
its own planner, parallelism and review setting inside the agent cap; the cap does not erase the
difference between strategies.

## What is recorded

| Record | Content |
|---|---|
| Campaign | NEXUS version, platform, OS release, the Node version that runs the cases (from the preflight), Agent SDK version, Git version, model tier aliases at creation, active policy snapshot id, budgets, preset |
| Trial | Case version, strategy, repetition, ordinal, baseline commit, result commit, resolved model per role, policy snapshot id, task profile id, final state, `blockKind` and detail, times |
| Metrics | All fields of `ArenaTrialMetrics` (see ARENA.md); null means not measured |
| Evaluation | Evaluator command, exit code, timeout flag, duration, output tail (16 KiB), `passed`, skip reason, `evaluatorHash`, `scoreVersion`, score, breakdown |
| Case version | Full definition (the stored one is what runs), `fixtureHash`, `evaluatorHash`, `trusted` |
| Blocked trials | `blockKind`: `infrastructure`, `run` or `timeout`, which decides whether the trial counts |

Resolved models come from the run's routing decisions, falling back to the agent's model. The case, the
evaluator and the score version are named by every result, so a result can be tied to the exact
evaluator that produced it.

## Integrity guarantees

| Guarantee | Enforced by | Checked by |
|---|---|---|
| An agent cannot read the hidden evaluator through its tools | The agent path policy refuses paths outside the worktree and project root. The evaluator directory is under the case directory, not under any trial or worktree | `tests/scenarios/v3-arena.test.ts`: an agent tool call that reads the evaluator file is refused in every session |
| The evaluator is never inside the trial repository | `assertNoEvaluatorFiles` before the baseline commit (by path and by content hash); evaluation exports the result commit to `<trial>/eval` and copies the evaluator in only then | `tests/integration/arena/provisioning.test.ts` (detects an evaluator file by name and by content); `builtin-cases.test.ts` (no `hidden-tests/` in the tracked files); the scenario test (no `hidden-tests` in any trial repository) |
| The evaluator exists only after the agents are done | `evaluateStage` waits for the run's agents to be inactive (default 10 s), else the trial is `blocked` | `campaign.test.ts` (a failed run leaves the evaluator unrun; the evaluator never sees an unfinished run) |
| The evaluation is a function of the result commit | Rebuilt from Git on every call (hook-free guarded clone, `core.symlinks=false`); `.git` removed from the export; `eval/` removed in a `finally` | `provisioning.test.ts` (fails the unmodified fixture, passes a correct result, leaves no `eval` directory) |
| An agent cannot plant files the evaluator will use or that hide its tests | A result commit that contains a top-level path of the evaluator fails the trial as tampering and the evaluator does not run; otherwise the copy never overwrites and never follows a link | `provisioning.test.ts` |
| A run that executed no test is not a verdict | A `node --test` evaluator that reports zero tests, or cannot start, is an infrastructure block excluded from the statistics | `provisioning.test.ts`, `scoring.test.ts` |
| Fixture and evaluator carry no Git internals | A `.git` entry in either is refused at load; Git runs on trial repositories with hooks, fsmonitor and system and global configuration switched off | `case-format.test.ts`, `provisioning.test.ts` |
| An evaluator or definition cannot change under a result | The evaluator hash covers the files, the command, the timeout and the whole definition; the stored definition is the one that runs; same version with a different hash is refused; every load re-hashes | `tests/unit/arena/case-format.test.ts` |
| Case commands cannot read the user's Claude credentials | `cleanEnv()` removes `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_TEST_CONTEXT` | `arena/env.ts` |
| Nothing learned in one trial reaches another | Every trial has its own project: project memory, repository facts, outcomes and routing are per project. The trial directory is wiped before provisioning; files are copied, never linked | `campaign.test.ts` ("isolates trials": project ids, run ids, paths differ; a fact written in trial A is absent in B; trial B's run, project and prompt contain no id, path or commit of A) |
| No prompt contains evaluator content | The prompt is `taskPrompt` plus `visibleAcceptance`; no evaluator text is read at run creation | `campaign.test.ts` and the scenario test: prompts contain neither `hidden-tests` nor evaluator content, nor another trial's ids |
| The speculative tournament never uses the hidden evaluator | `rankCandidates` takes `CandidateEvidence` (result produced, checks, acceptance commands, review findings, change size); the type has no field for the hidden evaluation. In a trial the tournament uses the visible check commands only | Enforced by the type; `tests/unit/strategy/tournament.test.ts` tests the ranking rules, not the Arena case. See [SPECULATIVE_EXECUTION.md](SPECULATIVE_EXECUTION.md) |
| The built-in evaluators are fair and discriminating | Each built-in case is checked against a reference solution | `tests/integration/arena/builtin-cases.test.ts`: visible tests pass, hidden evaluator fails on the fixture, passes on the reference solution in `tests/fixtures/arena-solutions/<id>` |
| A user repository is never changed (when provisioned from) | Clone with `--no-hardlinks`, `origin` removed, HEAD, branch and status compared before and after | `provisioning.test.ts`. This path is not reachable from `ArenaService` in 0.3 |
| Imported evaluators are not run unreviewed | `trusted` false until `arena.trustCase`, which shows a native confirmation listing the commands and re-hashes; `createCampaign` refuses untrusted cases | `case-format.test.ts` |

These tests run against the scripted runtime (`FakeAgentRuntime`) and local Git. They show the isolation
mechanics work; they cannot show that a real agent never finds another route to the evaluator.

## Scoring: `score-v1`

`SCORE_VERSION = 'score-v1'`. The version and any case override are stored on every evaluation. Pure
code in `scoring.ts`. Raw metrics are always stored and shown; the ranking and the score are derived.

### Ranking: lexicographic (`compareTrials`)

The first step that separates two trials decides. A later step is only a tie-breaker.

| Step | Criterion | Better is | Tie when |
|---|---|---|---|
| 1 | Hidden evaluation passed | passed | both passed or both failed |
| 2 | Unresolved critical plus high findings | fewer | equal count |
| 3 | Mission verification passed | passed | same result. "Passed" means none of `verifierPassed`, `buildPassed`, `typecheckPassed`, `testsPassed` is `false`; an unmeasured part is not a failure |
| 4 | Repair cycles (`repairs`) | fewer | equal |
| 5 | Wall clock (`wallClockMs`) | lower by more than a band | within the band, or either value null |
| 6a | Observed tokens (input plus output; null if neither was reported) | lower by more than a band | within the band, or either value null |
| 6b | Sessions | fewer | equal |

Band: `betterByBand(a, b, band)` is true when `a < b * (1 - band)` and `b > 0`. Default band
`DEFAULT_SCORING.band = 0.2` (20 %). Example: 79 s is better than 100 s (79 < 80); 80 s is a tie with 100 s. A trial that fails step 1 never ranks above one that passes it,
whatever its cost.

### Convenience score (`scoreTrial`)

The score is 0 when the hidden evaluation failed. Otherwise it is `passBase` plus five parts, each up to
its weight.

| Part | Default weight | Value |
|---|---|---|
| `passBase` | 60 | Fixed, given for a passed hidden evaluation (`DEFAULT_SCORING.passBase`) |
| `findings` | 15 | Full weight with no unresolved critical or high finding; otherwise `weight / (1 + n)` |
| `verification` | 10 | Full weight when `verificationPassed` (no measured check or verifier failed), else 0 |
| `repairs` | 5 | Full weight with 0 repairs; otherwise `weight / (1 + repairs)` |
| `time` | 5 | `weight * relativeCredit(wallClockMs, fastest peer, band)` |
| `usage` | 5 | `weight * relativeCredit(observed tokens, cheapest peer, band)` |

`relativeCredit(own, best, band)`: 0 when either value is null; 1 when `own <= best * (1 + band)`;
otherwise `best / own`. Zero or missing values are ignored when picking the best. The best value is the
minimum over the trial itself and the passing trials of the same case in the same campaign (peers). An
unmeasured value earns nothing; it is neither rewarded nor invented.

Parts are rounded to two decimals and the score is the sum of the rounded parts. A case override can
change `band` and any weights (each 0 to 40); if `passBase` plus the weights would exceed 100, every part
is scaled by `100 / total`, so the maximum stays 100. A passing trial scores at least `passBase`; a
failing trial scores 0. The score cannot hide a correctness failure.

Because `time` and `usage` depend on the peer set, `ArenaService.rescoreCase` recomputes the score of
every evaluated trial of the case in the campaign whenever one more finishes. Scores are comparable
within a case in a campaign and not across campaigns. Use pass proportions and raw metrics for
comparison across campaigns.

## Statistics (`policy/stats.ts`)

Per strategy, `compareStrategies` reports: `n` (counted trials), `cases` (distinct cases), `excludedInfrastructure`,
`passed`, pass rate, the 95 % Wilson interval, median wall clock, mean sessions, mean observed tokens, mean repairs, total
critical and high findings, total quota pauses, and the evidence label. Wall clock, sessions, tokens and repairs are
summarised over passed trials only: a fast failure is not efficient. Findings and quota pauses cover all counted trials.
Null values are skipped. `wallClockMs` excludes quota waits.

### Wilson interval

For `s` successes in `n` trials, `p = s / n`, `z = 1.959963984540054` (95 %):

```
d      = 1 + z^2 / n
centre = (p + z^2 / (2n)) / d
half   = z * sqrt( p(1-p)/n + z^2 / (4n^2) ) / d
interval = [ max(0, centre - half), min(1, centre + half) ]
```

`null` for `n = 0`. The interval stays inside 0 to 1 and is defined at 0 and n successes. Examples
(computed with the formula above):

| s of n | 95 % interval |
|---|---|
| 5 of 5 | 0.566 to 1.000 |
| 3 of 5 | 0.231 to 0.882 |
| 0 of 5 | 0.000 to 0.434 |
| 10 of 12 | 0.552 to 0.953 |
| 6 of 12 | 0.254 to 0.746 |
| 24 of 30 | 0.627 to 0.905 |
| 15 of 30 | 0.332 to 0.668 |
| 30 of 30 | 0.886 to 1.000 |

### Evidence labels (`EVIDENCE_THRESHOLDS`, `evidenceLabel`)

| Label | Criterion |
|---|---|
| `INSUFFICIENT` | n < 5 (`weak`) |
| `WEAK` | 5 <= n < 12 (`moderate`) |
| `MODERATE` | 12 <= n, and not STRONG |
| `STRONG` | n >= 30 (`strong`) and interval width <= 0.30 (`strongMaxWidth`) |

n = 30 with a wider interval stays `MODERATE` (15 of 30 has width 0.336). The thresholds are constants in
one file and are not tuned per result. Here n is the count of trials in the table; the policy engine
works with effective (weighted) sample sizes, see [ADAPTIVE_POLICY.md](ADAPTIVE_POLICY.md).

A second rule applies in the Arena table: while a strategy's trials come from fewer than 3 distinct cases
(`MIN_CASES_FOR_EVIDENCE`), its label is capped at `WEAK`, whatever n is. Repetitions of one case are not independent
samples of tasks in general. The row's `cases` field shows the number.

### What "separated" means

Two strategies are called different only when their intervals share no point (`intervalsSeparated`:
`a.low > b.high` or `b.low > a.high`). A null interval overlaps everything. There are no p-values and no
multiple-comparison correction. `resultNotes` writes one statement per pair of strategies that are not
`INSUFFICIENT`:

- separated: "`X` passes more often than `Y` (a% vs b%; 95% intervals ... do not overlap)";
- not separated: "The evidence does not separate `X` and `Y` on pass rate (intervals overlap)";
- a strategy with n < 5 gets "n is below 5 for ...; nothing is concluded for it";
- one strategy only: "there is nothing to compare";
- a strategy whose trials come from fewer than 3 cases: the label is capped at WEAK and a note says so ("single-case" for one case);
- more than two strategies compared: a note that a single non-overlap can occur by chance (multiple comparisons);
- trials left out as infrastructure blocks are counted in a note;
- a campaign whose agent cap is below a strategy's usual limit: a note names the cap;
- a closing note that efficiency figures cover passed trials only, and that blocked-by-run and timed-out trials count as failures.

Non-overlap of 95 % intervals is a conservative test for a difference. Overlap does not mean the
strategies are equal. It means this sample cannot tell.

### Which trials count

`trialOutcome()` (`scoring.ts`) decides:

| Trial | Counted as |
|---|---|
| `passed` | pass |
| `failed`, including a tampering failure | fail |
| `blocked`, kind `run` (needed an intervention) or `timeout` (case wall-clock budget) | fail: the strategy's failure; dropping these would be survivorship bias |
| `blocked`, kind `infrastructure` (provisioning, run start, evaluator not runnable, zero tests) or no recorded kind | excluded from n; shown as `excludedInfrastructure` |
| `queued`, `running`, `cancelled` | ignored |

Pass proportions pool all counted trials of a strategy, across cases. A strategy that ran on more hard
cases will show a lower rate. Read the per-case breakdown (`byCase`) before reading the overall table.

## Regression detection (`detectRegressions`)

`ArenaService.results` groups trials by (NEXUS version of the campaign, model signature), orders groups by the
earliest campaign creation time, takes the two newest groups and compares them, per concrete strategy, over the
case versions both ran. The model signature is the sorted `role=model` pairs of the trial, so a model change is a
separate group from a NEXUS change. There is no minimum n for a flag: the interval does the work. If the newer pass
rate is lower:

| Condition | Verdict | Label |
|---|---|---|
| Newer upper bound < older lower bound | `established` | `ORCHESTRATION REGRESSION` |
| Otherwise | `lower` | `Lower, not established` |

A higher or equal rate is never reported. Older groups and policy versions are not compared. When both the NEXUS
version and the models changed between the two groups, the comparison cannot say which caused the difference.

## Threats to validity

| Threat | Effect | What NEXUS does about it | What remains |
|---|---|---|---|
| Small samples | Wide intervals; a rate of 3 of 5 is compatible with 23 % to 88 % | Wilson intervals, labels, "nothing is concluded" below n = 5 | Cases times repetitions are often under 12 per strategy |
| Model drift | The same model alias can behave differently over time | Resolved models and the SDK version are stored per trial and campaign; regression detection groups by (NEXUS version, model signature); policy evidence is down-weighted (0.5) when the recorded model id differs from the newest evidence | The same model id can still change behaviour without a new id |
| LLM nondeterminism | Repeating a trial can give a different result | Repetitions, fixed order, identical baselines | No seed control on the runtime; variance is part of the result |
| Fixture realism | Twelve small JavaScript projects with node:test are not a representative sample of real work | Cases span nine categories and three sizes | No other language, no large repository, no network or services |
| Visible checks as a selection signal | The visible `node --test` suite is available to every strategy and to the speculative tournament; a strategy that runs checks more often gains from that | The hidden evaluator, not the visible checks, decides pass or fail | Hidden tests are a different test of the same behaviour, written by the same authors as the visible ones |
| Evaluator fairness | A hidden test can reject a correct alternative implementation or reward an incidental choice | Each case README lists what the tests use (public exports only, behaviour not structure); the reference solution passes and the fixture fails; `testing-gap` checks equivalent edits as controls | Not probed exhaustively with alternative correct solutions |
| Single machine | One machine, one OS, one network, one account | The environment is recorded | Load, disk, antivirus and rate limits on that machine affect wall clock and can pause runs |
| Timing-based evaluator | `performance-optimization` decides by measured scaling (2000 versus 16000 items, best of 7 batches of at least 40 ms, ratio below 24). Machine load can only make a batch slower, but a very noisy machine can still fail a correct solution | The threshold sits far from both linear (about 8) and quadratic (about 64) behaviour; the best batch is kept | Never run other heavy work during a campaign |
| Quota waits and wall clock | A quota wait would inflate time | `wallClockMs` excludes quota waits (`quotaWaitMs` is stored separately); the budget clocks also exclude them | Throttle retries and runtime latency still count as time |
| Unattended approvals | Tool requests are denied, so a strategy that needs one cannot succeed that way | The rule is the same for every strategy | A case that would need an approval is not measured fairly |
| Account usage shared | Other Claude clients on the same account consume the same quota | Not controlled | A limit hit during a campaign may not come from the campaign |
| Success is binary | A strategy that gets 90 % of the hidden tests counts the same as one that gets 0 | Raw metrics (build, test, acceptance, findings) are stored | The pass proportion ignores partial credit |
| Peer-relative scoring | The convenience score of a trial depends on other trials | Score is not used for statistics or policy | Do not compare scores across campaigns |

## How to read a results table

1. Check `n` and the label for each row first. `INSUFFICIENT` rows say nothing.
2. Look at the interval, not the point rate. Two rows whose intervals overlap are not different on this
   evidence.
3. Open the per-case breakdown. A pooled rate mixes cases of different difficulty and different numbers
   of trials per strategy.
4. Read the efficiency columns (median wall clock, mean sessions, mean observed tokens, mean repairs) only
   between strategies whose pass rates are comparable. A cheap strategy that fails is not cheap.
5. Wall clock excludes quota waits (`quotaWaitMs` is stored separately); `quotaPauses` shows which trials were interrupted.
6. A `blocked` trial of kind `run` or `timeout` is counted as a failure of its strategy; one of kind
   `infrastructure` is left out and shown as excluded. Look at the trial detail for the reason.
7. Mission history is shown separately and is labelled observational. It was not selected, repeated or
   evaluated by a hidden test.
8. A regression flag is `established` only when the newer group's upper bound is below the older group's lower
   bound. "Lower, not established" is not a finding.

## Limits

- The methodology measures pass or fail against hidden tests plus cost counters. It does not measure code
  quality, readability or maintainability beyond the review findings that stand at the end.
- No p-values and no correction for the number of comparisons shown. Many strategy pairs across many
  contexts will produce non-overlapping intervals by chance.
- Evidence labels use the raw trial count in the Arena table, capped at WEAK below 3 distinct cases. A table can
  still be `MODERATE` or `STRONG` for a strategy that has run on only a few cases (3 is the minimum, not a guarantee of coverage).
- Wilson intervals assume independent trials. Repetitions of one case are not independent samples of
  "tasks in general".
- Policy evidence uses weights and drift discounts and reports effective counts. The numbers in the Arena
  table and the policy table can differ for that reason.
- Isolation is enforced for NEXUS's own mechanisms (paths, projects, prompts). An agent that runs a
  program it wrote is not sandboxed by the operating system (see [SECURITY.md](SECURITY.md)).

## Not verified

- No real campaign has been run at the time of writing: see V0_3_RELEASE_REPORT.md. The scoring,
  statistics and isolation described here are covered by unit, integration, scenario and seeded stress
  tests with the scripted runtime only.
- The fairness of the built-in evaluators was checked with one reference solution per case, not with
  independent alternative solutions from real agents.
- Model drift and nondeterminism are not measured; they are named threats.
- The timing-based evaluator has not been run under heavy machine load.
- The timing-based evaluator has not been run under heavy machine load.

Related: [ADAPTIVE_POLICY.md](ADAPTIVE_POLICY.md), [USAGE_INTELLIGENCE.md](USAGE_INTELLIGENCE.md),
[QUOTA_RECOVERY.md](QUOTA_RECOVERY.md), [SPECULATIVE_EXECUTION.md](SPECULATIVE_EXECUTION.md).
