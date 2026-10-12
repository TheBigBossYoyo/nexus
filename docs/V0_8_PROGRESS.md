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

## Finishing 0.8 (second session, 2026-10-11): audit findings and their state

Four focused independent audits ran on the code of this session. Each finding is listed with its state.
`[x]` fixed with a regression test, `[ ]` open, `[d]` documented as a limit, with the reason.

### A. Git, second round (after the rewrite of "git as the user")

- [x] A2-1 HIGH `--format`/`--pretty`/`--date` without `=` let the next word become an option (`--output=`):
  a long option now takes its value after `=` only. `tests/unit/policies/git-user.test.ts`.
- [x] A2-2 HIGH PowerShell 5.1 re-quotes an argument with `"` in it: a PowerShell command now runs as the
  same bash script; `"`, `\`, empty words and `--%` do not qualify.
- [x] A2-3 HIGH an index forged in the worktree made the user's git read or write outside it: in an ISOLATED
  session the user's git has an index of its own where the sandbox account has no access.
  `tests/integration/git/user-git-script.test.ts`. Trees that step out are refused by git (measured).
- [x] A2-4 HIGH drivers of the machine's git configuration selected by `.gitattributes` (Git LFS download from
  an address in `.lfsconfig`; `astextplain`): `GIT_LFS_SKIP_SMUDGE=1` everywhere, `--no-textconv` and
  `--no-ext-diff` on every comparison. Limit: LFS files stay pointers in NEXUS worktrees.
- [x] A2-5 HIGH NEXUS's own `reset --hard`/`merge` wrote through a junction: links on tracked directories are
  removed first (`unlinkTrackedDirectories`); `tests/integration/git/hostile-index.test.ts`.
- [x] A2-6 MEDIUM `add`/`rm`/`stash` entered a nested repository named in the index: exclude pathspecs
  computed in the script before each; `stash` refused while such an entry exists.
- [x] A2-7 MEDIUM the Codex worker ran its own git on a `.git` pointer it had to believe: the fingerprint is
  now taken by the runtime (`workingState` call).
- [x] A2-8 MEDIUM a git-only command without a recorded Git directory ran unpinned: it no longer qualifies.
- [x] NEXUS's own `add -A` leaves out nested repositories the index names (`leavingOutNestedRepositories`).
- [x] Third review (independent, on the fixes): one HIGH (`git stash -m list` is a push and skipped the guard
  for nested repositories), two MEDIUM (the user's git could move any branch: `checkout -B`, a forged `HEAD`;
  the user-git script had no check for links on tracked directories), LOW (NEXUS's own link removal did not
  cover `clean`, `rm`, `mv`; the account could list desktops). All fixed with tests
  (`tests/unit/policies/git-user.test.ts`, `tests/integration/git/user-git-script.test.ts`).
- [x] Found while fixing it, measured: a label does not keep a file from being replaced. Under ISOLATED the
  account's access to the repository is now "add, never replace" (inherited by directories only).
  `tests/integration/isolation/containment.test.ts` ("it adds and never replaces"). Under RESTRICTED the entry
  stays replaceable by the task's code: a stated limit, which matters for repositories that read per-worktree
  configuration.

### B/C. Windows containment, setup, pipe (no CRITICAL or HIGH)

- [x] W1 MEDIUM a contained command ran on the user's desktop and could read the screen: every contained command
  now runs on a desktop the launcher makes for it. Under ISOLATED the sandbox account is refused the user's
  desktop by name (measured: it could open it through the session's logon identifier, which Windows gives every
  "run as" process). Limit, stated in the UI: RESTRICTED runs as the user and can still open the user's desktop.
  `tests/integration/isolation/containment.test.ts` ("runs on a desktop of its own"), `ui-probe.cs`.
- [x] W2 MEDIUM windowed ISOLATED apps could make desktops: the desktop is made by the launcher's first step
  (the user), and the job keeps its limit on desktops under both profiles.
- [x] W3 MEDIUM handle inheritance: the command inherits its three standard handles only
  (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`). Same test.
- [x] W4 MEDIUM the credential folder is labeled before the setup writes the credential, again after it, and
  at every start whatever the record says.
- [d] W5 MEDIUM, now MEASURED: a name looked up through Windows' resolver is answered for the sandbox account
  (the DNS Client service asks, and the account's firewall rule does not cover a service). Its own traffic,
  including its own DNS packets, is blocked (same test). Not closable with an account and a firewall rule: it
  needs a different containment (AppContainer or a filtering driver). Stated in the UI, the verification text
  and the security model. To decide for the release report.
- [x] W6 the egress check has a positive control (a listener of NEXUS on the loopback must be reached).
- [x] W7 the account that was verified is the one used (no re-reading of the record); the launcher refuses to
  start a process as any other SID, and its second step checks who it is.
- [x] W8 `sweep()` leaves a root that failed verification alone.
- [x] W9 the second-step launcher is re-hashed before use, by NEXUS and by the launcher.
- [x] W10 (first half) the scripts use Windows' own module folder only. Open: scripts in a user-writable folder
  of a per-user install (a same-user process at medium integrity can already do everything the user can).
- [d] W11 LOW setup root check-then-create race: availability only (measured by the audit: the access list is
  not written through a junction).
- [x] W12 a group whose members cannot be listed is a problem, not "no members".
- [d] W13 LOW a machine set up by the first version passes with notes until the setup is run again.
- [x] W14 `pipe-protect` waits for a free instance.
- Residual, found while fixing W1 and stated in the security model: a process started "as another user" carries
  the session's logon identifier, by which it can open named objects of the session that the user's programs
  made with default access. Naming a desktop to Windows removes the identifier, and then the account cannot
  create any named object in the session (Git Bash does not start); measured both ways.
- Checked and correct: the pipe's security descriptor applies to every instance (measured), handshake,
  token file, verification gating of ISOLATED, job and token construction, removal's handling of junctions.

### D/E/F. Network, research browser, application under test, grants

- [x] D1 HIGH `extractHtml` was quadratic on hostile HTML: linear scan, 1 MiB input, tag and depth limits.
  `tests/unit/research/extract-limits.test.ts` (the audit's inputs: 1 to 37 ms, were 6 s to minutes).
- [x] D2 HIGH a page that blocks its thread hung the research browser: 10 s on every read, 30 s on a render,
  the browser killed if it will not close. `tests/integration/research/browser.test.ts`.
- [x] F1 HIGH `ready.pattern` was a regular expression run in the runtime: now literal text with `*`.
  `tests/unit/browser/manifest.test.ts`.
- [x] D3 per render: 300 requests, 50 MB, idle timeouts. `tests/integration/network/proxy-limits.test.ts`.
- [x] D4 WebSockets closed, addresses over 2048 characters refused in the research browser, QUIC off.
- [x] D5 Edge's own background connections are gone (asserted: no connection but the page's).
- [x] D6 title, text and citations are inside the DATA block. `tests/unit/research/envelope.test.ts`.
- [x] D7 the rendered path reads what the page shows (`innerText`).
- [x] F2 every listener on the endpoint's port must be the app's. `tests/integration/browser/port-owner.test.ts`.
- [x] F3 `ready.url` is a loopback address whose port the app owns.
- [x] F4 the pending output line is capped. `tests/unit/process/spawn-long.test.ts`.
- [x] F5 `electron.args` is an allowlist. [x] F6 a screenshot over 8 MiB is deleted and refused.
- [x] E1 "allow once" is bound to a hash of the command itself (not the shortened text; not the agent's own
  description of the call, which changes on a retry). `tests/unit/autonomy/broker.test.ts`.
- [x] E2 (b, c, d) one request per distinct action for capabilities outside every profile, at most 12 per
  capability per mission, a denial final for any action, the project-wide confirmation says "every such action".
  [d] E2 (a): push, network and publish requests still carry the resource "any": the classifier gives no remote
  or host. Stated in `AUTONOMY_MODEL.md`.
- [x] E3 at most 3 restarts of a task by boundary decisions. [x] E4 waiting tasks are found by request id.
- [x] E5 agent text in NEXUS's records is quoted as data. [x] E6 no confirmation channel: project-wide grant
  refused. [x] E7 bidi and control characters stripped.
- [d] D8 LOW loopback v4/v6 equivalence in the policy (the port-ownership check now covers the case).
  [d] D9 LOW a browser profile folder can be left in the temp folder after a hard kill of the runtime.

### Real missions on the final code (2026-10-11/12)

ISOLATED, five missions (`scripts/v08-acceptance.mjs`, steps normal, boundary, resume, render, electron): normal,
boundary, render (a page read through the research browser) and electron (an Electron application installed,
started on its own desktop, operated, screenshot, stopped; nothing asked) passed every gate on the first run.
The resume mission did not, and found two things: the script looked 95 ms too early (NEXUS had resumed the
mission by itself; fixed in the script), and a push that was allowed could not run under ISOLATED (fixed in the
product: "A push you allowed" in `AUTONOMY_MODEL.md`). Evidence of that first run:
`docs/acceptance/v08-acceptance-2026-10-11T23-27-51-749Z.json`.
After the fix the resume mission passed under ISOLATED (the push arrived; a verifier's own attempt to read the
remote's folder became two real outside-project requests that expired with the mission).

RESTRICTED, three missions (normal, boundary, resume). The first run found that no mission could work under
RESTRICTED at all once a project was enrolled: the worktrees lay inside NEXUS's data directory, which is closed
to code at low integrity, and Node is refused when it looks at the directories above its files; and git inside a
longer command could not write its lock file. Fixed: worktrees beside the data directory under RESTRICTED, git's
directories writable for every command of a RESTRICTED session. Second run: 20 gates of 20
(`docs/acceptance/v08-acceptance-2026-10-11T23-51-10-291Z.json`).

Repeating the real missions on each later commit found more, because sessions word their commands differently
every time:

- two false boundaries in one ISOLATED run (`grep -c '\\r'` read as a network path; a .NET write through a
  variable read as a write outside the project): fixed in the classifier and in the mapping to capabilities;
- under RESTRICTED, an allowed push retried inside a longer line of git failed: an allowed push now runs
  wherever it stands in a line of plain git, and a push in a form that can never run is refused with what to
  write, without a question;
- under RESTRICTED, once in three runs, a verifier searched a folder outside the project for the screenshot:
  a real outside-project request, which expired with the mission. The screenshot record now says that the
  image is not a file a session can read;
- once in four ISOLATED runs the Electron mission paused: the work passed its tests and its reviews, and
  verification failed four times. Its records were overwritten by the next run before they were read, so the
  cause is not established. The three other runs passed every gate.

### Fourth review (independent): the push that leaves the containment

On the code that lets an allowed push run as the user. One HIGH, which NEXUS's own review had found and fixed
an hour before and the reviewer measured both ways: a word that is no remote is a path to git, and a push into a
folder of the worktree ran that folder's hooks as the user. Two MEDIUM: forms of `HEAD` and of a refspec let
the entry's `HEAD` file or the line choose another branch; a standing grant covered any destination. LOW: the
script inherited `GIT_*` variables (one of which names a program for git to run: measured), relied on the
inherited PATH, and an option on the list could never be reached. All closed by one narrowing: an allowed push
publishes the task's own branch under its own name to a configured remote, written in full by NEXUS, with a
clean git environment and git by its full path. `tests/unit/policies/git-user.test.ts`,
`tests/integration/git/user-git-script.test.ts` (a real push with a hostile hook, a planted folder, a forged
`HEAD`, a planted configuration and hostile environment variables).

### Independent UX review

Three blockers (the inbox did not say how far each answer reaches; a raw profile name in the reason line; the
setup consent said more than the isolated profile gives) and ten majors: see the release report for what was
changed.

### RESTRICTED: the worktree's git pointer is never trusted

Under RESTRICTED the task can replace the `.git` file of its worktree and change `commondir`, `gitdir` and
`config.worktree` in the worktree's entry. The decision was to accept that only if NEXUS's own git (the user,
uncontained) never trusts any of it. Audit: every git command of NEXUS in a worktree (status, diff, add, commit,
merge, reset, the Codex `workingState`, the orchestrator's and the speculation's calls) goes through
`GitService.run`. For a worktree NEXUS created it already named `--git-dir`, `--work-tree` and `GIT_COMMON_DIR`
itself and refused a planted `config.worktree`; measured again with a pointer to a planted repository (fsmonitor,
filter, diff driver, hooks, `core.sshCommand`): none ran, where stock git ran two. Two things were open and are
closed:

- the pointer and the entry were ignored, not checked: NEXUS carried on silently in a worktree whose git state a
  task had rewritten. Now the `.git` file, `commondir` and `gitdir` are compared with the entry NEXUS found in the
  repository, and a difference refuses the command with a plain message; an entry claimed twice is not trusted.
  The tests of 0.7 that expected NEXUS to carry on (`git-safety.test.ts`) now expect the refusal;
- a speculative candidate is a clone whose `.git/config` the task owns. Measured: a filter in it ran as the user
  under `git status`. Now a command there is refused unless every key of the configuration is one git writes
  into a clone.

Not closed: the scripts NEXUS runs as the user (the allowed push) keep their own check a moment before use, as
before; a clone's configuration is read at each command, so a change between the check and git's start is not
excluded. `tests/integration/git/worktree-pointer-trust.test.ts`.
