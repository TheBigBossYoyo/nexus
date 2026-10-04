# Quota Recovery (0.3)

When Claude reports a usage limit, NEXUS pauses the work it can pause, remembers why, waits, checks
whether Claude is available again, and resumes the paused runs through the ordinary resume path. A usage
limit is not a failure: no task is failed, no attempt is consumed and no work is discarded.

Code: `src/main/modules/usage/recovery.ts` (`QuotaRecoveryController`), `machine.ts` (`planQuotaWait`,
`rampLimit`), `probe.ts` (`RuntimeAvailabilityProbe`), `service.ts` (gate and status),
`src/main/modules/orchestrator/orchestrator.ts` (`setDispatchGate`, `tick`), `overnight/supervisor.ts`
(Overnight runs), `src/main/index.ts` (composition). Status machine and settings:
[USAGE_INTELLIGENCE.md](USAGE_INTELLIGENCE.md).

## What NEXUS knows

- Quota reset behaviour depends on what the runtime reports. The runtime sometimes gives a reset time and
  sometimes does not. NEXUS never fabricates remaining quota or a reset time; a percentage is shown only
  when the runtime supplied it.
- The runtime usage report that probes prefer is an SDK method declared experimental or unstable. NEXUS
  treats it as optional and falls back to conservative probing.
- The limit NEXUS sees is the one a NEXUS session hit. Other Claude clients on the same account share the
  quota.

## Classification: quota, throttle, auth

Done in `agent-runtime/translate.ts` (what the runtime said) and `usage/classify.ts` (what it means).

| Signal | Class | Effect |
|---|---|---|
| `rate_limit_event` status `rejected` | quota | turn outcome `quota`; reset time and window type kept |
| Assistant error `billing_error` | quota | outcome `quota`; no reset time or window type |
| Assistant error `rate_limit` after a `rejected` rate-limit event of the same session, or whose text starts with an SDK usage-limit prefix | quota | outcome `quota` |
| Assistant error `rate_limit` with neither | throttle | a plain 429: event `agent.rate_limited` with status `throttled`; nothing pauses |
| Failed result whose text starts with an SDK `USAGE_LIMIT_ERROR_PREFIXES` entry | quota | outcome `quota` |
| `rate_limit_event` status `allowed_warning` | information | status `LIMIT_APPROACHING`; nothing pauses |
| Assistant error `overloaded` or `server_error` | throttle | `THROTTLED` for up to 120 s or until the next successful message; nothing pauses |
| Assistant errors `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `cloud_credential_error` | auth | outcome `auth`; the run pauses with cause `auth` (a person must act; the controller does not wait for it) |

A throttle is never turned into a quota pause, and a quota signal is never turned into a retry. A later rejection of
the same pause that carries no reset time never erases a reset time already known (the SDK reports one limit twice: a
rate-limit event with the reset, then an error without one). An agent whose session ended with `quota` or `auth` is
recorded as `stopped` (reason recorded), not `failed`.

## What happens on a limit, step by step

1. **Session ends with outcome `quota`.** The pipeline treats it as a halt (`haltOutcome`): the task keeps
   its state and its SDK session id, no attempt is consumed, nothing is marked failed (the agent is `stopped`). The orchestrator
   calls `pauseRun(runId, 'quota', 'Claude usage limit reached')`. The same happens when planning or the
   consensus planner hits the limit.
2. **Run paused.** The run becomes `paused` with `pauseReason: quota` and emits `run.paused` with
   `cause: quota`. The run's own sessions are stopped as for any pause.
3. **Controller reacts** (`handleQuotaPause`), unless the run is an Overnight run (the supervisor owns
   those, see below), the run is not `paused/quota`, or it already has a live row.
   - A `run_checkpoints` row is written (reason `quota`) and `checkpoint.saved` is emitted. At most 50
     checkpoints are kept per run.
   - A `quota_pauses` row of scope `global` is inserted if none is live. It holds the reset time (and its
     confidence: `EXACT` when known, else `UNKNOWN`), the limit type, `probes: 0` and `next_check_at`. A run rejected again
     within `RESUME_CARRY_MS` (10 minutes) after an automatic resume continues the same wait: the new global row keeps
     the earlier start and carries `probes + 1`, so the backoff and `maxQuotaWaitMinutes` accumulate. After
     `MAX_FAILED_RESUMES` (6) automatic resumes that Claude rejected again, the wait ends (`wait_ended` notice) and the
     runs stay paused.
   - A `quota_pauses` row of scope `run` is inserted for this run, with the checkpoint id and the run's
     resume state.
   - The status machine gets `quota_checkpointed` and moves to `WAITING_FOR_RESET`.
   - `usage.quota_paused` is emitted on the run.
   - With `pauseAllOnGlobalLimit` on (default), every other active, non-overnight run that can be paused is
     paused with the same reason and detail "paused together with the other runs". Their own
     `run.paused` events create their rows.
   - When the global row was created now, one notice is pushed (`limit_reached`): "NEXUS has safely paused
     N run(s). Automatic resume: HH:MM." (the clock time is shown only when the reset time is known;
     otherwise "when Claude is available again"; with `autoResume` off, "Resume the runs from their pages
     when Claude is available again.").
4. **Dispatch gate closes** (next section).
5. **Wait is planned** (`planQuotaWait`, below) and stored as `next_check_at`.
6. **At `next_check_at`** the controller probes (below). Available: resume. Still limited: re-plan.

## Dispatch gate

`Orchestrator.setDispatchGate(gate)` installs the usage service as the gate (`src/main/index.ts`).
`gate.canDispatch()` is false while the status is `QUOTA_PAUSED`, `WAITING_FOR_RESET`, `PROBING`,
`AUTH_REQUIRED` or `RUNTIME_UNAVAILABLE`, or while a live `global` row exists in `quota_pauses`.

| While the gate is closed | Behaviour |
|---|---|
| New task pipelines | Do not start (`selectRunnable` gets `paused: true`) |
| New planning session | Not started: the run pauses with reason `quota` and the detail "Waiting for Claude usage to be available before planning"; it resumes into planning |
| Orphaned tasks | Not restarted (`restartOrphans` is skipped) |
| Run finalization (the mission verifier is a session) | Not started |
| "Stuck" detection ("no task can make progress") | Skipped, so a closed gate never raises an intervention pause |
| Check commands and merges already running | Finish. They are local work |
| Sessions already running in a run that was not paused (`pauseAllOnGlobalLimit` off) | Continue until they end |
| Arena campaigns | Derived pause, below |

When the gate reopens the orchestrator ticks every active run. `gate.limit(normal)` lowers the parallel
limit during the ramp, and the ramp also limits how many orphaned tasks are restarted at once.

A closed gate that nothing owns reopens by itself: when status is `QUOTA_PAUSED`, `WAITING_FOR_RESET` or `PROBING`, no
`quota_pauses` row is live, no Overnight run is in `QUOTA_PAUSED`, and `ORPHAN_QUOTA_MS` (30,000 ms) has passed, the
controller tick returns the status to `AVAILABLE`.

## Wait planning: `planQuotaWait`

Pure. Inputs: `now`, known `resetAt` (ms or null), `probes` made so far, `settings`, the Overnight
`deadline` (or null) and `pausedAt`.

| Case | `checkAt` | Basis |
|---|---|---|
| Reset known, and in the future (or no probe made yet) | `max(resetAt, now) + resumeDelaySeconds` (default 60 s) | `reset` |
| Reset unknown | `now + backoffMinutes(probes)` | `backoff` |
| Reset passed but the probe still found the limit | `now + backoffMinutes(probes - 1)` | `backoff` |

`backoffMinutes(index) = min(cap, base * 2^index)`, `base = unknownResetProbeMinutes`,
`cap = max(base, unknownResetProbeMaxMinutes)`. With the defaults (5 and 30) the intervals are 5, 10, 20,
30, 30, 30 ... minutes. The settings bound them: base 5 to 240, cap 5 to 720.

The plan is `end` instead of `wait` when:

| Condition | Reason text |
|---|---|
| `deadline` is set and `checkAt >= deadline` | "The usage limit resets after the mission deadline." (reset basis) or "The next availability check would fall after the mission deadline." |
| `maxQuotaWaitMinutes > 0` and `checkAt - pausedAt` is more than that | "The usage limit wait would exceed the configured maximum of N minutes." |

For ordinary runs the deadline is always null (only Overnight runs have one). `maxQuotaWaitMinutes`
defaults to 0: no limit of its own, so an ordinary run with an unknown reset is probed at the capped
interval for as long as the application runs.

With `autoResume` off, no `next_check_at` is stored and nothing is probed on a schedule. The wait lasts
until Check now, a manual resume or End wait.

## Probing: `probe.ts`

The controller's scheduler (`tick`, every 10 s; `tickIntervalMs`) runs `probeAndResume` when the global
row's `next_check_at` has passed. At most one probe is in flight: concurrent callers (the scheduler,
Check now, the supervisor's own probe object) share the first one's answer.

1. **Usage report first** (when `usage.useRuntimeUsageReport` is on and the runtime has `getUsageReport`).
   No prompt, no model call. The probe is window-aware: it receives the type of the window that was rejected.
   - The rejection named no window (`billing_error`, overage, no limit type), or the report has no such window: the report
     alone is not trusted; fall through to the minimal session. A `billing_error` therefore never resumes automatically
     from the report alone.
   - The named window reports no percentage: a reset still in the future means limited; otherwise no answer, fall through.
   - The named window reports a percentage: 100 or more is limited unless its reset time has passed (a stale 100 percent
     window is not a limit); below 100 is available.
   - With no hint (Check now): the highest window whose reset has not passed decides, the same 100 threshold.
   - `rateLimitsAvailable` false, an error or a timeout: no answer; fall through.
2. **Minimal session fallback.** One session with `maxTurns: 1`, no tools (every authorization denied),
   working directory in the OS temp directory, no project settings, the fast model tier from
   `settings.models.tiers.fast`, system prompt appendix "This is an availability check. Answer in one
   word.", and the prompt `Reply with the single word OK.` (`USAGE_PROBE_PROMPT`). It has a 90 s timeout
   (`SESSION_TIMEOUT_MS`).

| Probe outcome | Meaning |
|---|---|
| `available` | report below 100 (or stale), or the session completed |
| `limited` | report at 100 or more with a reset still ahead, or the session ended with outcome `quota` (a reset time in a `rejected` event is kept) |
| `auth` | the session ended with outcome `auth` |
| `runtime` | the session timed out, crashed or ended in another error |

Frequency bound: a probe happens only at `next_check_at` (5 minutes at the earliest with the defaults for
an unknown reset), or when a person presses Check now. A limited account sees at most one small request
per interval.

Each probe writes a `quota_resumes` row (`kind: probe`; result `available`, `still_limited` or `failed`;
`method`: `usage_report`, `minimal_session` or `none`; `detail`; `waited_ms`) and a `usage_events` row of
type `probe`, and emits `usage.probe` on every waiting run.

An `auth` or `runtime` outcome re-plans like `limited`: the wait is not ended, the status becomes
`AUTH_REQUIRED` or `RUNTIME_UNAVAILABLE` (gate still closed), and the next check follows the backoff.

## Resume

On an `available` probe (`resumeAll`):

1. The global row is claimed with `QuotaPauseRepository.close(id, 'resumed', ...)`. An `UPDATE ... WHERE
   state IN ('waiting','probing')`: it returns false if another caller closed it first, and then
   nothing is resumed. This is what makes the resume idempotent.
2. The status machine gets `probe_result: available`: status `AVAILABLE` and `resumedAt` set.
3. Each live `run` row, oldest `paused_at` first: if the run is no longer `paused` with reason `quota`
   (a person resumed or cancelled it), its row is closed as `cancelled` and it is skipped. Otherwise its
   row is claimed (`resumed`) and `orchestrator.resumeRun(runId)` is called.
4. `resumeRun` is the existing path: it reconciles worktrees, restores the run to its stored resume state
   and ticks. A task whose implementing session ended for a resumable reason (`paused`, `quota`, `auth`,
   `app_restart`, `shutdown`) and has an SDK session id resumes that session; otherwise a fresh session
   continues from the structured handoff of 0.2.1 ([RECOVERY.md](RECOVERY.md), "Session resume versus a
   fresh session with handoff"). Tasks, worktrees, commits, messages and decisions are kept. A run paused
   before planning resumes into planning.
5. A `quota_resumes` row (`kind: resume`, `result: resumed`) is written per run and `usage.quota_resumed`
   is emitted. If `resumeRun` throws, a `failed` row is written and the run is tracked again as a new
   wait (probed on the schedule).
6. With `notifyOnResume` on and at least one run resumed, one notice is pushed (`resumed`): "Mission
   resumed automatically after N minutes."

User-paused runs (cause `user`) are never in this list: only rows created for `pauseReason: quota` runs
exist.

### Ramp: `rampLimit`

After an available probe the status machine stores `resumedAt`. For `RAMP_MS` (60,000 ms) the gate's
`limit(normal)` returns `min(1, normal)`: one new session at a time. After that it returns the run's
normal parallel limit. `tickRamp` clears `resumedAt` on the next controller tick after the minute. The
ramp exists so that resuming N runs does not start N sessions at once into a window that may be nearly
empty.

## Restart during a wait

The `quota_pauses` rows are the durable state. An ended wait stays ended: a run whose wait was ended (by the person or by
the plan) after it paused is not given new rows by `recover()` and stays paused for a manual resume
(`waitEndedSincePause`). After `recoverOnStartup` (which converts runs that were
active into recovery pauses and leaves `paused/quota` runs alone), `src/main/index.ts` calls
`recovery.recover()`:

- rows whose run is no longer paused for quota are closed (`cancelled`);
- a run that is `paused/quota` with no live row (a crash between the pause and the row) gets its rows now;
- if run rows exist without a global row, a global row is created from the first run row's reset time and
  probe count, and re-planned;
- a global row left in `probing` returns to `waiting` (the probe did not complete);
- a global row with no `next_check_at` (and `autoResume` on) is planned again;
- the status machine is set to `WAITING_FOR_RESET`.

If the stored reset time has passed while NEXUS was closed, the plan's first branch gives
`checkAt = now + resumeDelaySeconds` and the first scheduler pass probes. A run that was `paused/quota`
is not converted into a recovery pause and is not offered for recovery.

At shutdown `recovery.dispose()` stops the scheduler and `recovery.idle()` waits for a tick or probe in flight before the
database closes; a probe that finishes after disposal writes nothing and resumes nothing.

## User actions

| Action | Channel | Effect |
|---|---|---|
| Check now | `usage.resumeNow` | Probe at once; resume if available. Shares an in-flight probe. With no open wait it only reconciles |
| End wait (all) | `usage.endWait` | Closes every live row except `overnight` as `ended` ("Ended by the user"), opens the gate (`wait_ended`). Runs stay paused for manual resume |
| End wait (one run) | `usage.endWait { runId }` | Closes that run's row. The global row closes too when no run row remains |
| Resume a run by hand | `runs.resume` | The run leaves `paused/quota`; the controller closes its row as `cancelled` on `run.resumed`. If it was the last waiting run the global row is closed too. The gate opens; if Claude is still limited the next session ends with `quota` and the run pauses again |
| Cancel a run | `runs.cancel` | Same bookkeeping on `run.cancelled` |

Both usage actions return the fresh `UsageOverview`.

## Notifications

Pushed as `{ kind: 'usage.notice', notice, title, detail }`; the renderer shows a banner on every page
while a wait is active and a notice for each of these.

| `notice` | When |
|---|---|
| `limit_reached` | The global wait row was created |
| `resumed` | At least one run resumed and `notifyOnResume` is on |
| `wait_ended` | The plan ended the wait during a re-plan ("Automatic resume stopped ... The runs stay paused") |

No notice is pushed when the wait is ended by the user, or when the very first plan ends the wait (see
"Limits").

## Overnight Mode

The supervisor owns an Overnight run's wait; the controller skips those runs. The supervisor uses the same
`planQuotaWait` and the same probe object (`RuntimeAvailabilityProbe`, passed as `deps.probe`). The deadline
and the failsafe are not moved by a quota wait. The only way to move them is EXTEND MISSION, a user action.
No quota code path touches the failsafe.

On `run.paused` with cause `quota`, `onQuota` decides:

| Situation | Result |
|---|---|
| Policy `quotaPolicy: END_RUN` | Ends `QUOTA_EXHAUSTED` ("The policy ends the run on a usage limit.") |
| `usage.overnightWaitForReset` off | Ends `QUOTA_EXHAUSTED` |
| The run already waited `MAX_QUOTA_WAITS` (6) times | Ends `QUOTA_EXHAUSTED` |
| Reset known, check time (`reset + resumeDelaySeconds`) before the deadline | State `QUOTA_PAUSED`; wait. The reset is the newest rejection since the run last resumed that carries one, so a second rejection without a reset does not hide it |
| Reset known, check time at or after the deadline | Ends `QUOTA_EXHAUSTED` |
| Reset unknown, first check (now + 5 min) before the deadline | Wait; probes on the 5, 10, 20, 30, 30 ... minute schedule |
| Reset unknown, next check at or after the deadline | Ends `QUOTA_EXHAUSTED` |
| `maxQuotaWaitMinutes` set and exceeded | Ends `QUOTA_EXHAUSTED` |
| At the check time, probe available | Resume through `resumeRun`; state back to `RUNNING` |
| At the check time, probe limited or failed | Re-plan from the new reset (or the backoff); may end as above |
| The mission deadline arrives while waiting | The supervisor tick finalizes `TIME_LIMIT` and closes the row |
| A person resumes the run | Row closed `cancelled`, state `RUNNING` |
| `resumeRun` fails | `BLOCKED` |

The reset time is read from the newest rejected `agent.rate_limited` event since the run last resumed that
carries one. The supervisor also writes a `quota_pauses` row of scope `overnight` (history stays uniform, with the
limit type) and the controller never touches it. Every exit from an overnight wait releases the dispatch gate (the usage
service handles `overnight.state_changed` from `QUOTA_PAUSED`), and a gate nobody owns self-heals (see "Dispatch gate"). Without a probe object the supervisor behaves as in 0.2.1
(`decideQuota`: wait only for a known reset, resume 90 s after it, never probe).

`MAX_QUOTA_WAITS` counts waits, not probes. See [OVERNIGHT_MODE.md](OVERNIGHT_MODE.md) for the end-of-run
pipeline and the restart rules (a NEXUS absence of more than 10 minutes ends the unattended session
whatever the quota state).

## Arena campaigns

An Arena trial is a normal run on an Arena project, not an Overnight run, so the controller pauses and
resumes it like any other run. The campaign's own pause is derived (`ArenaService.reconcile`): the campaign
becomes `paused` with reason `quota` while the usage gate is closed or a trial's run is paused for
`quota`, queued trials are not started, and the campaign goes back to `running` when the gate is open and
no trial is quota-paused. The campaign's wall-clock budget counts active time only; a quota wait does not
count. See [ARENA.md](ARENA.md). Overnight Arena under the supervisor is not implemented in 0.3.

## Speculative candidates

A pause stops the candidate sessions with the run. Finished candidates keep their stored evidence;
unfinished ones resume their SDK session when it is resumable, or continue in the same worktree with a
fresh session ([SPECULATIVE_EXECUTION.md](SPECULATIVE_EXECUTION.md)). ADAPTIVE does not choose
SPECULATIVE while Claude is not `AVAILABLE` or within an hour of a usage limit
(`UsageIntelligenceService.recentLimitWithin`).

## Events

| Event | Scope | Payload |
|---|---|---|
| `usage.quota_paused` | run | `pauseId`, `resetAt`, `nextCheckAt`, `limitType` |
| `usage.probe` | run (each waiting run) | `pauseId`, `method`, `result` |
| `usage.quota_resumed` | run | `pauseId`, `waitedMs`, `method` |
| `usage.wait_ended` | run | `pauseId`, `reason` |
| `overnight.quota` | run | `action` (`waiting`, `resumed`, `exhausted`), `resetsAt`, `resumeAt` (supervisor) |
| Push `usage` | app | `UsageOverview` |
| Push `usage.notice` | app | `notice`, `title`, `detail` |

## Tables

| Table | Content |
|---|---|
| `quota_pauses` | `scope` (`global`, `run`, `overnight`), `state` (`waiting`, `probing` are live; `resumed`, `ended`, `cancelled`), `paused_at`, `limit_type`, `reset_at`, `reset_confidence`, `next_check_at`, `probes`, `checkpoint_id`, `resume_state`, `ended_at`, `end_reason` |
| `quota_resumes` | `pause_id`, `run_id`, `kind` (`probe`, `resume`), `result` (`available`, `still_limited`, `resumed`, `failed`, `skipped`), `method`, `detail`, `waited_ms` |
| `run_checkpoints` | one row per paused run, reason `quota` |
| `usage_events` | `limit_rejected`, `probe` rows |

## Test-build timing overrides

Read in `src/main/index.ts` only when the application is not packaged (`!app.isPackaged`), as numbers
greater than 0. They cannot be set in a packaged build.

| Variable | Effect |
|---|---|
| `NEXUS_USAGE_TICK_MS` | Scheduler interval of the controller (accepted when 100 or more; default 10,000) |
| `NEXUS_USAGE_RESUME_DELAY_S` | Replaces `resumeDelaySeconds` |
| `NEXUS_USAGE_PROBE_S` | Replaces the first unknown-reset interval (seconds); the cap becomes 6 times that unless `probeMaxSeconds` is passed |
| `NEXUS_FAKE_USAGE` | Only with `NEXUS_FAKE_RUNTIME=1` in an unpackaged build: `unknown` makes the scripted runtime report no usage report; a number sets the plan window percentage it reports |
| `NEXUS_USAGE_DEMO_RESET_S` | Read by the scripted runtime's demo script (`quota-reset` behaviour): seconds until the simulated reset, default 6 |

The overrides apply to the controller only. The Overnight supervisor reads the stored settings.

## Limits

- Pausing a run stops that run's sessions; a limit cannot be handled mid-turn. Work in a turn that ended
  with `quota` is kept only as far as it was committed or reported before the limit.
- With `pauseAllOnGlobalLimit` off, other runs keep their sessions until they hit the limit themselves;
  the gate still stops new sessions everywhere.
- The first plan can end the wait immediately: when `maxQuotaWaitMinutes` is set below the planned first
  check, the rows are written and closed as `ended` with the reason, the `wait_ended` notice is pushed, and the run stays
  paused with reason `quota` for a manual resume. A restart does not reopen it.
- Ordinary runs have no deadline: with an unknown reset and `maxQuotaWaitMinutes` 0 the controller probes
  at the capped interval indefinitely, as long as NEXUS runs.
- A rejection with no window type can only be checked with a minimal session, which costs one small request per interval.
- While dispatch is closed no task starts, local or not; checks and merges already running finish. There is no setting for this.
- Resume depends on the SDK session still being resumable; otherwise the 0.2.1 handoff is used.
- Auth and runtime failures are not waited out by the controller beyond the backoff re-plan; authentication
  is fixed by a person.
- A usage limit hit by another Claude client is detected only when a NEXUS session or a probe sees it.

## Not verified

- A real usage limit has not been hit and recovered from; see `V0_3_RELEASE_REPORT.md`. Everything above
  about what happens at a limit is covered by unit, integration, scenario and seeded stress tests with the
  scripted runtime (`FakeAgentRuntime`) and a manual clock (`tests/scenarios/usage-recovery.test.ts`,
  `tests/scenarios/usage-overnight.test.ts`, `tests/stress/usage-stress.test.ts`), not by the real runtime.
- The minimal-session probe has not been run against the real runtime. Only the usage report has
  (`pnpm smoke:usage`, 2026-10-04, no prompt sent).
- Whether a real `rejected` event carries a reset time, and how far ahead, was not observed.
- Whether a resumed SDK session after a long wait is still resumable on the real runtime was not
  observed.

See also: [USAGE_INTELLIGENCE.md](USAGE_INTELLIGENCE.md), [OVERNIGHT_MODE.md](OVERNIGHT_MODE.md),
[ARENA.md](ARENA.md), [ADAPTIVE_POLICY.md](ADAPTIVE_POLICY.md),
[SPECULATIVE_EXECUTION.md](SPECULATIVE_EXECUTION.md).
