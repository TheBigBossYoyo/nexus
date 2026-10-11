# NEXUS 0.8 implementation progress

Status: IN DEVELOPMENT. Branch `nexus-0.8-isolation-autonomy`, from `main` at `ad3cb43` (`v0.7.2`). Nothing is
merged, tagged or pushed. This file is the record of how the work goes; the newest entry is at the end. The
verdict, when there is one, will be in docs/V0_8_RELEASE_REPORT.md.

Theme: autonomous Windows engineering sandbox. Four pillars: Windows execution isolation; autonomy by capability
grants instead of per-action approvals; safe Internet research and app or browser interaction; reliability,
fault injection and long runs. No new intelligence feature, no 0.9 release engineering.

## Rules for the work

- Nothing is pushed. A merge and a tag only on PASS.
- Scratch, probes and anything that looks like an attack go under `test-results/` inside the checkout, never
  `%TEMP%` (the antivirus excludes the project folder only). Nobody changes antivirus settings.
- No window on the user's screen: automated launches use `NEXUS_WINDOW_OFFSCREEN=1`; browsers run headless.
- Heavy suites one at a time. No timeout or assertion is relaxed to pass.
- Real providers only for bounded acceptance; duration and reliability are measured with the fake provider.
  No separately billed API call.
- The version becomes `0.8.0` before the final validation, not after.

## Decisions so far

1. **A project that is not enrolled keeps the approvals of 0.7.** Enrollment with a profile is the switch to
   capability grants. This keeps every existing test's meaning and makes the new behaviour something the user
   chose once per project.
2. **Grants are scoped to a project** (the spec's "workspace" is an enrolled project; a NEXUS Workspace is a
   set of projects, each enrolled on its own). Scopes: ONCE, MISSION (a run), PROJECT.
3. **One question per need per mission.** The dedupe key is project, mission, capability and normalized
   resource; a PROJECT grant also answers every other pending request it covers. A denial holds for the
   mission and is not asked again.
4. **A boundary need does not block the agent.** The tool call is refused with the request's id and the agent
   is told to go on with what does not depend on it. The request waits in the inbox.
5. **Three kinds of capability:** PROFILE (a profile can pre-authorize it inside the project's boundary),
   BOUNDARY (needs a grant), NEVER (no grant exists: provider secrets, the NEXUS runtime, the user's browser
   profile, the security policy, security software, power).
6. **Browser backend: Playwright called directly** by a trusted NEXUS process, behind NEXUS's own small tool
   set. No MCP and no CLI dependency in 0.8 (docs/BROWSER_AUTOMATION_RESEARCH.md has the evidence).
7. **Network policy is enforced by a NEXUS-owned filtering proxy** that resolves names itself, checks the
   resolved address and connects to it, and re-checks every redirect.

## Phase log

### Phase 1: preflight and triage (2026-10-11)

`main` and the annotated tag `v0.7.2` at `ad3cb43`; release source `be46477` is an ancestor; tree clean; branch
created. Triage in docs/V0_8_DEFERRED_FINDINGS_TRIAGE.md. Absorbed: 6.8 (narrowed), 13.5 (recovery pairs),
the VerifierCapabilityContract as RoleCapabilityContract, LOW 2.1/2.2, R.11, 5.7, 7.4/7.6.

### Phases 2 to 4: research (2026-10-11)

- docs/BROWSER_AUTOMATION_RESEARCH.md: versions, measured snapshot sizes and latencies, the comparison.
- docs/CLAUDE_WEB_TOOLS_RESEARCH.md: what the Max-backed Agent SDK route offers; the SDK's
  `spawnClaudeCodeProcess` hook and the `PostToolUse` `updatedToolOutput` hook exist in 0.3.288.
- docs/UNTRUSTED_CONTENT_SECURITY.md: threat classes, authority ordering, design rules, the corpus.
- docs/WINDOWS_ISOLATION_RESEARCH.md: in progress (probes on this machine).

### Phase 6: CapabilityBroker and AutonomyProfile (2026-10-11)

`src/shared/autonomy.ts` (the capability table, profiles, grant, boundary request, broker decision, audit
event), `src/main/modules/autonomy/` (`broker.ts`, `resource.ts`, `role-contract.ts`), migration 17 and
`persistence/repositories/autonomy.ts`. Tests: `tests/unit/autonomy/broker.test.ts` (27),
`tests/integration/persistence/autonomy.test.ts` (8). Not yet wired into the authorizer.

### Phases 6 and 7 continued: the broker in the running system (2026-10-11)

- `policies/authorizer.ts`: with `autonomy` in its context (an enrolled project) a call the policy would ask
  about, or refuse where a grant could cover it, is decided by the broker. The classifier now returns its
  findings one by one; `autonomy/tool-capabilities.ts` reads each as a capability. A boundary finding (push,
  publish, a write outside the roots, a machine change) is a BOUNDARY capability whatever contains the process;
  a finding that only says "cannot be inspected" is project execution when the session is contained and
  UNCONTAINED_EXECUTION when it is not.
- `autonomy/gate.ts`, `autonomy/service.ts`, `ipc/v8-handlers.ts` (`autonomy.*` channels), the push message
  `autonomy`, the notification kind `boundary_request`. Enrolling and "always allow for this project" are
  confirmed natively by the runtime; "once" and "for this mission" are answered in the window.
- Tests: the whole 0.7 corpus through an enrolled authorizer (never `ask`, nothing forbidden allowed, nothing
  allowed lost), `tests/scenarios/v8-autonomy.test.ts` (a three-task mission: 0 approvals, 0 boundary requests;
  nine pushes by three tasks: 1 request, the rest of the work completes; a mission grant given mid-run).
- **`contained` is false in the runtime today**: no launcher exists yet. Until it does, an enrolled project
  turns uninspectable execution into a boundary request, which is the honest state and not the product goal.

### UI (2026-10-11)

`views/autonomy/` (boundary inbox drawer, Settings, Autonomy; pure model with unit tests), the count in the
global status, the autonomy line on the project page. Built by a subagent to the design system; typecheck, lint
and renderer unit tests pass. NOT YET RENDERED: no end-to-end or accessibility run has seen these views.

### Phases 11 and 13: environment and network (2026-10-11)

- `process/contained-env.ts`: an allowlist environment for contained processes; sentinel tests.
- `network/address.ts`, `policy.ts`, `guard.ts`, `fetch.ts`, `proxy.ts`: address classes (the tables of
  docs/UNTRUSTED_CONTENT_SECURITY.md 4.4), the URL check and the connect check, a GET-only fetch that pins the
  resolved address and re-checks each redirect, and a credentialed loopback proxy that does the same for a
  browser. Tests: `tests/unit/network`, `tests/integration/network` (redirects to the local host, the LAN, the
  metadata address and `file:`; rebinding; encoded addresses; a name that answers differently the second time).
  Not yet used by anything: the research provider and the browser sessions come next.

### Windows isolation: first probe round (2026-10-11)

docs/WINDOWS_ISOLATION_RESEARCH.md. On this machine, without administrator rights: a job object (kill on close,
no breakaway) and a write-restricted token with per-directory ACEs work with node, npm, pnpm, git, python and
both provider CLIs, and stop writes, registry writes, process escape and access to a pipe with a user-only
DACL. They do NOT stop reads of the user profile, and nothing found so far stops the network. Both are release
gates. A second probe round is running on two candidates: a token whose user SID is deny-only with the sandbox
root outside the profile (reads), and job network rate control (network). The only compiler on the machine is
the in-box .NET Framework `csc.exe`; the launcher will be a C# executable. A probe put an error dialog on the
user's screen (a .NET target that could not start under a restricted token); launchers now set the error mode.

### Decisions of the user (2026-10-11)

Asked after the third probe round, because no mechanism without administrator rights blocks the network, the
credential vault, DPAPI or reads of unlabeled files for code running as the user:

1. **Yes to an admin-once sandbox account**, built into 0.8 and set up on this machine (one elevation prompt,
   announced first). `node scripts/sandbox-setup.mjs`; `--remove` undoes it.
2. **Folders that may be labeled no-read-up on this machine: credentials and NEXUS data only.** Not browser
   profiles, not Documents, Desktop or Downloads.

### Phases 8 to 12: execution broker, job, token, roots (2026-10-11)

- `native/nexus-launch/nexus-launch.cs`, built by the C# compiler that ships with Windows
  (`scripts/build-launcher.mjs`, part of `pnpm build`): job object, a privilege-free low-integrity token,
  suspended start, fail closed; integrity labels (`low`, `medium`, `protect`, `clear`); the sandbox account's
  credential as a DPAPI blob; and the two-step start as the sandbox account.
- `native/sandbox-setup/`: the elevated setup and removal. Set up on this machine on 2026-10-11: account
  `NexusSandbox`, firewall rules in both directions, root under ProgramData. The first attempt failed before
  changing anything (an account description may have 48 characters).
- `src/main/modules/isolation/`: `launcher.ts` (specs, labels, verification by running), `execution-broker.ts`
  (profiles, session roots, environment, shells, git hardening, project commands), `sandbox-account.ts`,
  `tools.ts` (copies of tools and of Git's MSYS runtime for contained code), `session-containment.ts`,
  `service.ts` (profile per project, protected labels, status).
- Profiles named for what they are: **ISOLATED** is the sandbox account; **RESTRICTED** is the user at low
  integrity; **STANDARD** is none. Setting `execution.containment`, default `STRONGEST`.
- Wired: the authorizer hands an allowed shell command to the tool as its contained launch (`updatedInput`);
  NEXUS's own setup and check commands go through the broker; `contained` in the capability gate is true only
  when the profile was verified at this start; worktrees move to the sandbox root when the effective profile is
  ISOLATED; a dependency proxy with the registry policy is given to contained code.
- Found on the way: Windows does not nest a job under one with UI limits (the inner step makes none); the MSYS
  runtime of the user's Git cannot be used at low integrity (a private copy has its own kernel object name);
  a deny-only user token breaks Node's piped child processes (so RESTRICTED keeps the user SID and relies on
  integrity); job network rate control throttles nothing.
- Tests: `tests/integration/isolation/containment.test.ts` (22, against Windows, both profiles),
  `tests/scenarios/v8-containment.test.ts` (4: a mission whose commands really run through the launcher),
  `tests/unit/process/contained-env.test.ts`.
- NOT YET VERIFIED: a real Claude session with wrapped commands; the application under test as the sandbox
  account; `pnpm install` through the proxy under ISOLATED; the tool copies for anything but Node; existing
  paused runs across a change of the worktrees root.

### Research and its tools (2026-10-11)

`src/main/modules/research/` (extraction of visible text, screening, sources and their authority, artifacts and
memory, budgets, quarantine, the provider, the tools), migration 18, `agent-runtime/extension-tools.ts` (a
generic channel for tool groups through the worker protocol). Search backend: an HTML results page
(`NEXUS_HTML_SEARCH`), not yet run against the real web. Context Graph nodes for artifacts: not built.

### Documents

docs/V0_8_SECURITY_MODEL.md, docs/AUTONOMY_MODEL.md.

### Applications under test and the browser (2026-10-11)

- `src/main/modules/browser/`: `provider.ts` (Playwright direct, `playwright-core` 1.63.0 pinned, Edge headless,
  profile per session, proxy with the loopback bypass removed), `manifest.ts`, `app-manager.ts`
  (`ApplicationUnderTestManager`, the endpoint registry), `tools.ts` (the `app` group; `combineExtensions`).
- The launcher has a `desktop` key: a desktop made for the command, labeled low. An Electron application is
  started on it, attached to over its debugging endpoint (`connectOverCDP`), never through Playwright's own
  Electron launcher (its loader lives in NEXUS's node_modules, which the sandbox account cannot read).
- Measured: Electron 44 ends at once (0x80000003) when started at low integrity in a job with Chromium's own
  sandbox on; with `--no-sandbox` it runs, under both profiles. Recorded in `APP_BROWSER_AUTOMATION.md`.
- `ExecutionBroker.containProgram` (long-running programs), `counters()`; `spawn-process.ts` (a second process
  runner, on the list of `tests/unit/power/isolation.test.ts`).
- The sandbox account's launcher copy is named by its content (`bin/nexus-launch-<sha16>.exe`): two builds, or
  two test processes, no longer replace a file the other is running. A failure to place it is now reported as
  what it is, not as "not set up".
- `IsolationService.protect` is called when a project is enrolled and at start if one is. NEXUS's data is
  always marked; the user's credential stores only when the host says so (`protectUserStores`: a packaged
  build, or `NEXUS_PROTECT_USER_STORES=1`), so that no test changes a folder of the person running it.
- IPC: `isolation.status|setup|apps|appScreenshot`, `research.list`; `sandbox-setup.ts` (the setup from the
  window: native confirmation, then one UAC prompt). The setup from the window has NOT been run: the account
  on this machine was made by the script.
- UI (subagent, not rendered yet): `IsolationPanel`, `AppSessionsPanel`, `ResearchPanel`, `isolationModel.ts`.
- Tests: `tests/integration/browser/app-web.test.ts` (14), `app-electron.test.ts` (10), both profiles;
  `tests/scenarios/v8-app.test.ts` (2). Full suite before this work: 210 files, 4,384 tests, green.

### Real acceptance (2026-10-11)

- `scripts/v08-acceptance.mjs`: two bounded missions with real Claude sessions in an enrolled disposable
  project under `test-results/v08/accept/`. Evidence in `docs/acceptance/v08-acceptance-*.json`.
- A confirmation is shown by the RUNTIME process (`askNatively`), not by the window: a stub in the window does
  not answer it. The first attempt put the enrollment dialog on the user's screen. Since then a development
  build with `NEXUS_ACCEPT_CONFIRM=window` puts confirmations to the (off-screen) window; a package never does.
- `runs.create` needs `compilationMode: 'EXACT'` from a script (otherwise the 0.7.2 admission asks for a preview).

### What the real acceptance found (2026-10-11, runs 2 and 3; evidence in `docs/acceptance/`)

Worked with real sessions under ISOLATED, first time: commands of the Bash and PowerShell tools handed over as
contained launches (the `updatedInput` rewrite holds in the real SDK), `npm test` as the sandbox account,
`research_read` on nodejs.org into an artifact, `app_launch` / `app_find` / `app_act` / `app_snapshot` /
`app_screenshot` / `app_stop` by worker and verifier, NEXUS's own check commands contained, no tool approval,
nothing on the remote. Both missions nevertheless ended paused. Causes, each fixed and tested:

1. git under ISOLATED. A command that was more than git ran as the sandbox account and found no repository.
   Now: the account is granted read on the project's `.git`, create-only on objects, modify on its own worktree
   entry and its mission's refs (`ExecutionBroker.grantGit`, `revokeGit`, `revokeGitExcept`; record in
   `<sandboxDir>/git-grants.json`); git alone, or git with text filters (`policies/git-pipeline.ts`), runs as
   the user at low integrity; a ref-changing git inside a larger command is stopped with a sentence
   (`bashGitGuard`). MEASURED AND REJECTED: commits as the sandbox account (git stats every directory above
   the repository; a junction is resolved by git; rights on the user's own folders are not given).
   `tests/scenarios/v8-isolated-git.test.ts`; the harness takes `containment.profile: 'ISOLATED'`.
2. `error: Unable to create '.../packed-refs.lock'` after every contained commit: git deletes `AUTO_MERGE`
   (traced). Harmless, read as failure by sessions. The line is filtered (`BASH_GIT_QUIET_LOCK`).
3. `diff.external=''` in the hardening made `git diff` die. Removed; `gc.auto=0`, `maintenance.auto=false`
   and, for the sandbox account, `safe.directory=*` added.
4. `cat .git` (the worktree's pointer file) and `[IO.File]::AppendAllText("$PWD\\x", text)` were boundary
   requests. Classifier corrected; `tests/unit/policies/v8-classifier.test.ts`.
5. Verifiers failed tasks for lack of evidence held by NEXUS: that a screenshot was taken, that a push was
   refused. Now artifacts of the task (and of the task it repairs): kinds `app-evidence`, `boundary-request`;
   `app_status` reports launches and screenshots of the task.
6. Found while reading: NEXUS's own git read `commondir` from a worktree entry that contained code may write.
   It now sets `GIT_COMMON_DIR` itself.
7. `npm.ps1` looked for a newer npm in the user's profile: `npm_config_prefix` is the session's.

Not fixed, noted: reviewer and verifier roles are refused `git reflog`, `git branch -vv`, `od` by the 0.7 role
policy; `npm ci` as setup fails in a project without a lock file (exit 1, as before 0.8).

### End of the 0.8 session (2026-10-11): PARTIAL

Verdict, gates and what PASS still needs: `V0_8_RELEASE_REPORT.md`. Not merged, not tagged, version 0.7.2.
Independent security review: 10 findings, in `V0_8_SECURITY_MODEL.md`. Acceptance run 8 passed every gate on
the final code. Full suite 220 files, 4,461 tests. New-UI e2e 5 of 5, a11y 2 of 2. Soak passed. An unpacked
package builds with the launcher, the setup scripts and the browser driver in it; it was not started.

## Next

See "To reach PASS" in `V0_8_RELEASE_REPORT.md`.
