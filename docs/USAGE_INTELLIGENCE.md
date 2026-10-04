# Usage Intelligence (0.3)

Usage Intelligence records what the Claude runtime says about availability and what NEXUS sessions used,
keeps one status for the application, and answers the Usage page and the header indicator. It does not
estimate remaining capacity. Quota pause and automatic resume are in [QUOTA_RECOVERY.md](QUOTA_RECOVERY.md).

Code: `src/main/modules/usage/` (`classify.ts` and `machine.ts` are pure; `service.ts`, `probe.ts`,
`recovery.ts` are not), `src/shared/v3.ts` (contracts), `src/main/modules/agent-runtime/translate.ts`
and `claude-sdk-runtime.ts` (the runtime side), `src/main/modules/ipc/v3-handlers.ts` (`usage.*`).

## What the runtime exposes, and what it does not

Verified against the Claude Agent SDK 0.3.288 and the code that reads it.

| Data | Where it comes from | Read in | NEXUS treats it as |
|---|---|---|---|
| Tokens per model, turns, duration, cost figure for a finished turn | `result.modelUsage`, `num_turns`, `duration_ms`, `total_cost_usd` | `translate.ts` (`mapUsage`, `translateResult`) | `OBSERVED`: what NEXUS sessions used, not the account total |
| Limit status of the current window | `rate_limit_event.rate_limit_info.status`: `allowed`, `allowed_warning`, `rejected` | `translate.ts` (`rate_limit_event`) | `EXACT`, source `SDK_EVENT` |
| Reset time | `rate_limit_info.resetsAt` (epoch seconds; milliseconds are accepted by `normalizeEpochMs`) | same | `EXACT` when present, else unknown |
| Window type | `rate_limit_info.rateLimitType` (`five_hour`, `seven_day`, ...) | same | stored verbatim in `limit_type` |
| Utilization of that window | `rate_limit_info.utilization`, optional | same | stored verbatim with unit `raw`; never shown as a percentage, because the SDK declaration does not give the unit |
| Overage fields | `overageStatus`, `isUsingOverage`, `surpassedThreshold` | same | carried on `agent.rate_limited`; `isUsingOverage` adds `:overage` to the stored classification text. Nothing else reads them |
| Usage-limit failure | assistant error `rate_limit` or `billing_error`, `rate_limit_event` with `rejected`, or a result text starting with an SDK `USAGE_LIMIT_ERROR_PREFIXES` entry | `translate.ts` (`QUOTA_ERRORS`, `classifyResult`) | turn outcome `quota`, source `ERROR_METADATA` |
| Transient failure | assistant error `overloaded`, `server_error` | `translate.ts` | event `throttle`; never `quota` |
| Authentication failure | assistant errors `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `cloud_credential_error` | `translate.ts` (`AUTH_ERRORS`) | turn outcome `auth` |
| Account | `accountInfo()`: subscription type, token source | `claude-sdk-runtime.ts` `getAccountInfo` | `EXACT`, source `RUNTIME` |
| Plan windows without sending a prompt | `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` on a `query()` object | `claude-sdk-runtime.ts` `getUsageReport`, `parseUsageReport` | `EXACT` when it answers; optional |

Not exposed, and therefore never shown by NEXUS:

- A "tokens remaining" figure. There is none.
- The account's total usage. Other Claude clients use the same account.
- A reset time for every limit. The runtime sometimes reports a rejection without one.

### The usage report

`getUsageReport` opens a `query()` with `persistSession: false` and no setting sources, calls the
experimental method if the object has it, and closes the query. It returns `null` when the method is
missing, the call throws, the response does not match the schema (`UsageReportSchema`: `subscription_type`,
`rate_limits_available`, `rate_limits`; each window `utilization` and `resets_at`, both nullable), or
`USAGE_REPORT_TIMEOUT_MS` (20,000 ms) passes. Unknown fields are ignored. `null` means "unknown"; no caller
treats it as "available".

The method is declared experimental and unstable by the SDK. NEXUS treats it as optional: with
`usage.useRuntimeUsageReport` off, or when it fails, probes use one minimal session
([QUOTA_RECOVERY.md](QUOTA_RECOVERY.md), "Probing"), and the Usage page shows `usageReportSupported`
as `false` or unknown.

Verified for real on 2026-10-04 with `pnpm smoke:usage` (no prompt sent): the SDK 0.3.288 runtime answered
in about one second with plan windows `five_hour`, `seven_day` and one model-scoped bucket, each with a
utilization percentage and a reset time, and the account mode was `subscription`. Evidence:
`docs/acceptance/usage-report-*.json`. This shows the report works on one subscription account on one day.
It does not show that the field set is stable.

## Mandatory statements

- Usage totals may not be exposed by Claude. Observed usage is what NEXUS's own sessions reported. It is
  not necessarily the account's full subscription usage, because other Claude clients use the same account.
- Quota reset behaviour depends on what the runtime reports. NEXUS never fabricates remaining quota. A
  percentage is shown only when the runtime supplied it.
- The runtime usage report is an SDK method declared experimental or unstable. NEXUS treats it as optional
  and falls back to conservative probing.

## Provenance

Every figure the service returns is `Measured<T> = { value, source, confidence }` (`src/shared/v3.ts`).
`value` is `null` exactly when the confidence is `UNKNOWN` (`unknownValue`, `measured`).

| Confidence | Meaning | Examples in the code |
|---|---|---|
| `EXACT` | The runtime stated it | reset from `resetsAt`; a window's percentage from the usage report; account mode |
| `OBSERVED` | NEXUS counted it from its own sessions | tokens, sessions, turns; a session crash |
| `ESTIMATED` | Derived by NEXUS | only `autoResume.nextCheckAt` when the reset time is not `EXACT` (the planned probe time) |
| `UNKNOWN` | Not available | subscription utilization when no window carries a percentage |

| Source | Meaning |
|---|---|
| `RUNTIME` | The runtime answered a direct question (usage report, account info) |
| `SDK_EVENT` | An SDK stream event (`rate_limit_event`) |
| `ERROR_METADATA` | An error kind or error text of a turn |
| `LOCAL_AGGREGATION` | Computed by NEXUS from rows it stored |
| `UNKNOWN` | No source |

Rules enforced in code:

- A percentage exists only with unit `percent`. `rate_limit_info.utilization` is stored with unit `raw`
  (`classify.ts`); the status machine ignores any utilization whose unit is not `percent` (`onSignal`), and
  `usage_windows.utilization_percent` is filled only from a `percent` signal (`recordWindow`) or the usage
  report (`ingestReport`).
- `UsageOverview.subscriptionUtilizationPercent` is the highest `utilizationPercent` among windows with
  confidence `EXACT`, else `UNKNOWN`. It is never computed from tokens.
- `nextResetAt` is the machine's reset, else the earliest future window reset with confidence `EXACT`,
  else `UNKNOWN`.
- Token totals have no denominator anywhere.

`tests/unit/usage/service.test.ts` ("provenance (no fabricated percentage)") checks that every
percentage-like key of an overview built from observed data is `null`, or `EXACT` with a value.

## Rows

### `usage_events`

One row per observation. Columns: `id`, `created_at`, `event_type`, `project_id`, `run_id`, `task_id`,
`agent_id`, `sdk_session_id`, `role`, `model`, `strategy`, `arena_campaign_id`, `day` (local calendar day,
`YYYY-MM-DD`), `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `turns`,
`duration_ms`, `cost_usd`, `availability`, `limit_type`, `utilization`, `utilization_unit`, `reset_at`,
`retry_after_ms`, `source`, `confidence`, `raw_classification`. Indexed by time, type, run, day, model,
strategy, campaign, agent and task.

| `event_type` | Written when |
|---|---|
| `session` | An agent's first usage event; the same row is updated on later turns (below) |
| `limit_rejected` | `rate_limit` status `rejected`, or a `quota` turn outcome or error. A second rejection of the same run within `LIMIT_DEDUPE_MS` (10 s) that carries no reset time is not stored again |
| `limit_warning` | `rate_limit` status `allowed_warning` |
| `limit_allowed` | Classified but not stored: a plain `allowed` only refreshes `usage_windows` |
| `throttle` | `overloaded` or `server_error` (arrives as `agent.rate_limited` with status `throttled`) |
| `auth` | A run paused with cause `auth` |
| `runtime_error` | Defined and classified (`crashed` turn outcome), but nothing in `src/main` produces that signal; see "Limits" |
| `probe` | One availability probe and its result |
| `usage_report` | A refresh (`usage.refresh`) that got a usage report. Probes record a `probe` row, not this one |

#### What a `session` row is

One row per agent (keyed by `agentId` in memory), not per turn and not per model. Each `agent.usage` event
carries that turn's delta per model; the service adds them into the row:

- tokens (`input`, `output`, `cache_read`, `cache_creation`), `cost_usd`, `turns` and `duration_ms` are
  sums over the agent's turns and over all models;
- `model` is the model with the most output tokens (ties broken by insertion order; each turn adds
  `outputTokens + 1` per model so a model with zero output still counts);
- `sdk_session_id` is the latest one the runtime reported;
- the row is inserted on the first event with `source = SDK_EVENT`, `confidence = OBSERVED`, then updated in
  place. A session cut short by a pause or crash therefore keeps what it had reported so far.

The in-memory accumulator is dropped on `agent.stopped` and `agent.failed`. A later session for the same
agent id (a resumed run uses a new agent) starts a new row. `cost_usd` is the runtime's figure; it is not a
bill for a subscription account.

### `usage_windows`

One row per `limit_type` (`UNIQUE`), the latest value: `status` (`allowed`, `allowed_warning`, `rejected`,
`unknown`), `utilization_percent` (only from a `percent` source), `reset_at`, `source`, `confidence`,
`observed_at`, `updated_at`. Written from rate-limit events (those that carry a `rateLimitType`) and from
usage reports (status derived from the percentage: 100 or more `rejected`, 90 or more `allowed_warning`,
else `allowed`).

The existing `usage_snapshots` table (0.1) is still written per turn and is not read by the usage service.

## Status machine (`machine.ts`)

Pure and total. State: `status`, `since`, `availability`, `limitType`, `resetAt`, `utilizationPercent`,
`retryAfterMs`, `lastLimitAt`, `resumedAt`.

| Status | Availability | Blocks dispatch |
|---|---|---|
| `AVAILABLE` | `AVAILABLE` | no |
| `LIMIT_APPROACHING` | `AVAILABLE` | no |
| `THROTTLED` | `THROTTLED` | no |
| `QUOTA_PAUSED` | `QUOTA_EXHAUSTED` | yes |
| `WAITING_FOR_RESET` | `QUOTA_EXHAUSTED` | yes |
| `PROBING` | `QUOTA_EXHAUSTED` | yes |
| `AUTH_REQUIRED` | `AUTH_REQUIRED` | yes |
| `RUNTIME_UNAVAILABLE` | `RUNTIME_UNAVAILABLE` | yes |

`DISPATCH_BLOCKED_STATUSES` is the five blocking ones. `UsageIntelligenceService.canDispatch()` is also
false while a live `global` row exists in `quota_pauses`, whatever the status.

| From | Event | To |
|---|---|---|
| `AVAILABLE`, `LIMIT_APPROACHING`, `THROTTLED`, `AUTH_REQUIRED`, `RUNTIME_UNAVAILABLE` | signal `QUOTA_EXHAUSTED` (`rejected`, `rate_limit`, `billing_error`, `quota` outcome) | `QUOTA_PAUSED` (records `limitType`, reset, `lastLimitAt`) |
| `AVAILABLE`, `LIMIT_APPROACHING` | signal `THROTTLED` | `THROTTLED` |
| any except `QUOTA_PAUSED`, waiting | signal `AUTH_REQUIRED` | `AUTH_REQUIRED` |
| any except `QUOTA_PAUSED`, `AUTH_REQUIRED`, waiting | signal `RUNTIME_UNAVAILABLE` | `RUNTIME_UNAVAILABLE` |
| `AVAILABLE` | signal `allowed_warning`, or a `percent` utilization of 90 or more | `LIMIT_APPROACHING` |
| `LIMIT_APPROACHING` | `allowed` signal | `AVAILABLE` |
| `THROTTLED`, `AUTH_REQUIRED`, `RUNTIME_UNAVAILABLE` | `allowed` signal | `AVAILABLE` |
| `AVAILABLE`, `LIMIT_APPROACHING` | usage report: highest percentage 90 or more | `LIMIT_APPROACHING` (never `QUOTA_PAUSED`: a report that says 100 does not pause anything) |
| `LIMIT_APPROACHING` | usage report: highest percentage below 90 | `AVAILABLE` |
| `THROTTLED`, `AUTH_REQUIRED`, `RUNTIME_UNAVAILABLE` | `session_ok` (any `agent.message`) | `AVAILABLE` |
| `AUTH_REQUIRED`, `RUNTIME_UNAVAILABLE` | `account_ok` (a successful account check) | `AVAILABLE` |
| any except `PROBING`, `WAITING_FOR_RESET` | `quota_checkpointed` (a `quota_pauses` row was written) | `WAITING_FOR_RESET` |
| any | `restore_wait` (startup found an open wait, or the supervisor started a wait) | `WAITING_FOR_RESET` |
| `WAITING_FOR_RESET`, `AUTH_REQUIRED`, `RUNTIME_UNAVAILABLE` | `probe_started` | `PROBING` |
| `PROBING`, `WAITING_FOR_RESET` | `probe_result` available | `AVAILABLE` (sets `resumedAt`: the ramp starts) |
| same | `probe_result` limited | `WAITING_FOR_RESET` (learns a newer reset) |
| same | `probe_result` auth / runtime | `AUTH_REQUIRED` / `RUNTIME_UNAVAILABLE` |
| waiting, `QUOTA_PAUSED`, `AUTH_REQUIRED`, `RUNTIME_UNAVAILABLE` | `wait_ended` (deadline, user, policy) | `AVAILABLE` |
| `THROTTLED` | `tick` after `THROTTLE_DECAY_MS` (120,000 ms) | `AVAILABLE` |
| `LIMIT_APPROACHING` | `tick` when the stored reset has passed | `AVAILABLE` |
| `QUOTA_PAUSED` | `tick` with no live wait for `ORPHAN_QUOTA_MS` (30,000 ms) | `AVAILABLE` |

During `WAITING_FOR_RESET` and `PROBING` only a probe or the end of the wait changes the status. A newer
reset time on a `rejected` signal is still learned.

`LIMIT_APPROACHING` is entered only on a runtime `allowed_warning`, or on a runtime percentage (unit
`percent`) at or above `APPROACHING_PERCENT` (90). Observed token counts never cause it. It blocks
nothing; it is information.

`RAMP_MS` is 60,000 ms: see `rampLimit` in [QUOTA_RECOVERY.md](QUOTA_RECOVERY.md).

## Aggregation and the read model

The service answers from SQL aggregates over `usage_events`; the renderer receives aggregates and paged
lists.

| Channel | Input | Output |
|---|---|---|
| `usage.overview` | none | `UsageOverview`: status, availability, account mode, subscription type, observed totals since NEXUS started (`session`), windows, `subscriptionUtilizationPercent`, `nextResetAt`, `retryAfterMs`, `lastLimitAt`, `autoResume`, `usageReportSupported` |
| `usage.totals` | optional `runId`, `projectId`, `campaignId`, `sinceDays` (1 to 365) | `UsageTotals` over `session` rows: sessions, turns, token fields, duration, `limitEvents` |
| `usage.breakdown` | `by` (`agent`, `task`, `run`, `day`, `model`, `strategy`, `campaign`, `role`), optional `runId`, `campaignId`, `sinceDays`, `limit` (1 to 400, default 50) | rows with `key`, `label` and totals |
| `usage.limitHistory` | `limit` (1 to 200, default 50), `offset` | limit events and `quota_pauses` with their `quota_resumes` |
| `usage.run` | `runId` | `RunUsage`: totals, by agent, model and role, the run's pauses |
| `usage.efficiency` | none | tokens and sessions per successful task, repairs per task, and per-strategy rows |
| `usage.refresh` | none | asks the runtime now (account info, usage report if enabled), returns the overview |
| `usage.resumeNow`, `usage.endWait` | none / optional `runId` | user actions; see [QUOTA_RECOVERY.md](QUOTA_RECOVERY.md) |

`usage.overview` observed totals (`session`) are counted in memory since the process started. The
`usage.totals` channel counts stored rows and so spans restarts.

`usage.efficiency` per-strategy rows come from two sources and are never added together: `kind: 'mission'`
(rows of `mission_outcomes`) and `kind: 'arena'` (finished Arena trials with their metrics). Each row has
`n`, `successes`, `passRate`, mean sessions, mean observed tokens, median duration and an evidence label
from `policy/stats.ts`. Arena evidence is controlled; mission history is observational and weighted lower
in the policy ([ADAPTIVE_POLICY.md](ADAPTIVE_POLICY.md)); neither is pooled in displayed counts.

Pushes: the service pushes `{ kind: 'usage', overview }` at once on a status change and otherwise at most
once a second (`PUSH_INTERVAL_MS`, trailing). Notices (`usage.notice`: `limit_reached`, `resumed`,
`wait_ended`) are pushed by the recovery controller.

## Settings: `settings.usage`

`UsageSettingsSchema` and `DEFAULT_USAGE_SETTINGS` in `src/shared/v3.ts`.

| Key | Default | Range | Meaning |
|---|---|---|---|
| `autoResume` | `true` | | Probe and resume without a click. Off: a wait stays until Check now or a manual resume; no `next_check_at` is set |
| `resumeDelaySeconds` | 60 | 15 to 3600 | Seconds after a known reset before the first check |
| `unknownResetProbeMinutes` | 5 | 5 to 240 | First interval of the unknown-reset schedule; it doubles |
| `unknownResetProbeMaxMinutes` | 30 | 5 to 720 | Cap of that schedule (never lower than the base) |
| `maxQuotaWaitMinutes` | 0 | 0 to 10080 | Longest wait before the plan ends it. 0 = no limit of its own |
| `pauseAllOnGlobalLimit` | `true` | | Pause every other active run when one hits the limit |
| `allowLocalTasksWhileWaiting` | `true` | | Shown in Settings. No code outside the settings page reads it; see "Limits" |
| `notifyOnResume` | `true` | | Push a notice after an automatic resume |
| `overnightWaitForReset` | `true` | | Overnight runs wait for a reset; off: they end as `QUOTA_EXHAUSTED` |
| `useRuntimeUsageReport` | `true` | | Ask the runtime's usage report. Off: probes and refresh use no report; probes use one minimal session |

## Security

- No scraping and no private endpoint: everything comes through the Agent SDK's object model. NEXUS calls
  no Claude web endpoint.
- No credentials are read. `getAccountInfo` returns the runtime's account fields (state, mode,
  subscription type, token source); `src/main/modules/usage` never touches a credential store, an API key
  variable or a token.
- `usage_events.raw_classification` holds the runtime's status or error kind (for example
  `rate_limit:rejected`, `assistant_error:billing_error`), never a message body, prompt or credential.
- The service's log lines (`logger`) contain status transitions and error messages from its own failures.
  No prompt text or credential is passed to them.
- The usage report query uses no tools, loads no project settings and persists no session.
- The minimal probe session has no tools (`tools: []`, every authorization denied), runs in the OS temp
  directory, loads no project settings and sends the fixed prompt `Reply with the single word OK.`

## Limits

- Observed usage is what NEXUS sessions reported. It is not the account's usage. It has no denominator.
- A usage figure from before 0.3 does not exist: `usage_events` starts with the 0.3 migration.
- `usage.overview` totals restart at zero with the process; `usage.totals` does not.
- A session's row is updated per turn. If NEXUS is killed, the row holds the last reported turn.
- The service sees only NEXUS sessions. A limit hit by another Claude client is noticed only when the
  runtime says so to a NEXUS session or a report.
- `RUNTIME_UNAVAILABLE` is entered only from a probe outcome of `runtime` (a probe session that crashed,
  timed out or ended in an error). No production code feeds the machine a `crashed` turn signal, so a
  worker crash outside a probe does not change the status.
- `allowLocalTasksWhileWaiting` has no effect in 0.3: while the gate is closed, no task starts, local or
  not (see [ORCHESTRATION.md](ORCHESTRATION.md), "Dispatch gate").
- The per-window `status` for a usage report is derived from the percentage (100 and 90), not stated by
  the runtime.
- The `utilization` of a rate-limit event is kept raw and never shown as a percentage, even if it is one.
- `limit_allowed` events are not stored.

## Not verified

- The usage report was called once for real (see above). Its schema was matched by a single response.
  Other plan types, API-key accounts and third-party providers were not tried.
- A real usage limit was not provoked; see `V0_3_RELEASE_REPORT.md`.
- Whether `rate_limit_info.utilization` is a fraction or a percentage is not documented by the SDK and was
  not established.
- All status transitions, the classification and the aggregation are covered by unit, integration,
  scenario and seeded stress tests with the scripted runtime (`FakeAgentRuntime`) only.

See also: [ARENA.md](ARENA.md), [ADAPTIVE_POLICY.md](ADAPTIVE_POLICY.md),
[SPECULATIVE_EXECUTION.md](SPECULATIVE_EXECUTION.md), [OVERNIGHT_MODE.md](OVERNIGHT_MODE.md).
