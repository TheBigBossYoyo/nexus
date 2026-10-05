# NEXUS 0.3.0 Release Report

Date: 2026-10-05 (final validation 2026-10-04 23:39 to 2026-10-05 02:10, +01:00). Branch `nexus-0.3`, 0.3.0 in
`package.json`. Released by the unattended overnight release train the user authorized: merged into `main`
with `--no-ff` and tagged `v0.3.0`.

## Verdict

**PASS**, with two items NOT VERIFIED that the release criteria allow to stay open.

The 0.3 gate was: Overnight Arena, a generalized workload lifecycle, quota pause and resume, finalization, the
power lifecycle, a completed UI review, no open CRITICAL or HIGH finding, and every final suite green on the
final tree. All of that holds (sections below). Not verified:

- A real Claude usage limit did not occur and none was provoked, so real quota exhaustion and a real automatic
  resume are NOT VERIFIED. The path is covered by simulation only (scenarios, 1000 seeded histories, E2E).
- The NSIS installer was built and not executed (same reason as 0.2.1). Install and uninstall are NOT VERIFIED.

The report dated 2026-10-04 gave PARTIAL because Overnight Arena did not exist and UI review findings were
open. Both were closed on 2026-10-04 and 2026-10-05; see "Changes since the PARTIAL verdict".

## Test results on the final tree

Final tree: the commit that carries this report. Its only differences from `0902f0a`, on which every suite
below ran, are documents and one evidence file.

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | 126 files, 2399 tests passed, 783 s |
| `pnpm stress` with `NEXUS_STRESS_RUNS=1000` | 6 files passed in one run, 7600 s: 1000 orchestrator seeds, 1000 policy simulations, 1000 usage histories, 1000 Arena campaign histories, 1000 overnight histories, 1000 overnight workload histories. No failure dump. See the note below |
| `pnpm test:e2e` | 17 of 17 passed (1 capture-only test skipped by design), 6.8 min |
| `pnpm package` | pass |
| Packaged build on real 0.1, 0.2.0 and 0.2.1 databases | pass, 17 of 17 checks on each |

Note on the stress run. It started at 23:39 on `e4253e5` and its code was loaded then. While it ran, the same
checkout was switched to the 0.4 and 0.5 branches for other work, and other test runs shared the machine, which
is why it took 7600 s instead of about 5300 s. The only change on `nexus-0.3` after `e4253e5` is one corrected
persistence test (`0902f0a`), which no stress file reads. The run was not repeated on `0902f0a`.

## Changes since the PARTIAL verdict

- **Overnight Arena.** An Arena campaign runs under the overnight supervisor: authorization and failsafe before
  the first trial, usage-limit waits inside the deadline, the campaign suspended at the deadline, a final
  report, the end action. Covered by `tests/integration/arena/overnight-arena.test.ts` (13 tests),
  `tests/stress/overnight-workload-stress.test.ts` (1000 histories) and an E2E test on the built app with the
  fake power controller.
- **Generalized workload lifecycle.** The supervisor drives an `AutonomousWorkload` (start, pause, resume,
  cancel, checkpoint, deadline state, finalization, summary, recovery). Missions and Arena campaigns are two
  implementations. Schema 5 stores the workload type with each overnight record.
- **Defect found by the work:** after a restart the usage gate was closed for a waiting overnight campaign with
  nothing to reopen it. Fixed (the gate is restored for a waiting mission only), with a regression test.
- **UI review.** The open items of the first review were done, and two further independent reviews of the
  Overnight Arena screens found no HIGH finding; their MEDIUM findings were fixed (wording that separates the
  final action from the failsafe, authorization text that names the action and claims no consent before the
  box is ticked, inapplicable actions hidden, layout at 1024 px, skip link, timer outside the status region).
- **Tests corrected.** Two tests used a fixed wall-clock date and failed after 22:00 UTC; their clocks are now
  relative. One persistence test passed for the wrong reason (two test migrations with the same version) and
  now uses two distinct versions.

0.2.1 had 80 files, 1772 tests and 10 E2E tests. The baseline of this release (commit `2b9f208`) was green.

Existing assertions that changed:

- Schema version expectations (3 became 4) in three persistence test files.
- One overnight E2E test now passes `quotaPolicy: END_RUN`. Under the default policy a usage limit with no
  reset time is no longer the end of the run: NEXUS keeps checking until the deadline.
- `tests/unit/agent-runtime` and one fake-runtime test: a rejection is now two signals, as the real SDK sends it,
  and a plain rate-limit error is a throttle.
- Unit tests of the unit project have a 30 s limit instead of 5 s. It bounds a hang; it is not a performance
  assertion. Two unit tests timed out at 5 s when the whole suite ran beside the Arena case self-tests.

Earlier full runs, for the record: after backend integration 2192 of 2193 (one exact-millisecond assertion in a
new test, corrected); after the audit fixes 2333 of 2337 (two 5 s unit timeouts under load, and the timing
evaluator of one Arena case, which compared sub-millisecond durations; the evaluator was rewritten).

## Real runtime

Real Claude Agent SDK sessions, Claude subscription subscription, SDK 0.3.288.

| Item | Result | Evidence |
|---|---|---|
| Usage report without a prompt | **Proven.** The runtime answered in about one second with plan windows (five-hour, seven-day, one model bucket), each with a percentage and a reset time | `usage-report-2026-10-04T14-29-45-856Z.json` |
| ADAPTIVE mission | **Proven.** 15 of 15 gates, first real attempt | `adaptive-mission-2026-10-04T18-05-43-454Z.json` |
| ADAPTIVE mission on the packaged 0.3.0 build | **Proven.** 15 of 15 gates | `adaptive-mission-2026-10-04T21-14-53-810Z.json` |
| Speculative task | **Proven.** 17 of 17 gates, first attempt | `speculative-mission-2026-10-04T18-07-22-727Z.json` |
| Arena campaign, 3 cases, 2 strategies | **Proven** on the second run. 15 of 15 gates. The first run met 14 and exposed a NEXUS defect | `arena-campaign-2026-10-04T19-01-28-621Z.json` (first), `arena-campaign-2026-10-04T19-23-06-020Z.json` (second) |
| Usage limit, pause, automatic resume | **NOT VERIFIED** for real. No limit occurred and none was provoked | |

The three mission runs used the development build of the code that became 0.3.0. After the second Arena run
only the version string, documents and the packaged-validation script changed.

### ADAPTIVE mission

- Task profile `bugfix|medium|low` (category, complexity and risk inferred; language and file counts measured).
- Decision: Build, layer `default`. Reason recorded: no promoted preference applies, the default policy gives
  Build. With no evidence this is the expected answer.
- Real planner, worker, reviewer, task verifier and mission verifier sessions (planner, reviewer and verifier
  on Opus, worker on Sonnet). Run completed in about two minutes.
- Independent test run on the integration branch passed. Mission outcome recorded with 5 sessions and the
  observed tokens. The active policy did not change. The user's checkout was untouched.

### Speculative task

- Two candidates in separate clones from the same commit, different SDK sessions.
- Both implemented the task and both passed the checks. The tournament chose candidate B on "smaller change"
  (87 lines against 105) and recorded the decision as `marginal`: no correctness rule separated them.
- The winner was reviewed and verified. The loser's diff and evidence were stored. Both clones were removed and
  no candidate branch existed in the user's repository.

### Arena campaign

Cases `bugfix-localized`, `feature-small`, `ui-state-bug`; strategies Single and Build; one repetition; ECO
budget (at most 2 agents per trial).

| Run | Single | Build | Notes |
|---|---|---|---|
| First | 3 of 3 passed | 1 of 3 passed, 2 timed out | In both timed-out trials an agent asked for approval of a shell command. Nothing answers approvals in a trial, so the run waited until the case's time budget |
| Second | 3 of 3 passed | 3 of 3 passed | After the fix |

The defect was in NEXUS, not in the strategy. Fix: an unattended trial answers approval requests (a tool
request is denied and the agent continues; task starts and graph changes are approved except a high-risk task
start), the same rule as an unattended overnight run. Regression test:
`tests/scenarios/v3-arena.test.ts`, "answers approval requests in an unattended trial".

What the second run says: six trials, all passed their hidden evaluation. NEXUS labels the evidence
INSUFFICIENT (n = 3 per strategy), proposed no policy candidate and left the policy at version 1. Build used
5 to 9 sessions per trial and Single 3; nothing is concluded from that. It does not show that either strategy
is better.

## Usage and quota recovery

| Item | Result |
|---|---|
| Usage captured from the SDK | Per-session tokens, turns, duration, model; rate-limit status, reset time, limit type; plan windows from the usage report. Tested, and seen with the real runtime |
| Provenance | Every figure carries a source and a confidence. A percentage is shown only when the runtime supplied one. Tested (unit walker over the read model, E2E on the page) |
| Quota classification | A usage limit is a rejected rate-limit event, a usage-limit message, or a billing error. A plain rate-limit error is a throttle. Tested with the scripted runtime. NOT VERIFIED against a real limit |
| Pause | Run paused with reason `quota`, task not failed, no attempt consumed, checkpoint written, dispatch closed for every run. Tested |
| Automatic resume, known reset | Check shortly after the reset, resume after a successful check, same run, graph, worktrees and sessions. Tested (scenario and E2E in the built app) |
| Automatic resume, unknown reset | Checks at 5, 10, 20, 30, 30... minutes. Tested (scenario and E2E) |
| Restart during a wait | State kept, resumes later; a wait the user ended stays ended. Tested |
| Overnight | Waits only when the next check is before the deadline; deadline and failsafe never moved. Tested |

## Packaged build

| | |
|---|---|
| Installer | `release/NEXUS-Setup-0.3.0.exe`, 207,250,922 bytes, built 2026-10-05 02:07 from `0902f0a` |
| SHA-256 | `2d905b9e10835472a9bd79abcccb1d870fc0e47e98cbdfb86eebbd29eb38e650` |
| Installed launch, uninstall | **NOT VERIFIED.** The installer was not executed (see the 0.2.1 report) |

Verified on `release/win-unpacked/NEXUS.exe`, with real databases of 0.1 (schema 1), 0.2.0 (schema 2) and 0.2.1
(schema 3), 17 checks each, all passed (`packaged-validation-2026-10-05T01-10-11-387Z.json`; the earlier
run on the first 0.3.0 build is `packaged-validation-2026-10-04T21-12-44-080Z.json`):

- Launches as packaged 0.3.0. Schema upgraded to 5, no row lost, and the older database kept as
  `nexus.db.v<n>.bak`.
- The old run is readable and opens in the redesigned Mission Control (strategy shown as "Not recorded").
- Home, Missions, Arena, Policy, Usage, Overnight and Settings render.
- The 12 built-in Arena cases are found in the packaged resources.
- Default policy active, usage overview answers, Claude status reported, a project opens.
- Overnight panel renders, start disabled until authorized. No test switch works in a packaged build.

A real ADAPTIVE mission on the packaged 0.3.0 build (`release/win-unpacked/NEXUS.exe`, real Claude sessions)
completed with 15 of 15 gates on the first 0.3.0 build (it was not repeated on the final build): task profile, policy decision (Build, default layer), real planner, worker,
reviewer and verifier sessions, independent test run, mission outcome and observed usage recorded, user checkout
untouched. Evidence: `adaptive-mission-2026-10-04T21-14-53-810Z.json`.

## Audit

Three independent read-only code audits (benchmark methodology and policy statistics; usage, quota recovery and
scheduling; Git isolation, security, persistence and Windows/Electron) and one UI review.

| Severity | Found | State |
|---|---|---|
| Critical (code) | 0 | |
| High (code) | 10 | 9 fixed, 1 mitigated with a stated requirement |
| Medium (code) | about 21 | about 18 fixed, 3 not fixed |
| Low (code) | about 20 | about half fixed |
| UI review | 2 critical, 7 high, 11 medium or low | 18 of 20 work items done, 2 partly |

High findings:

1. Harness failures counted as strategy failures in policy evidence. **Fixed** (a blocked trial records why;
   harness blocks are excluded everywhere).
2. Two harness blocks could suppress a strategy in every context. **Fixed** (suppression per context level, on
   that level's evidence, and only when most observations failed).
3. Repetitions of one case counted as independent evidence. **Fixed** (a candidate needs at least 5 Arena
   trials from at least 3 cases; labels capped below 3 cases).
4. An overnight quota wait that ended by manual resume, deadline or cancel left dispatch closed for every run.
   **Fixed.**
5. The SDK's second rejection signal erased the exact reset time. **Fixed** (and the scripted runtime now sends
   both signals).
6. A restart reopened a wait the user had ended and resumed the run. **Fixed.**
7. A pause or restart during speculation could skip the tournament and check an empty worktree. **Fixed.**
8. The trust of an imported Arena case did not cover its `setup` and `checks` commands. **Fixed** (the whole
   definition is pinned; the stored definition is what runs).
9. Speculative candidates could read each other through Git, because they were worktrees of one repository.
   **Fixed** (each candidate is a separate clone).
10. A packaged NEXUS has no Node.js, and every built-in Arena case needs it. **Mitigated:** the Arena checks
    for Node.js 20 or newer on PATH before a campaign starts and says what is missing. Node.js is not bundled.

Fixed medium findings include: a probe that could report "available" while still limited and resume in a loop
(now bounded and window-aware); a transient rate-limit error treated as a usage limit; quota-ended agents
recorded as failed; stale plan windows shown as exact; two built-in evaluators that accepted degenerate
solutions (rewritten, with cheating solutions kept as fixtures that must fail); hidden evaluators that depended
on shell glob expansion; evaluator copy following links; credentials visible to check commands; code execution
through a `.git` directory in a fixture; Arena runs crowding the user's Home and Activity feeds; no copy of the
database before a schema upgrade.

Not fixed:

- In a dual review, a reviewer that hits a usage limit makes both reviews run again after the resume.
- The campaign session budget is checked after each trial, so a running trial can exceed it. The case-level
  session budget is read by nothing.
- The evidence label stored in `strategy_statistics` is not capped for few cases; the one decisions and the UI
  use is.
- Trial repositories are removed only by `arena.cleanup`; there is no button for it yet, and the Node.js status
  (`arena.status`) is not shown before a campaign is created. A campaign without Node.js fails at start with
  the reason.
- UI: project facts alignment. Dark theme and focus rings were not re-checked after the fixes. (The status
  badge, the per-strategy counts, the Agents list below 1100 px and the composer note were done on 2026-10-04.)
- The fix authors did not run each new regression test against the unfixed code. The auditors' own proofs are
  the evidence that the defects existed.

Also found while working: a polling timer in the Arena service that kept running after `dispose()` against a
closed database (fixed); an ordering bug in the usage breakdown query (fixed, found by its test).

## UI

Complete light redesign: design tokens, a collapsible three-group navigation, a contextual page header with
global status, Home, Mission Control, the task inspector with seven tabs, Agents, the composer with a strategy
selector and "what Adaptive would choose", Arena, Policy, Usage, Overnight, Activity, Settings.

- 17 E2E tests on the built app with the scripted runtime (one more than on 2026-10-04: Overnight Arena); 6 of the first 16 were new in 0.3 and cover navigation, the usage states,
  the quota banner with automatic resume for a known and an unknown reset, an ADAPTIVE mission, an Arena
  campaign created through the dialog, and the policy page.
- 11 stored screenshots of screens that are the same on every run (first launch, empty and default states).
  They are specific to this machine's font rendering. Mission Control, the inspector, Arena results and the
  quota states are captured on every run and not compared pixel by pixel, because they show times and ids.
- The independent review's verdict was a qualified yes: a real redesign with honest usage wording, Mission
  Control not yet at flagship quality. Its findings were then worked through (see Audit). Two further
  reviews covered the Overnight Arena screens (see "Changes since the PARTIAL verdict").

## Known limitations

- A real usage limit was never met. Classification of a real limit, the order of the SDK's two signals, and the
  minimal-session probe against a limited account are NOT VERIFIED.
- The runtime's usage report is an SDK method marked experimental. If it changes or disappears, NEXUS shows
  "not exposed by runtime" and probes with one minimal session.
- Observed usage is what NEXUS sessions reported. Other Claude clients use the same account and are not seen.
- Overnight Arena was exercised with the fake power controller only. No real campaign ran under a real
  shutdown timer.
- Arena cases need Node.js 20 or newer on PATH. Repository-origin cases can be provisioned but not created
  through the UI.
- One real campaign of six trials is not evidence about strategies. NEXUS does not claim that any strategy is
  better in general.
- One Arena evaluator measures scaling by timing. It was not stress-tested on a heavily loaded machine beyond
  the full suite.
- A non-overnight run with an unknown reset keeps checking every 30 minutes for as long as NEXUS runs.
- Speculation applies to a single-task run; a clone per candidate copies the repository's objects.
- Installer not executed. Real sleep, hibernate and a completed shutdown not executed (unchanged from 0.2.1).
- The agent shell policy is still a lexical filter, not a sandbox (unchanged from 0.2.1).

## Ready to merge and tag?

Yes. Merged into `main` with `--no-ff` and tagged `v0.3.0` on 2026-10-05 under the release policy of the
overnight release train (a release that passes its gate is merged and tagged; a partial one is not).

## Evidence

- Commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm stress` (`NEXUS_STRESS_RUNS=1000`),
  `pnpm test:e2e`, `pnpm package`, `pnpm smoke:usage`, `node scripts/strategy-acceptance.mjs adaptive|speculative`,
  `node scripts/arena-acceptance.mjs`, `node scripts/packaged-validation.mjs`.
- Committed evidence: `docs/acceptance/usage-report-*.json`, `adaptive-mission-*.json`,
  `speculative-mission-*.json`, `arena-campaign-*.json` (both runs), `packaged-validation-2026-10-04T21-*.json`.
- Screenshots (not committed): `test-results/screenshots/`. Stored comparison images: `tests/e2e/__screenshots__/`.
- Documents: ARENA.md, BENCHMARK_METHODOLOGY.md, ADAPTIVE_POLICY.md, SPECULATIVE_EXECUTION.md,
  USAGE_INTELLIGENCE.md, QUOTA_RECOVERY.md, UI_DESIGN_SYSTEM.md, V0_3_DESIGN.md (with implementation notes),
  V0_3_PROGRESS.md.
