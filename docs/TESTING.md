# Testing

Automated tests never call the real Claude API. Every test that needs an agent uses
`FakeAgentRuntime`. The only code path that talks to Claude from the test tooling is the manual smoke test.

## Layers

| Layer | Location | Runs with | What it covers |
|---|---|---|---|
| Unit | `tests/unit/**/*.test.ts` | `pnpm test:unit` | Pure logic and adapters with seams: task graph and plan validation, scheduler (`selectRunnable`, file overlap, leases, retry planning), state machines and run phase, event bus, policies (authorizer, command classifier, tool lists, describe helpers), process runner and command-line tokenizer, agent runtime (translation, executable resolution, env sanitization, `ClaudeSdkRuntime` policy gate, fake runtime), context builder and prompts, renderer logic (bridge, push handling, live store, status, formatting, settings form, mission composer, auth summary, v0.2 view logic), and the v0.2 pure modules: graph proposals (`task-graph/proposals.test.ts`), routing rules and performance aggregation (`routing/`), finding dedupe and arbitration (`review/dedupe.test.ts`), planning heuristics, repository-intelligence parsers and fact selection, the context engine |
| Integration | `tests/integration/**/*.test.ts` | `pnpm test:integration` | Real SQLite files and real temporary Git repositories: `git/` (GitService and WorktreeManager), `persistence/` (migrations including `v0-2.test.ts`, repositories, FTS memory), `profile/` (project profiler), `intelligence/` (repository analysis and refresh on real files and Git), `ipc/` |
| Scenarios | `tests/scenarios/**/*.test.ts` | `pnpm test:integration` (same vitest project) | The whole orchestrator, real database, real Git, `FakeAgentRuntime` |
| Stress | `tests/stress/orchestrator-stress.test.ts` | `pnpm stress` | Seeded random runs with injected faults and invariant checks (not part of `pnpm test` or CI) |
| E2E (Electron UI) | Playwright, `pnpm test:e2e` | Builds the app, then `playwright test` | The UI in a real Electron window with the scripted runtime |
| Smoke (manual) | `tests/smoke/claude.smoke.ts` | `pnpm smoke:claude` | The real Claude runtime |

`vitest.config.ts` defines two projects: `unit` (`tests/unit/**`) and `integration`
(`tests/integration/**` and `tests/scenarios/**`, 30 second test and hook timeouts). `pnpm test` runs both.

```powershell
pnpm test                         # unit + integration + scenarios
pnpm test:unit
pnpm test:integration
pnpm exec vitest run tests/scenarios/repair.test.ts      # one file
pnpm typecheck                    # tsc for tsconfig.node.json and tsconfig.web.json
pnpm lint
```

Integration and scenario tests create temporary directories and Git repositories (`git init`) and need
Git on the PATH. They do not touch your repositories or your NEXUS data directory.

## FakeAgentRuntime

`src/main/modules/agent-runtime/fake-runtime.ts`. A script is an async function given the
`SessionSpec` and a context; it decides what the "agent" does. Because the fake goes through the real
`spec.authorize` and `spec.requestApproval`, a scripted `Write` is checked by the real policy engine, and a
denied call yields `tool.denied` exactly as with the SDK. See AGENT_RUNTIME.md for the API.

Useful helpers:

- `scriptsByRole({ planner, worker, reviewer, verifier, ... }, fallback)` and `completeWith({ text,
  structuredOutput })`.
- `ctx.rateLimit(...)` to simulate quota, `ctx.fail(...)` to crash a session, `ctx.sleep(ms)` to stall one
  (it wakes on stop).
- `runtime.sessions` holds every `SessionSpec` the orchestrator started, so tests assert on the prompt a
  reviewer received, the tools a role had, or the resume id used.

## Scenario harness

`tests/scenarios/harness.ts`, `createHarness({ script, settings? })`:

- Creates a temp directory with a Git repository on branch `main` (`README.md`, `shared.txt`, one commit),
  a real `nexus.db`, a real `GitService` and `WorktreeManager` rooted in the temp directory, and a
  `FakeAgentRuntime`.
- Builds a real `Orchestrator` (plan approval is off by default; settings can be overridden) and records
  every event emitted on the bus.
- `waitForState(runId, states)`, `waitFor(predicate, what)`, `startRun`, `task(runId, key)` and a
  failure-diagnosing timeout message that lists task states.
- `restart(script, { crash })` closes the app and opens a new one on the same database and repository.
  With `crash: true` it reopens a copy of the database taken while agents were live, simulating a hard kill.
- Builders: `plan`, `plannedTask`, `approvedReview`, `rejectedReview`, `finding`, `passedVerification`,
  `failedVerification`, `fileWorker` (writes `<task key>.txt` through the policy-checked `Write` tool),
  `scenarioScript` (planner, worker, reviewer, verifier scripts in one), `keyOf`, `sessionsOf`, `git`.

## Scenarios

Each file is one `describe`. The tests in them:

| File | Tests |
|---|---|
| `happy-path.test.ts` | Plan, two parallel workers, a dependant, review, verification, merges; reviewer prompt contains the diff and not the worker's transcript |
| `scheduling.test.ts` | Dependent task starts in a worktree that already contains its dependencies' merged work; overlapping `suggestedFiles` are serialized while a disjoint task runs alongside; a genuine merge conflict goes to repair and never leaves the integration worktree mid-merge |
| `planning.test.ts` | Invalid plans (several defect kinds) rejected and repaired on the next planner attempt; failure after three invalid plans creates no tasks; planner without structured output retried then fails the run; plan approval waits and `approvePlan` starts; denying the plan cancels the run; `replan` with feedback; a `requiresApproval` task waits for its own approval; denying a task approval cancels only that task; AUDIT rejects writing roles and runs without worktrees; AUDIT rejects a user-added writing task; ASK runs one read-only session with no planner, worktree or branch |
| `repair.test.ts` | Reviewer finding repaired by a debugger; verifier failure repaired; repair loop bounded by `maxIterations`; failing check command repaired and stored with command, exit code and output; mission verification failure creates `mission-fix-*` tasks bounded by `maxIterations`; mission repair stops and pauses for intervention |
| `retries.test.ts` | Crash retried with escalation on the second failure; give up after `maxRetriesPerTask`, pause, then `retryTask` + resume finishes |
| `intervention.test.ts` | Cancelling a task stops its agent, blocks dependants and leaves independent work running; cancelling a run stops sessions and starts nothing more; pause and resume continue the interrupted task without redoing completed ones; stopping an agent fails its task |
| `recovery.test.ts` | Crash mid-run pauses for recovery, stale agents stopped, resume completes; clean shutdown resumes with the previous session id; recovery `cancel`; recovery `inspect` |
| `git-safety.test.ts` | A dirty user working tree survives a full run byte for byte and the work lives only on `nexus/*` branches; BUILD is rejected outside a Git repository while ASK works |
| `dynamic-graph.test.ts` (v0.2) | A worker adds a missing prerequisite, yields and resumes in a worktree that contains it; splitting an unstarted task and the proposer's own task; a cycle is rejected with the reason; revisions, proposals, added tasks and dependencies survive a restart (clean and crash) and the run completes; REPLAN waits for approval and is re-validated; a denial rejects with the user's note; a proposal that became invalid while waiting is rejected at approval time; an approved cancellation stops the other agent; malformed input, terminal targets and the per-agent limit leave the graph untouched; every user change writes a revision; repository facts refresh at run creation, verified decisions become facts, a failing refresh never blocks the run |
| `v2-consensus.test.ts` (v0.2) | Three planners, one invalid candidate, critic, synthesis, execution; an invalid synthesis is repaired with its errors; one valid candidate is used directly; no valid candidate falls back to the single planner; a v0.1 config plans with one planner and records no candidates; pausing during planning leaves no orphan sessions and resuming plans again |
| `v2-routing.test.ts` (v0.2) | A worker failing twice is promoted and the routing decision says why; a HIGH finding routes the repair to the strongest policy; a medium finding does not escalate |
| `v2-outcomes.test.ts` (v0.2) | Exact outcome row for a first-pass task and `performance.summary` with its sample size; a review rejection plus repair is not first pass; a failed task is recorded and a retry updates the same row; measured performance changes routing only from the minimum sample size |
| `v2-context.test.ts` (v0.2) | A fact whose supporting file changed is marked stale and leaves the next pack; packs record why each source was included or excluded and the prompt holds only included ones; repair and resume prompts are packs; every working session has a pack |
| `v2-review.test.ts` (v0.2) | Two concurrent reviewers, duplicates merged, the arbiter rejects a hallucinated finding and accepts a real one; all findings rejected means approval; no significant findings means no arbiter; an arbiter without a valid decision fails safe; review mode selection (v0.1 config, `auto`, `standard`, `dual`) |
| `v2-evidence.test.ts` (v0.2) | The verifier prompt carries the persisted message so a messaging criterion passes without a repair cycle; the reviewer gets message subjects but no worker reasoning; the mission verifier and repair prompts carry the evidence; a dependant's verifier sees the message it received; a subject with a newline and a fake record renders as one sanitized, bounded line, and decision bodies and reasons are never shown |
| `v2-demo.test.ts` (v0.2) | The fake-runtime demo script completes with the repair of `ui` and the plan revision proposed by the `api` worker; a consensus plus dual-review demo run completes |
| `audit-fixes.test.ts` (v0.2) | Graph approvals outlive the proposer (approve, deny, run cancel; tool approvals still expire with their agent); a writing proposal is applied in a mission run; run-wide applied-proposal and task limits force approval; the per-proposer limit is keyed on the task; rewiring or reprioritising another agent's task needs approval; a task cancelled while waiting for the merge lock is not merged; a running task with unmet prerequisites is queued, not relaunched, after pause and resume and after a restart; a prerequisite that completed before the proposer's turn ended still yields; a task added just before the run would complete is verified first; an ASK run paused during the facts refresh resumes without planning again; a user-added task gets the planner rule's kind |

## E2E with `NEXUS_FAKE_RUNTIME`

`pnpm test:e2e` runs `electron-vite build && playwright test`. For UI tests the main process supports two
environment variables (`src/main/index.ts`):

- `NEXUS_FAKE_RUNTIME=1` replaces the Claude runtime with `FakeAgentRuntime` running `createDemoScript()`
  (a three-task plan: `api`, `ui`, then `integration`; the first review of `ui` requests changes so the
  repair loop appears in the UI). It is honoured only when the app is not packaged, and uses no Claude
  usage.
- `NEXUS_DATA_DIR=<dir>` moves Electron's `userData` (database, worktrees, Chromium profile) to a
  throwaway directory.

The suite lives in `tests/e2e/` (`playwright.config.ts`, single worker):

- `mission.spec.ts` (extended for v0.2) opens a temporary Git repository through the real Open Project button (the native
  folder dialog is stubbed in the main process), creates a BUILD mission, checks the plan panel,
  approves, watches the task graph reach completion including the `ui-fix1` repair node, inspects the
  review, agent output, task diff and timeline, and verifies with plain `git` that the integration
  branch has the files while the working tree does not. It also asserts the renderer has no `require`
  or `process`, that `window.nexus` exposes only `invoke` and `onPush`, and that an unknown IPC channel
  is rejected. The demo script's `api` worker proposes a `docs` task, so the same test covers v0.2: `graph.revisions`
  returns versions 1 and 2, the header shows plan version 2, the graph marks the revised task, the Plan inspector lists
  two revisions and an `ADD_TASK` proposal, `routing.list` has one decision per agent, `context.packs` for a task has
  entries that all carry a reason, and the Performance view (a table with an insufficient-sample badge) and the
  Intelligence view (at least one fact) render from durable data. Screenshots are taken of the plan inspector, the
  performance view and the intelligence view.
- `restart.spec.ts` closes and relaunches the app on the same data directory: a run awaiting plan
  approval survives, and a run interrupted mid-execution shows the recovery dialog and resumes.

Manual acceptance runs with the real Claude runtime are described under Real-mission scripts below; they consume Claude usage.

## Stress campaign

`pnpm stress` runs `vitest run -c vitest.stress.config.ts` (only `tests/stress/**`, a 6 hour test timeout) on
`tests/stress/orchestrator-stress.test.ts`. It uses the scenario harness: scripted agents, real Git, real SQLite, no Claude
usage. Settings come from environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `NEXUS_STRESS_RUNS` | 20 | Number of seeds |
| `NEXUS_STRESS_START` | 1 | First seed (seeds are consecutive) |
| `NEXUS_STRESS_CONCURRENCY` | 4 | Seeds run at once |

```powershell
$env:NEXUS_STRESS_RUNS = 1000; $env:NEXUS_STRESS_START = 1; pnpm stress
```

**What a seed varies** (`buildScenario`, a seeded PRNG; session delays are hashed from the seed and a label so timings do not
depend on scheduling order): a DAG of 3 to 6 tasks with random dependencies; tasks sharing files (serialization); some tasks
marked not parallelizable; 1 to 4 parallel agents; per task a worker crash on its first attempt, a rejected first review, a
failed first verification, and an `interface_change` message to downstream tasks; a pause and resume after N task starts;
cancelling one task as it starts; per task a graph proposal of one of eight kinds (`add_blocking`, `add_free`, `add_many`,
`split_unstarted`, `split_self`, which are valid, and `cycle`, `ghost`, `terminal`, which must be rejected); consensus planning
(with one invalid candidate in about half of those runs); dual review for every task; and the user's answer to each graph
approval (approve with probability 0.7, else deny). The v0.2 draws come last, so the pre-v0.2 injections of a seed are
unchanged.

**Invariants checked against durable state** (`checkInvariants`):

- Graph history: revision versions are 1..n without gaps; every applied proposal has exactly one revision and a rejected one
  has a reason and no revision; no proposal is left `proposed` (or `awaiting_approval` unless the run paused); `graph.revised`
  events equal the revisions; the final graph is acyclic; a task cancelled by a proposal is explained by an applied revision
  and produced no review, verification, merge or completion afterwards.
- Outcome: without an effective cancellation the run completes and every live task completes; otherwise everything the
  cancellation did not take down completes. Every pause is explained.
- Ordering: every start of a task (a yielded task starts twice) is preceded by the completion of every dependency the latest
  revision gave it, and no task ran with a cancelled dependency. A completed task has a passing final verification and a
  merge; no terminal task holds a lease.
- Faults were absorbed: injected crashes were retried, rejected reviews created repair tasks, failed verifications left a repair
  child or a second verification, dual reviews that rejected were arbitrated, messages were persisted.
- v0.2 records: every agent has exactly one routing decision that agrees with it; every working session has a context pack;
  packs have at most 30 excluded entries and a reason on every entry; consensus runs left three candidates (one invalid when
  injected) and exactly one `planning.synthesized`, single planning left none; arbitration artifacts belong to a review row and
  only occur with dual review.
- Safety: no active agents remain; the user's HEAD did not move and the working tree is clean; the integration branch holds
  every completed task's file, and its worktree is clean and not mid-merge. A seed that does not settle within 120 seconds is a failure.

**Replaying a failing seed.** A failing seed writes `test-results/stress-failures/seed-<n>.json` (problems, the scenario, the
proposals the workers submitted with the tool's answers, revisions, proposals, run, tasks, dependencies, agents, worktrees,
pending approvals and the whole event history). Replay it with
`NEXUS_STRESS_START=<n> NEXUS_STRESS_RUNS=1 pnpm stress`.

**Coverage assertions.** With `NEXUS_STRESS_RUNS` of 200 or more the test also fails unless every proposal kind and every fault
class was actually exercised: the eight proposal kinds, and `crash`, `rejected_review`, `verify_fail`, `message`, `pause`,
`cancel`, `consensus`, `bad_candidate` and `dual_review`. The campaign prints the tally of proposals and the answer each got.

## Real-mission scripts

These start the app, drive it through the IPC bridge with the **real Claude runtime**, and **consume Claude usage**. They are
never part of `pnpm test`, CI or `pnpm stress`. Each creates a disposable Git repository and data directory, approves low-risk
tool requests and denies the rest, and writes JSON evidence to
`docs/acceptance/`. Without an argument they launch the dev build (`pnpm build` first).

| Script | What it exercises |
|---|---|
| `node scripts/acceptance-mission.mjs [path-to-NEXUS.exe]` | The original acceptance mission |
| `node scripts/adversarial-mission.mjs [path-to-NEXUS.exe]` | Four tasks, a dependant of several, fast-tier workers, a restart mid-run; default planning and review modes |
| `node scripts/v02-acceptance-mission.mjs [path-to-NEXUS.exe]` | The same mission with `planningMode: consensus` and `reviewMode: dual`, and a repository convention that needs a task nobody planned, so a graph proposal, routing decisions, repository facts in a context pack, review and verification can be observed; also restarts mid-run |

## Manual real-SDK smoke test

```powershell
pnpm smoke:claude
```

Runs `tests/smoke/claude.smoke.ts` through `vitest.smoke.config.ts` (5 minute test timeout) against the real
Claude runtime using your current login. **It consumes Claude usage.** It is never part of `pnpm test` or CI.
It checks: account info is reported and `authenticated`; a read-only session reads a temporary
`package.json` and reports its package name (with `session.started`, a successful turn and
`session.ended: completed`); and a request to write a file is denied by policy (or the model, which has no
Write tool, cannot attempt it). It never prints the account email. Use it after changing the adapter, after
upgrading the SDK, or to confirm your login works.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests, on `windows-latest`, Node 24,
pnpm 12.8.1:

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm test` (unit, integration and scenarios, with the fake runtime only)
5. `pnpm build`

CI does not run `pnpm test:e2e`, `pnpm smoke:claude` or `pnpm package`.

## Conventions

- New scenario tests reuse the harness and `FakeAgentRuntime`; do not add network or Claude calls.
- Assert on durable state (rows, events, Git branches) rather than timing; use `waitForState` and
  `waitFor`.
- Dispose harnesses in `afterEach` (it stops sessions, closes the database and removes the temp directory,
  retrying on Windows file locks).
