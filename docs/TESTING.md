# Testing

Automated tests never call the real Claude API. Every test that needs an agent uses
`FakeAgentRuntime`. The only code path that talks to Claude from the test tooling is the manual smoke test.

## Layers

| Layer | Location | Runs with | What it covers |
|---|---|---|---|
| Unit | `tests/unit/**/*.test.ts` | `pnpm test:unit` | Pure logic and adapters with seams: task graph and plan validation, scheduler (`selectRunnable`, file overlap, leases, retry planning), state machines and run phase, event bus, policies (authorizer, command classifier, tool lists, describe helpers), process runner and command-line tokenizer, agent runtime (translation, executable resolution, env sanitization, `ClaudeSdkRuntime` policy gate, fake runtime), context builder and prompts, and renderer logic (bridge, push handling, live store, status, formatting, settings form, mission composer, auth summary) |
| Integration | `tests/integration/**/*.test.ts` | `pnpm test:integration` | Real SQLite files and real temporary Git repositories: `git/` (GitService and WorktreeManager), `persistence/` (migrations, repositories, FTS memory), `profile/` (project profiler) |
| Scenarios | `tests/scenarios/**/*.test.ts` | `pnpm test:integration` (same vitest project) | The whole orchestrator, real database, real Git, `FakeAgentRuntime` |
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

## E2E with `NEXUS_FAKE_RUNTIME`

`pnpm test:e2e` runs `electron-vite build && playwright test`. For UI tests the main process supports two
environment variables (`src/main/index.ts`):

- `NEXUS_FAKE_RUNTIME=1` replaces the Claude runtime with `FakeAgentRuntime` running `createDemoScript()`
  (a three-task plan: `api`, `ui`, then `integration`; the first review of `ui` requests changes so the
  repair loop appears in the UI). It is honoured only when the app is not packaged, and uses no Claude
  usage.
- `NEXUS_DATA_DIR=<dir>` moves Electron's `userData` (database, worktrees, Chromium profile) to a
  throwaway directory.

Status at the time of writing: the `test:e2e` script is defined in `package.json`, but this repository
contains no `playwright.config.ts` and no `tests/e2e` directory yet, so the script has nothing to run.
The renderer's test ids (`data-testid`) and the demo script are in place for such tests.

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
