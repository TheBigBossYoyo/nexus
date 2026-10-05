# NEXUS 0.6.0 Release Report

Date: 2026-10-05 (built and validated 2026-10-05 02:40 to 06:45, +01:00). Branch `nexus-0.6`, 0.6.0 in
`package.json`. Released by the unattended overnight release train the user authorized: merged into
`main` with `--no-ff` and tagged `v0.6.0`.

## Verdict

**PASS**, with the items under "Not verified" and the open findings stated.

**0.6.0 also carries security fixes for defects that are in every earlier release (see "Security hardening").**

The 0.6 gate was: the provider abstraction, Claude preserved, provider discovery, policy integration, usage
integration, fallback, the cross-provider architecture, tests, E2E, package and an audit. A real session with a
second provider was allowed to stay unverified; it did not have to, because the Codex command line tool is
installed and signed in on this computer.

## What 0.6 is

0.6 removes the assumption that an agent is Claude. Claude stays required and first-class.

| Area | What exists |
|---|---|
| Provider abstraction | `AgentRuntimeProvider` (discovery, a runtime, a default model, a usage report, a test session); `ClaudeAgentRuntimeProvider` wraps the Claude SDK runtime unchanged |
| Router | `ProviderService.router` is itself an `AgentRuntime`: the orchestrator, the Arena, programs and workspaces start sessions as before. The decision is a pure function, `routeSession` |
| Codex | `CodexRuntimeProvider` and `CodexCliRuntime` drive `codex exec --json` with the login that tool has. Read-only: reviewer, researcher and critic roles only |
| Gemini | Detected only; it cannot be enabled |
| Discovery | Version and sign-in state from each provider's own tool, found on PATH only. No credential is read and no prompt is sent |
| Provider policy | Off by default. Enabling a provider routes nothing by itself; cross-model review and heterogeneous speculation are separate switches; fallback to Claude with the reason recorded, or refusal |
| Records | `provider_sessions` (migration 008): who was asked, who ran it, the model, the tool version, why, how it ended, tokens |
| Usage | Per provider, as that provider states it. Another provider's events never move Claude's usage status or pause a run |
| Evidence | Mission outcomes and Arena trials record `provider:model`, so evidence is not pooled across providers |
| UI | Providers page; the provider and model of every agent in the mission inspector |

Documents: `PROVIDERS.md`, README "What's new in 0.6".

## Test results

Commit under test: `bf0f782`. The commit that carries this report adds documents and evidence only.

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | 139 files, 2650 tests passed, 423 s |
| `pnpm stress` with `NEXUS_STRESS_RUNS=1000` | 8 files passed in one run, 4901 s, on `b7afbcf`: 1000 orchestrator seeds and 1000 histories each of the other stresses. See the note |
| `pnpm test:e2e` | 24 of 24 passed (1 capture-only test skipped by design), 6.5 min, on the final commit |
| `pnpm package` | pass |
| Packaged build on real 0.1, 0.2.0 and 0.2.1 databases | pass, 20 of 20 checks on each |

Note on the stress run. It ran in a second checkout on `b7afbcf`, before the security hardening, the evaluator
fix and the overnight bookkeeping fix. After the hardening of NEXUS's git calls the orchestrator stress was run
again for 100 seeds (passed), and both overnight stresses for 5000 histories after the bookkeeping fix (passed).
The full 1000-seed run was not repeated on the final commit.

Three things failed during the validation of 0.6 and were dealt with, none by loosening a check:

- The timing-based hidden evaluator of the Arena case `performance-optimization` failed the reference solution
  in two full runs under machine load (and once earlier in the night). A measurement can only be made slower
  by load, so the evaluator now measures up to four times before it fails and keeps the best time of each size;
  a quadratic solution still fails. The case is version 3.
- One E2E test compared the failsafe with the first agent session without waiting for that session to exist.
  It now waits for it and then compares.
- Packaged validation opened a scratch project before it looked for the old run in the sidebar, which lists the
  missions of the current project. The step was moved before the project is opened. The failed run's evidence
  file is kept beside the passing one.

Tests new in 0.6:

- `tests/integration/providers/providers.test.ts`: the routing decision (default, cross-model review, a
  disabled provider, every reason for fallback and refusal, heterogeneous speculation, resume); tool resolution
  (PATH only, never the working directory) and command lines; the Codex runtime against a scripted process
  (events, resume, errors that are never usage limits, structured output, the read-only check failing closed);
  discovery of each provider; the service with scripted Claude, Codex and Gemini providers (Claude-only
  operation, enabling, cross-model review, outage and recovery, authentication required, heterogeneous
  speculation, resume, test cooldown, usage isolation); migration 008.
- `tests/unit/renderer/providers-model.test.ts`: every sentence of the Providers page.
- `tests/e2e/v6.spec.ts`: the Providers page, enabling Codex and cross-model review through the UI, a mission
  whose reviews are done by the scripted Codex, a provider that needs authentication.
- `tests/integration/policy/service.test.ts`: `provider:model` in mission outcomes.

## Real runtime

| Item | Result | Evidence |
|---|---|---|
| Claude provider still passes a real mission | **Proven.** Planner (Opus), worker (Sonnet) and verifier (Opus) sessions on Claude; the repository's tests pass on the integration branch (7, from 2); the user's checkout untouched | `provider-mission-*.json` |
| A real heterogeneous review | **Proven, twice** (before and after the security hardening; 14 of 14 gates each, first attempt). In the same mission the review was done by a real Codex session (`gpt-5.5`, tool 0.130.0, ChatGPT login), read-only; it approved with no finding and said that it could not rerun the tests because its sandbox refused `npm` and `node`; Claude then verified. 14 of 14 gates, first attempt | `provider-mission-*.json` |
| Codex read-only review that finds a defect | **Proven.** `pnpm smoke:providers`: a commit with a real defect (an average that divides by zero for an empty list); verdict `request_changes` naming the defect; its attempt to write a file refused by the Codex sandbox; the working directory fingerprint unchanged; a file named `codex.cmd` planted in the repository did not run | `providers-smoke-*.json` |
| Usage isolation | **Proven in the real mission.** 4 Claude sessions and 1 Codex session; the Codex session's 120k input tokens appear under Codex only; no Claude limit event | same |
| Heterogeneous speculation with a real second provider | **NOT AVAILABLE.** Codex is read-only in NEXUS and cannot write a candidate. The path is tested with scripted providers only | |
| Gemini | **NOT VERIFIED.** Not installed on this computer; detected only by design | |
| Fallback with a real provider failing | **NOT VERIFIED** for real; covered with scripted providers | |

## Audit

One independent read-only security and correctness audit of 0.6, and one independent UI review of the
Providers page.

| Severity | Found | State |
|---|---|---|
| Critical | 0 | |
| High (code) | 1 | fixed |
| Medium (code) | 4 | 4 fixed |
| Low (code) | 7 | 4 fixed, 3 not fixed |
| UI review (Providers) | 3 high, 11 medium, 2 low | 3 high and 5 medium fixed |

- **High, fixed:** the Codex tool was started by name through `cmd.exe` in the task's worktree, and `cmd.exe`
  looks in the current directory first. A file named `codex.cmd` in a repository or written by a confined agent
  would have run, unconfined, when a Codex review started. Now the tool is found on PATH only (never the working
  directory, never a relative PATH entry, never a path inside the working directory), started by its absolute
  path through the system's `cmd.exe`, with `NoDefaultCurrentDirectoryInExePath` set. Tested with a planted
  file, in the unit tests and in the real smoke run.
- **Medium, fixed:** the read-only fingerprint failed open when it could not be taken and a retry passed on the
  changed state (now it fails closed and the directory gets no further Codex session); Codex inherited the
  environment with the Claude credentials (now the environment NEXUS gives every project command); Arena trials
  recorded the Claude model of the routing decision for a Codex agent (now `provider:model`); the line the tool
  prints about its login was stored (now only the kind of login).
- **Low, fixed:** a session id that could look like an option; a session of a provider the user had switched
  off could be resumed there; unlimited test sessions; a structured answer that is not an object.
- **Low, not fixed:** a Codex failure in the middle of a review fails that review, and up to two tasks, before
  Claude takes over (fallback is decided when a session starts); an `error` event of Codex beside a completed
  turn counts as a failure; rows of test sessions are never deleted.
- **UI review, high, fixed:** "Test" ran a real session with a provider the page said nothing was sent to (now
  offered only for an enabled provider, with a visible note); the enable switch did not say what is sent (now:
  code and diffs, under the user's sign-in and quota, and that Codex never changes files); "another provider
  reviews independently" hid that Claude reviews instead when the provider cannot be used (now said).
- **UI review, medium, fixed:** switches without an accessible name (the shared `Toggle` now names itself by its
  label); the three-column grid at 1024 px; routing selects that filled the row; an overview error that left
  "Detecting providers" on screen with no retry; the scripted Codex claimed it may change files.
- **UI review, not fixed:** a failed policy save is shown at the top of the page, away from the switch; the
  enable switch sits below the capability table; plan usage is shown without the provenance label the design
  system asks for; the test result stays until the page is left; changing the reviewer switches the use off
  without saying so; the provider column of the mission inspector truncates.

## Security hardening

An adversarial review of the application's boundaries, made for the 1.0 readiness question on the 0.7 code,
found defects that are not about providers and are in every release so far. They were fixed here, on the 0.6
line, each with a test that fails without the fix. `v0.3.0`, `v0.4.0` and `v0.5.0` do not contain these fixes.

| Finding | Since | Fix |
|---|---|---|
| An agent's shell could rewrite a task worktree's `.git` pointer file; NEXUS's next commit, reset or clean then acted on the user's repository or another task's worktree | 0.1 | Before any git command that changes something, the pointer is checked against Git's own back-pointer; any command but git that names a `.git` path asks first |
| `git config` behind a value option (`--type bool core.fsmonitor ...`) passed the classifier; the configured program then ran inside NEXUS's own git calls, with NEXUS's environment | 0.2.1 | Every word is checked as a possible key; NEXUS's git runs with no hooks, no file system monitor, no pager, no `ext` transport, and without the withheld credentials |

Open, and not fixable in the classifier: a writing agent can write a script and run it, and the script is not
inspected. `SECURITY.md` states what follows from that, and lists the six MEDIUM findings of the same review
that are open.

Also on this line: a failsafe lost to a restart of Windows within a minute of arming is now recorded as lost
(a bookkeeping defect since 0.3.0, found by the 5000-history overnight stresses).

## Packaged build

| | |
|---|---|
| Installer | `release/NEXUS-Setup-0.6.0.exe`, 207,358,553 bytes, built 2026-10-05 06:39 from `bf0f782` |
| SHA-256 | `eb1a885599cfb2d6b0de44b196ca3304ab2502fd52c58d0f86fdb591de4e65ba` |
| Installed launch, uninstall | **NOT VERIFIED.** The installer was not executed |

`release/win-unpacked/NEXUS.exe` on real databases of 0.1, 0.2.0 and 0.2.1: launches as packaged 0.6.0, schema
upgraded to 8 with no row lost and a backup copy kept, the old run readable and open in Mission Control, every
page renders including Workspaces and Providers, the real providers are detected (Claude among them) and
nothing but Claude is enabled. 20 of 20 checks each (`packaged-validation-2026-10-05T05-40-21-221Z.json`).

## Not verified

- The real mission with a Codex review ran on the development build, not on the packaged build.
- Codex's read-only sandbox is Codex's. NEXUS observed it refuse writes in three real sessions on this computer
  (Windows, tool 0.130.0); it did not test other versions or platforms.
- A real Codex outage, a real fallback, and a Codex usage limit.
- Installer execution, as in every release so far.

## Known limitations

- Codex is read-only in NEXUS: no implementation by Codex and no heterogeneous speculation with it.
- A Codex agent is outside the NEXUS permission policy and has no NEXUS agent tools. It can read what the user
  can read, and what it reads can reach its provider.
- The read-only fingerprint cannot see edits inside untracked files, files ignored by Git, anything outside the
  working directory, or Git metadata other than HEAD.
- NEXUS does not choose a provider from evidence; routing is by the settings only.
- The default Codex model is a fixed name (`gpt-5.5`); another can be set through `providers.setPolicy` only.
- Gemini is detected and nothing more.

## Evidence

- Commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm stress` (`NEXUS_STRESS_RUNS=1000`), `pnpm test:e2e`,
  `pnpm package`, `node scripts/packaged-validation.mjs`, `node scripts/provider-acceptance.mjs`,
  `pnpm smoke:providers`.
- Committed evidence: `docs/acceptance/provider-mission-*.json`, `providers-smoke-*.json`,
  `packaged-validation-*.json`.
- The log of the night: `docs/OVERNIGHT_0_3_TO_1_0_READINESS.md`.
