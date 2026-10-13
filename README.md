# NEXUS

NEXUS is a Windows desktop application that coordinates several independent Claude agent sessions over one Git
repository. You describe a goal. A planner agent turns it into a task graph, NEXUS schedules the tasks in
parallel (each writing task in its own Git worktree), and every task goes through automated checks, an
independent review and an independent verification before it is merged into a per-run integration branch. You
merge that branch into your own branch yourself.

Orchestration (scheduling, state machines, retries, merging, recovery) is ordinary application code backed by a
SQLite database. Claude is used for planning, engineering work, review and verification. NEXUS never writes to
your working tree.

It is for one developer who runs long engineering work on a Windows 11 machine, wants it to go on unattended
(for example overnight), and wants agents that run project code to be contained by the operating system and not
only by a reading of their commands. It is not a hosted service, it has no server, and it is not a general
agent framework.

## Release state

The version in `package.json` is **0.9.0**. The latest tagged release is **0.9.0** (`v0.9.0`, 2026-10-13).

**0.9.0 is PARTIAL against the gates its own brief set, and was released on the owner's decision.** It is
validated by the test suite (5,182 tests), the end-to-end tests (41 passed, 1 failed once and passed alone, 3
skipped) and a package that was built and started. The installer was not run; there was no soak, no crash
campaign, no Arena campaign, no real Program, Workspace or unattended night on this source, and no independent
UX review; ten MEDIUM findings of the security review are open; and the operational-autonomy features were
proven with simulated networks and transports only. It is not called PASS and it is not production-ready. What
was and was not done: [V0_9_RELEASE_REPORT](docs/V0_9_RELEASE_REPORT.md). What stands between this and a 1.0
release candidate (eight blockers): [1_0_READINESS](docs/1_0_READINESS.md).

Nothing is signed (see [Code signing](#code-signing)). There is no update channel.

## Requirements

| Requirement | Notes |
|---|---|
| Windows 11 x64 | The only supported and packaged platform. CI runs on `windows-latest`. |
| Git for Windows | Needed for worktrees. Developed against Git 2.53. |
| A Claude subscription, and Claude Code logged in | Agents are `claude.exe` processes started by the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.288). Run `claude auth login` once. See [Authentication](#authentication). |
| Microsoft Edge | Used headless by the application and browser automation (`app_*` tools). Every Windows 11 has it; NEXUS looks for it in `Program Files`. |
| Node.js 24 and pnpm 12.8.1 | Only to build from source. They match Electron 44.5.1 and the CI configuration (`.github/workflows/ci.yml`). A packaged install needs neither. |
| Node.js 20 or newer on `PATH` | Needed only by the Arena: its built-in cases run `node --test`. NEXUS ships no Node. |
| A ChatGPT plan (optional) | Only for the Strategic Director and the ChatGPT side of the Council and of TECHNICAL and COUNCIL task compilation. Nothing is sent to OpenAI until you switch sending on. See [PROVIDERS](docs/PROVIDERS.md). |
| One administrator approval (optional) | Only for the one-time setup of the ISOLATED execution profile (below). |

No C++ build tools are needed: `better-sqlite3` ships a prebuilt N-API binary, the Claude binary comes from the
Agent SDK's Windows package, and the launcher (`native/nexus-launch`) is compiled with the C# compiler that
ships with Windows.

## Build, run, test and package

```powershell
git clone <this repository> Nexus
cd Nexus
pnpm install
pnpm dev          # development app with hot reload
```

| Command | Result |
|---|---|
| `pnpm build` | Builds the launcher, then bundles main, preload and renderer into `out/`. |
| `pnpm start` | Runs the built bundle (`electron-vite preview`). Run `pnpm build` first. |
| `pnpm typecheck`, `pnpm lint` | TypeScript for both projects; ESLint. |
| `pnpm test` | Unit, integration and scenario tests (Vitest). Uses `FakeAgentRuntime`; never calls the real Claude API. |
| `pnpm test:unit`, `pnpm test:integration` | One project each. Integration also runs the Arena cases and the isolation tests, which start real contained processes. |
| `pnpm test:e2e` | Builds, then Playwright drives the built Electron application. |
| `pnpm stress` | Seeded orchestration stress campaign with scripted agents (no Claude usage). Not part of `pnpm test` or CI. |
| `pnpm package` | Builds, then electron-builder produces the NSIS installer for Windows x64 in `release/`. |

The installer is `release/NEXUS-Setup-<version>.exe` (a per-user install; the location can be chosen). The
unit and integration suites are described in [TESTING](docs/TESTING.md); the manual smoke tests and the
real-Claude acceptance scripts are in "Scripts" at the end of this file.

### The release folder

After `pnpm package`, `node scripts/release-artifacts.mjs release` lays out `release/v<version>/` from the commit
being built. It refuses a tree that is not clean unless `--allow-dirty` is given (the manifest then says so). The
folder contains:

- the installer and its block map;
- `build-manifest.json`: commit, version, hashes of the lock file and of the native binaries with their
  sources, database schema, runtime protocol, setup version, toolchain, signing state;
- `sbom.cdx.json`: a CycloneDX bill of materials of the production dependencies, Electron, busybox-w32 and the
  launcher;
- `THIRD_PARTY_NOTICES.md` and `licenses/`;
- `source/`: the complete source of busybox-w32 at the shipped commit (see [Third-party software](#third-party-software-and-licensing));
- `SHA256SUMS` over all of it, read back and checked after it is written.

A release folder was built once for 0.9.0; a second build for comparison was not made. The installer
(install, upgrade, uninstall, reinstall) has not been run.

## Execution profiles

For a project you enroll, everything an agent runs, and everything NEXUS runs for it (project scripts, tests,
dependency installs, the application under test), is started by one program, `nexus-launch.exe`, inside a job
object and under a restricted token. The reading of commands (policy, command classifier) still exists; it
decides which capability a command needs and is no longer what keeps the command in. The profile is chosen in
Settings. A project that is not enrolled is not contained and behaves as in 0.7.

| Profile | What it is | What it is not |
|---|---|---|
| ISOLATED | Runs as a dedicated local sandbox account, in an AppContainer, at low integrity, with the Windows firewall blocking the account and its traffic going only through NEXUS's filtering proxy on the loopback. It cannot read the user's profile or credentials. Since 0.9 each session also holds a capability of its own and its project a capability of its own: a session cannot write another session's worktree, temporary directory or home, cannot end its processes, and another project's package cache is out of reach (`tests/integration/isolation/cross-session.test.ts`). The shell inside it is busybox ash, not Git's bash. | Not complete: a session can still read another session's worktree (open in the ledger) (see the security model, "What is not contained"). |
| RESTRICTED | Runs as you, at low integrity, in a job object, writing only to directories NEXUS labeled. Needs no setup. | **Not a containment against hostile code.** Existing objects of the repository can be overwritten by code that runs as the user. Prefer ISOLATED for unattended work. |
| STANDARD | Runs as you, at medium integrity, no job object. | No containment. |

The default is `STRONGEST`: ISOLATED when the sandbox account is set up and was verified at this start,
otherwise RESTRICTED. It never means STANDARD. There is no fallback: a profile that was asked for and cannot be
made runs nothing. NEXUS verifies the profile at every start by running a contained command and checking what
it could and could not do.

### One-time sandbox setup and its removal

ISOLATED needs a one-time setup that raises **one administrator (UAC) prompt**. It creates the sandbox account,
its folder under `ProgramData`, firewall rules, a Windows profile for the account, access entries on `C:\` and
`C:\ProgramData`, a loopback exemption, an entry for the AppContainer on the Mount Manager device and a startup
task (`NexusSandbox-RestoreCanonicalization`) that restores that entry. The account's password is generated by the
script, stored as a DPAPI blob under `%LOCALAPPDATA%\NexusSandbox` and never printed.

```powershell
node scripts/sandbox-setup.mjs              # create or repair (build first: it needs out/native/nexus-launch.exe)
node scripts/sandbox-setup.mjs --status     # say what is recorded, change nothing
node scripts/sandbox-setup.mjs --remove     # take all of it away (add --remove-root to delete the sandbox root too)
```

(`pnpm sandbox:setup` runs the first form.) The packaged application carries the same scripts under
`resources/sandbox-setup`. Open finding in the ledger: the elevated scripts compile and write in the user's
temporary folder, and the removal script has a recursion finding (W2-F12); both are listed as open. Details and
every step: [V0_8_SECURITY_MODEL](docs/V0_8_SECURITY_MODEL.md).

## What NEXUS does

| Feature | What it does |
|---|---|
| Missions | One goal becomes a validated task graph, scheduled in parallel under a preset (ECO, BALANCED, MAXIMUM) and a strategy (`ADAPTIVE`, `SINGLE`, `BUILD`, `SWARM`, `CONSENSUS`, `SPECULATIVE`). Each task is implemented, checked, reviewed and verified; the result is an integration branch you merge yourself. See the sections below. |
| Programs | A goal pursued across many missions: a plan of at most 12 milestones, verification of each, replanning, backlog and memory, waiting out usage limits. The result stays on a program branch. [PROGRAMS](docs/PROGRAMS.md) |
| Workspaces | Several related repositories enrolled as a set, with an organization graph, contracts and cross-repository missions. NEXUS never publishes. [WORKSPACES](docs/WORKSPACES.md) |
| Director and Council | A Strategic Director (ChatGPT) and a Technical Director (Claude) and a Council of both give advice. They never act: nothing a Director writes can start work, change a policy or grant a permission. [PROVIDERS](docs/PROVIDERS.md), [V0_7_2_RELEASE_REPORT](docs/V0_7_2_RELEASE_REPORT.md) |
| Task Compiler | Admits every request as a specification before work starts and gives it the least depth that is enough: EXACT, LIGHT, STANDARD, TECHNICAL or COUNCIL, with AUTO as the composer's default. [PROVIDERS](docs/PROVIDERS.md) |
| Context Graph | One index over repository facts, project, program and workspace memory and contracts, with typed relations, trust and freshness. Context Engine V3 is on by default. [CONTEXT_GRAPH](docs/CONTEXT_GRAPH.md) |
| Token Intelligence | Accounting of every model request, cache reads and writes, and every context decision with its reason. [TOKEN_INTELLIGENCE](docs/TOKEN_INTELLIGENCE.md) |
| Provider capacity and quota recovery | Capacity admission for every agent session; a usage limit pauses the work, and it resumes by itself after the reset the runtime reported or after a probe. NEXUS never invents remaining quota. [QUOTA_RECOVERY](docs/QUOTA_RECOVERY.md), [USAGE_INTELLIGENCE](docs/USAGE_INTELLIGENCE.md) |
| Overnight | An unattended mission with a deadline and an end-of-run power action you authorize (shut down, sleep, hibernate or none), with a Windows shutdown timer as failsafe. The real power action has never been exercised on a night. [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md) |
| Arena | The same task under different strategies in controlled trials, scored by a hidden evaluator, with a documented ranking. No Arena campaign has been run on 0.9.0. [ARENA](docs/ARENA.md) |
| Autonomy profiles and boundary requests | You enroll a project with a profile (Autonomous project, Balanced, Locked down). What the profile covers runs without a question; what it does not cover becomes one deduplicated boundary request that waits for you while other work goes on, and the mission resumes by itself when it is granted. Granting for a whole project or a whole mission asks for a native Windows confirmation. [AUTONOMY_MODEL](docs/AUTONOMY_MODEL.md) |
| App and browser automation | Eight `app_*` tools let an agent start the project's application inside the containment, read its accessibility tree, operate it, take screenshots and read its console and network, through Playwright and Edge. [APP_BROWSER_AUTOMATION](docs/APP_BROWSER_AUTOMATION.md) |
| Internet research | Four `research_*` tools search and read the public web through NEXUS, not through a socket of the agent. Pages are data, never instructions; results are screened, attributed and held to a budget per registrable domain; a URL that looks like data being sent out is refused. [INTERNET_RESEARCH](docs/INTERNET_RESEARCH.md) |
| Providers | Claude is required. Codex can be enabled as a read-only reviewer; Gemini is detected only. Nothing is sent to a provider you have not enabled. [PROVIDERS](docs/PROVIDERS.md) |

### Operational autonomy (0.9.0)

Three things built at the end of 0.9.0. Each is in the application and covered by tests with simulated
networks and transports; none has been proven on a real outage, a real long mission or a real messaging
service yet. The release report says exactly what was and was not shown.

- **Progress and time remaining.** The mission page shows a percentage by expected work (not by count of
  tasks), the stage, the elapsed time, and the active work that remains as a range with a confidence and its
  reason. It is computed from the task graph and from how long tasks of the same kind took before on this
  machine; no model is asked for a number. Work added by verification lowers the percentage and says so; time
  spent waiting (for the network, the provider, a boundary decision, you) is kept apart from active time.
  Refreshed when something happens and every five minutes otherwise.
- **Network resilience.** A mission whose provider cannot be reached waits and is resumed when the network is
  back; it is not failed. The Wi-Fi profile that was in use is reconnected through the Windows WLAN API, by
  name, with no question; never a network that is not saved, never an open one, never a key. Windows is kept
  from idle sleep while a mission works or will resume by itself. Outages are recorded with their facts.
  [NETWORK_RESILIENCE](docs/NETWORK_RESILIENCE.md)
- **Director Line.** Off until you turn it on. You pair one chat (Telegram, by long polling: no port is opened
  on the machine) with a one-time code; from it you can ask for status, time remaining and blockers, pause
  after the current task, continue, and add a task, which is created the way the window creates one. NEXUS
  reports what matters (an end, a failure, a blocker or an outage that lasts), within quiet hours and limits.
  The line grants nothing: a request to push, delete, change a profile or allow a boundary request is refused
  and left for the machine. Telephone voice is designed, with an outbound call implemented and not configured.
  [DIRECTOR_LINE](docs/DIRECTOR_LINE.md)

## Security model in brief

- The boundary for an enrolled project is the operating system (the execution profiles above), not a reading of
  commands. A model, including a Director, the Task Compiler, a planner and a worker, is never part of the
  boundary: all are callers of a capability broker, and none can write a grant, a profile or a policy.
- The target statement: untrusted code may destroy its disposable worktree and its own process tree, but cannot
  modify NEXUS, provider credentials, unrelated repositories, unrelated user data or the runtime. It holds in
  full only for ISOLATED and with the exceptions the security model lists under "What is not contained".
- Limits stated by the documents: RESTRICTED is no containment against hostile code; sessions can read each
  other's worktrees; Git run as the user on the repository is not yet protected by an object store of the
  task's own; loopback services other than NEXUS's proxy can be reached from ISOLATED; busybox ash has no bash
  arrays and a git inside a longer command is refused; programs with a libuv older than 1.53 of their own hang on
  a child with a pipe inside ISOLATED; the sandbox's copy of `node.exe` is changed by NEXUS in one place.
- The window and the runtime talk over a Windows named pipe with a token only your user can read; nothing listens
  on a TCP port. A program that runs as you and reads that file can do what the window can.
- A second independent review of the 0.8.0 source found 1 CRITICAL, 3 HIGH, 16 MEDIUM and about 25 LOW findings.
  The CRITICAL and the HIGH findings are fixed with tests. **Open review findings, including ten MEDIUM, are
  listed in the ledger**, [V0_9_HARDENING_LEDGER](docs/V0_9_HARDENING_LEDGER.md), section E. There was no final
  review after the fixes, and the launcher was read, not attacked, by the second party.

Read [V0_8_SECURITY_MODEL](docs/V0_8_SECURITY_MODEL.md) before relying on any of this. The older
[SECURITY](docs/SECURITY.md) describes the policy layer of 0.7.

## Third-party software and licensing

- **NEXUS's own code is under the Apache License, version 2.0** ([LICENSE](LICENSE)). The programs it ships
  beside itself keep their own licenses, as said below.
- **busybox-w32 is GPL-2.0.** `vendor/busybox/busybox.exe` (build FRP-6075-g169694ebd, unmodified) is the POSIX
  shell of the ISOLATED profile. NEXUS starts it as a separate program and links nothing of it. Using it on your
  own machine asks nothing of you. Giving a copy of NEXUS that contains it to anybody else asks for its source
  (GPL-2.0, section 3(a)): the complete source of the shipped commit is in `vendor/busybox/source/`, the release
  folder puts it in `release/v<version>/source/` beside the installer with the license text in `licenses/`, and
  whoever passes on the installer passes on that folder with it. A build whose release folder lacks the archive
  is for the machine it was built on, and the build stops on a binary that is not the one on record. This is the
  author's reading of the license, not legal advice. See [vendor/busybox/README.md](vendor/busybox/README.md).
- **Electron and Chromium** are shipped inside the installer under their own licenses, together with the other
  production dependencies. `THIRD_PARTY_NOTICES.md` and the CycloneDX bill of materials in the release folder
  are generated from the lock file and the installed packages, not written by hand.
- `claude.exe` comes from Anthropic's Agent SDK package and keeps Anthropic's signature and terms.

## Code signing

Nothing is signed. The installer, `NEXUS.exe`, `nexus-launch.exe`, `busybox.exe` and the setup scripts are
unsigned and no code-signing certificate is owned. This blocks public distribution, not a local release. On
another machine an unsigned installer meets SmartScreen ("Windows protected your PC") and, where Smart App
Control enforces, may be blocked. The pipeline for signing and for checking signatures
(`scripts/verify-signatures.mjs`) is ready and tested with a changed byte, but has never been exercised with a
real certificate. What can be obtained and why: [CODE_SIGNING](docs/CODE_SIGNING.md).

## Known limitations and what blocks 1.0

[1_0_READINESS](docs/1_0_READINESS.md) says NOT READY for a 1.0 release candidate and names eight blockers, none
of them new architecture:

1. The installer lifecycle was never run (clean install, upgrade from 0.8.0, uninstall, reinstall, restart).
2. The open MEDIUM findings of the review (ledger, section E).
3. Reading between sessions is open.
4. No long run: a 12-hour soak against fixed limits, and a crash campaign.
5. No measurement of quality on this source (an Arena campaign, with AUTO).
6. No real work on this source: a long Program, a multi-repository Workspace, an unattended night.
7. No final independent review after the fixes, with the launcher attacked and not only read.

A signing certificate, the real power action and the LOW findings are not counted as blockers there. Other
limits you will meet: NEXUS targets Windows 11 x64 only; it does not merge into your branch; memory is a keyword
index, not a vector index; a passing verification means a verifier agent judged the criteria met, not that the
software is correct. The full lists, by version, are under "Current limitations" below.

## Documentation map

| Document | What it is |
|---|---|
| [V0_9_RELEASE_REPORT](docs/V0_9_RELEASE_REPORT.md) | The 0.9.0 report: the PARTIAL verdict, gates, tests, package, operational autonomy, what was left out |
| [V0_9_HARDENING_LEDGER](docs/V0_9_HARDENING_LEDGER.md) | One list of everything open or closed in the hardening, with a disposition and a state for each, including review findings |
| [1_0_READINESS](docs/1_0_READINESS.md) | Category by category readiness for 1.0, and the eight blockers |
| [V0_9_SOAK_THRESHOLDS](docs/V0_9_SOAK_THRESHOLDS.md) | The limits a soak will be judged by, fixed before one is run |
| [V0_9_FLAKES](docs/V0_9_FLAKES.md) | Tests that did not give the same answer twice, and the runs of the suite |
| [CODE_SIGNING](docs/CODE_SIGNING.md) | Signing, SmartScreen and antivirus: the state and the options |
| [V0_8_RELEASE_REPORT](docs/V0_8_RELEASE_REPORT.md) | The 0.8.0 report (PASS): gates, runs, what the owner should know |
| [V0_8_SECURITY_MODEL](docs/V0_8_SECURITY_MODEL.md) | What is and is not contained, profile by profile |
| [AUTONOMY_MODEL](docs/AUTONOMY_MODEL.md) | Profiles, capabilities and boundary requests |
| [APP_BROWSER_AUTOMATION](docs/APP_BROWSER_AUTOMATION.md) | The `app_*` tools and what the application and the browser can reach |
| [INTERNET_RESEARCH](docs/INTERNET_RESEARCH.md) | The `research_*` tools and the treatment of untrusted pages |
| [ARCHITECTURE](docs/ARCHITECTURE.md), [CONTROL_PLANE](docs/CONTROL_PLANE.md) | Process roles, modules, the local protocol, the global queue |
| [ORCHESTRATION](docs/ORCHESTRATION.md), [TASK_LIFECYCLE](docs/TASK_LIFECYCLE.md) | Planning, scheduling, strategies, review, verification |
| [TESTING](docs/TESTING.md) | Test layers, `FakeAgentRuntime`, stress and smoke tests |
| [PROVIDERS](docs/PROVIDERS.md), [AUTHENTICATION](docs/AUTHENTICATION.md) | Providers, what is sent where, sign-in |

The rest of the index is in the sections that follow and in `docs/`.

## Feature history

The sections below describe each version's additions as they were implemented, newest first. They are kept for
detail; where one of them disagrees with the sections above, the sections above and the newest report are later.

## 0.9.0 (part one): hardening and release engineering

What was verified and what was not: [V0_9_RELEASE_REPORT](docs/V0_9_RELEASE_REPORT.md).

- A capability per session and per project under ISOLATED (see "Execution profiles"). The test runs two hostile
  sessions at once and one of another project.
- A speculative candidate's clone can no longer redirect its repository to make NEXUS's own git run a program:
  NEXUS names the clone's Git directory itself and refuses anything in the clone that redirects it (the CRITICAL
  finding of the second review).
- A URL an agent names as a way out is screened, the provider's own web tools are neither offered nor allowed in
  an enrolled project, allowing a boundary request for the whole mission asks for the native confirmation, and a
  launcher spec without an AppContainer is refused.
- Release engineering: the release folder (manifest, bill of materials, notices, checksums, busybox source), the
  check of signatures, the limits of a soak and its analyzer. See "The release folder" above.
- One real restart of Windows was observed: ISOLATED was available by itself 6.6 seconds after launch, with no
  elevation prompt (`docs/acceptance/v09-first-real-reboot-2026-10-13.md`). One restart, not a matrix.
- Not done: reading between sessions, an object store of the task's own for git, the link scan, the Node
  compatibility policy, the open MEDIUM findings, the installer lifecycle. Full list: "Left out by the owner's
  decision" in the report.

## 0.8.0: isolation and autonomy

Report (PASS): [V0_8_RELEASE_REPORT](docs/V0_8_RELEASE_REPORT.md). Design: [V0_8_SECURITY_MODEL](docs/V0_8_SECURITY_MODEL.md),
[AUTONOMY_MODEL](docs/AUTONOMY_MODEL.md).

- The ISOLATED, RESTRICTED and STANDARD execution profiles, the launcher `nexus-launch.exe`, the sandbox account
  and the AppContainer.
- Autonomy profiles (Autonomous project, Balanced, Locked down) and boundary requests: a normal autonomous
  mission interrupted the user 0 times in the real runs of the report.
- Application and browser automation, including an Electron application under test inside the containment
  ([APP_BROWSER_AUTOMATION](docs/APP_BROWSER_AUTOMATION.md)), and internet research
  ([INTERNET_RESEARCH](docs/INTERNET_RESEARCH.md)).
- Costs stated in the report: a POSIX shell (busybox ash) instead of Git's bash inside ISOLATED, no git on the
  user's repository from inside a longer command, a changed copy of `node.exe` for the sandbox, and programs with
  a libuv older than 1.53 of their own that hang on a child with a pipe.

## 0.7.2: Directors, the Task Compiler and capacity admission

0.7.2 adds a sign-in with ChatGPT, a Strategic and a Technical Director and a Council that advise and never act,
a Task Compiler that admits every request as a specification before work starts and gives it the least depth
that is enough for it, capacity admission for every agent session, and the 2.0 interface on every view. What
goes to OpenAI is stated where you connect, nothing is sent until you switch sending on, and a project can be
kept from sending on its own. What was verified, what it costs and what is deferred:
[V0_7_2_RELEASE_REPORT](docs/V0_7_2_RELEASE_REPORT.md); how the depth is chosen and what is sent:
[PROVIDERS](docs/PROVIDERS.md).

## 0.7.1: context, memory and token intelligence

This section describes 0.7.1 as it is implemented. What was measured, what is on by default and what is not
verified is in [V0_7_1_RELEASE_REPORT](docs/V0_7_1_RELEASE_REPORT.md). The research behind it is in
[TOKEN_OPTIMIZATION_RESEARCH](docs/TOKEN_OPTIMIZATION_RESEARCH.md) and
[CONTEXT_GRAPH_RESEARCH](docs/CONTEXT_GRAPH_RESEARCH.md); the measurements of 0.7.0 it started from are in
[V0_7_1_BASELINE](docs/V0_7_1_BASELINE.md).

The rule of this release is quality first: remove wasted tokens, never reasoning. No model, effort level, agent
count or review count changes. A technique is on by default only when it loses no information or was measured
not to lower quality.

| Area | What 0.7.1 adds | Details |
|---|---|---|
| Context Graph | One index over repository facts, project memory, program memory, workspace memory and contracts: a tree to browse, typed relations with evidence, trust and status on every node, freshness from file changes, conflicts, supersession, history, notes. The stores stay the source of truth | [CONTEXT_GRAPH](docs/CONTEXT_GRAPH.md), [MEMORY_ARCHITECTURE](docs/MEMORY_ARCHITECTURE.md) |
| Context view | Intelligence, Context: the tree, search, and a node's text, sources, relations and history | [CONTEXT_GRAPH](docs/CONTEXT_GRAPH.md) |
| Context Engine V3 | The 0.7.0 pack plus a map of the project knowledge, the related nodes from any store, and four tools for agents to read further. On by default since the real campaign of 0.7.1; one setting turns it off | [CONTEXT_ENGINE_V3](docs/CONTEXT_ENGINE_V3.md) |
| Token accounting | Every model request with its cache read and write; what each session's context was made of; every compaction; every context decision with its reason | [TOKEN_INTELLIGENCE](docs/TOKEN_INTELLIGENCE.md) |
| Cache | Measured on the real runtime what is and is not shared between sessions; a local diagnosis of a prefix that was written again | [PROMPT_CACHING](docs/PROMPT_CACHING.md) |
| Check output | A failure that lies before the tail of a long output now reaches the agent that repairs it; the complete output stays stored | [TOKEN_INTELLIGENCE](docs/TOKEN_INTELLIGENCE.md) |
| Usage page | Cache, Context and Context techniques sections; an agent's Context tab answers "why this context" | [USAGE_INTELLIGENCE](docs/USAGE_INTELLIGENCE.md) |
| Quality gate | A paired, case-by-case non-inferiority check that decides whether a technique may become a default | [TOKEN_INTELLIGENCE](docs/TOKEN_INTELLIGENCE.md) |

What the measurements changed. Two techniques this release set out to enable were measured on the real Claude
runtime and found to do nothing, so they are off: keeping the working directory out of the system prompt
(sessions of one role already share the cached prefix across worktrees), and loading the NEXUS tools upfront
(the request is the same size). The cost that does exist is one cold prefix of about 15,000 tokens per role
per cache lifetime, because each role has its own tool list.

The database gains tables (migration 12, additive). A 0.7.0 database upgrades in place; the graph is built
the first time a mission starts or you press Refresh in the Context view.

## 0.7.0: secure control plane

This section describes 0.7.0 as it is implemented. What is tested and what is not verified is
in [V0_7_RELEASE_REPORT](docs/V0_7_RELEASE_REPORT.md). The design is [V0_7_DESIGN](docs/V0_7_DESIGN.md).

Until 0.6 everything NEXUS did lived in one Electron process: the window, the database, the engines and the agent
sessions. Quitting NEXUS stopped the work. 0.7 splits the one executable into three process roles:

| Process | What it is | Details |
|---|---|---|
| Window (`nexus-desktop`) | The user interface. A client: it owns no database and no work, and shows what the runtime tells it | [ARCHITECTURE](docs/ARCHITECTURE.md) |
| Runtime (`nexus-runtime`) | A persistent process without a window. It owns the database, the global queue, the scheduler, schedules, the engines, the overnight supervisor and power control, and the tray icon. The window starts it when none is running | [CONTROL_PLANE](docs/CONTROL_PLANE.md), [GLOBAL_SCHEDULER](docs/GLOBAL_SCHEDULER.md) |
| Workers (`nexus-worker-N`) | One process per agent session, started and watched by the runtime, each under a lease stored in the database. A worker decides nothing: every tool call is sent back to the runtime for the policy decision | [WORKERS](docs/WORKERS.md) |

What this changes for you:

- **Closing the window does not stop any work.** Missions, programs, campaigns, schedules and overnight runs continue in
  the runtime. During an overnight mission the window still asks before it closes (hide, cancel the mission, or return).
- **"Stop NEXUS" stops the runtime**: in the tray icon, or in the Runtime diagnostics of the Control Center. It asks
  first when work is active. Interrupted runs are paused for recovery at the next start, as before
  ([RECOVERY](docs/RECOVERY.md)).
- **The tray icon belongs to the runtime** and exists while the runtime does, with or without a window. Until 0.6 it existed
  only during an overnight run.
- **The runtime stops by itself** after two minutes with no window connected, no run working, nothing on the queue and no
  schedule switched on. It keeps running without a window while a schedule is switched on.
- **Nothing starts the runtime at Windows sign-in.** Schedules fire only while a runtime runs, so after a reboot or a
  sign-out nothing fires until NEXUS has been opened once.
- **The window and the runtime talk over a Windows named pipe**, not over the network: nothing listens on a TCP port.
  Each side proves that it holds a random token kept in a file in the data directory that only your Windows user (and
  SYSTEM and administrators) can read. This protects against other Windows users and against a process that squats the
  pipe name. It does not protect against another program running as you that reads that file: such a program can do
  what the window can ([ARCHITECTURE](docs/ARCHITECTURE.md), "The local protocol").
- **Everything that uses agents is one queue** with priorities, aging so that low-priority work is not kept out for good,
  a dispatch pause, recorded scheduling decisions, durable schedules that fire once per occurrence, and nine health
  components. See [CONTROL_PLANE](docs/CONTROL_PLANE.md), which also lists what does not exist.
- **Execution security** is stricter: scripts, inline interpreter code and package scripts are inspected before an agent
  may run them, and refusals are logged ([SECURITY](docs/SECURITY.md)).

**NEXUS is not a sandbox.** The execution policy classifies and decides what an agent asks to run, including what an
interpreter or a package script would run and who wrote it. That is a policy layer (in 0.7; 0.8 adds operating-system containment, see "Execution profiles"). Code that NEXUS allows to run,
runs as your Windows user, with your permissions; processes of the runtime and of the workers are not isolated from your
files. Operating-system containment is not part of 0.7: see [WINDOWS_EXECUTION_ISOLATION](docs/WINDOWS_EXECUTION_ISOLATION.md)
and [V0_8_PROPOSAL](docs/V0_8_PROPOSAL.md).

## What's new in 0.6

The 0.6 feature set removes the assumption that an agent is Claude. Claude stays required and first-class; other
providers are optional, off until you enable them, and never needed. Released as 0.6.0. Details:
[PROVIDERS](docs/PROVIDERS.md).

| Feature | What it does |
|---|---|
| Provider discovery | NEXUS asks each provider's own command line tool for its version and sign-in state. It reads no credential and sends no prompt to do so |
| Providers page | Status, version, sign-in, models, capabilities, plan usage as the provider reports it, counts of recent sessions, an explicit test session |
| Codex provider | Sessions through `codex exec`, with the login that tool already has. Read-only in 0.6: it reviews, researches and criticises, and changes no file. NEXUS checks afterwards that nothing changed |
| Provider policy | Nothing is sent to a provider you have not enabled, and enabling one routes nothing by itself |
| Cross-model review | Claude implements, another provider reviews independently, Claude verifies. A reviewer's finding is a claim to check, never the verdict |
| Heterogeneous speculation | Candidate B of a speculative task written by another provider. Implemented and tested with scripted providers; not available with Codex, which is read-only |
| Fallback | When the chosen provider cannot be used, Claude does the session and the reason is recorded, or the session is refused if you switched fallback off |
| Evidence | The mission inspector shows the provider and model of every agent; mission outcomes and Arena trials record `provider:model`, so evidence is not pooled across providers |

Statements that hold for the 0.6 feature set:

- With no other provider enabled, every session runs on Claude exactly as before.
- NEXUS never handles another provider's credentials and implements no login for it.
- Usage is shown per provider as that provider states it. Different quota systems are not converted into one
  percentage, and another provider's limits never pause a run for Claude quota.
- Gemini is detected only.

## What's new in 0.5

The 0.5 feature set goes from "change one repository" to "change several related repositories for one goal".
Released as 0.5.0.

| Feature | What it does | Where to read more |
|---|---|---|
| Workspaces | A workspace is a set of related repositories you enroll explicitly. Each stays an ordinary NEXUS project; the workspace adds roles, an organization graph, contracts, a policy, memory about what lies between the repositories, and a decision trail. | [WORKSPACES](docs/WORKSPACES.md) |
| Organization graph | Which repository depends on which. Edges come from the repositories' own manifests (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`), from the consumers of a contract, or from you, and every edge shows where it comes from. A cycle is reported, never ordered. | [WORKSPACES](docs/WORKSPACES.md) |
| Cross-repository missions | One goal, planned by a read-only session into tasks that each change one repository, in dependency order. You approve the plan before anything runs. Each task is an ordinary mission run in its own repository, on its own branch and worktree; your checkouts are not changed. A later task is given what the tasks it depends on reported and the current content of the contracts it uses. | [MULTI_REPO_ORCHESTRATION](docs/MULTI_REPO_ORCHESTRATION.md) |
| Contracts | A contract is a file one repository provides and others consume (OpenAPI as JSON, JSON Schema, TypeScript declarations, Protobuf, SQL `CREATE TABLE`, event schemas). NEXUS reads its surface, keeps versions, and reports a change as `identical`, `compatible`, `breaking` or `unknown`. | [CONTRACTS](docs/CONTRACTS.md) |
| Global verification | When every task is done, each repository's checks, each contract the mission touched and each consumer's copy are verified together. A mission that fails verification is blocked, records no contract version and prepares no release. | [MULTI_REPO_ORCHESTRATION](docs/MULTI_REPO_ORCHESTRATION.md), [CONTRACTS](docs/CONTRACTS.md) |
| Release trains | After a verified mission NEXUS prepares an order and version bumps for releasing the repositories. It never publishes: the policy field `publishing` is fixed to `never`, and the publish channel always refuses and records the request. | [RELEASE_TRAINS](docs/RELEASE_TRAINS.md) |
| Workspace programs | An ordered series of cross-repository missions that you write, one per milestone. Each milestone's tasks start from the results of the earlier milestones in every repository they changed. | [WORKSPACES](docs/WORKSPACES.md) |
| Overnight workspace missions | A cross-repository mission can be an overnight workload under the same supervisor: authorization, deadline and failsafe first, a report, and the end action. A plan that waits for approval ends the night as a blocker. | [MULTI_REPO_ORCHESTRATION](docs/MULTI_REPO_ORCHESTRATION.md), [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md) |

Statements that hold for the 0.5 feature set:

- The application state machine owns the truth. Claude proposes one thing, a cross-repository plan, and it is validated against the workspace before it is stored.
- NEXUS does not publish, push, tag or merge. The result of each task stays on a branch in its repository.
- Only repositories the workspace policy allows are ever worked in.
- Compatibility is judged on the surface NEXUS can read from a contract file. `compatible` means no breaking change was seen in what is read, not that the contract is safe; a file that cannot be read is `unknown`.
- Dependency discovery reads the root manifest of each repository only. Other relationships are declared by you.
- The Workspaces view has no screen for workspace programs and no control to run a workspace mission overnight in this feature set; both are available through the IPC channels.

## What's new in 0.4

0.4 goes from "execute a mission" to "pursue an engineering goal across many missions and milestones".

| Feature | What it does | Where to read more |
|---|---|---|
| Programs | A program has a goal, a plan of at most 12 milestones, and a deterministic engine that plans, generates a mission per milestone, verifies the milestone, records backlog and memory, reassesses the plan and goes on. The accepted work accumulates on a program branch that is never checked out in your working tree. | [PROGRAMS](docs/PROGRAMS.md) |
| Milestone verification | A mission that reports success has not completed its milestone. Deterministic gates run first (mission completed, checks passed, no review requesting changes); then a verifier session judges each acceptance criterion on the evidence. A milestone is never accepted without a judgment. | [PROGRAMS](docs/PROGRAMS.md) |
| Replanning | After a milestone, a rejection or a failed mission the plan is reassessed. A revision can add, split, reorder, change, defer or drop remaining milestones; it is stored with a diff. You can ask for a reassessment yourself. | [PROGRAMS](docs/PROGRAMS.md) |
| Backlog and memory | Verifiers, failed missions and background jobs propose backlog items; proposals never become work by themselves. Validated long-horizon facts are kept as program memory, and a mission receives only the entries relevant to its milestone. | [PROGRAMS](docs/PROGRAMS.md) |
| Long-horizon operation | A usage limit is a wait: the program continues by itself at the reset. Work windows (for example 22:00 to 07:00) bound when a program works. A program can be an overnight workload with an end-of-window power action. | [LONG_HORIZON_AUTONOMY](docs/LONG_HORIZON_AUTONOMY.md) |
| Background engineering | Optional, off by default: read-only analysis jobs (dependency audit, test gaps, dead code and more) whose only output is backlog proposals. | [BACKGROUND_ENGINEERING](docs/BACKGROUND_ENGINEERING.md) |

Statements that hold for 0.4:

- The application state machine owns the truth. Claude proposes plans and judgments; every proposal is validated before it is stored or acted on.
- A program runs one mission at a time.
- The milestone verifier judges from the diff and the recorded evidence; it does not execute the result.
- A program's result stays on its branch. NEXUS does not merge it into your branch.

## What's new in 0.3

| Feature | What it does | Where to read more |
|---|---|---|
| Arena | Runs the same task under different strategies in controlled trials. Each trial has its own fresh Git repository and project; a hidden evaluator scores the finished trial after the agents are gone. Twelve built-in cases ship with NEXUS (they run with the Node.js on your `PATH`, version 20 or newer). Raw metrics are stored and a documented, versioned ranking (`score-v1`) puts correctness first. | [ARENA](docs/ARENA.md), [BENCHMARK_METHODOLOGY](docs/BENCHMARK_METHODOLOGY.md) |
| Adaptive policy | `ADAPTIVE` profiles the task and chooses a strategy from a versioned policy: a default table, an evidence override that exists only after you promote a candidate, and bounded exploration. Every decision stores its reason, its evidence and its seed. Candidates are proposed from stored evidence and never applied by themselves; promotion, rollback and pin are user actions. | [ADAPTIVE_POLICY](docs/ADAPTIVE_POLICY.md) |
| Strategies | `SINGLE`, `BUILD`, `SWARM`, `CONSENSUS`, `SPECULATIVE` and `ADAPTIVE` configure the one orchestration engine. `SINGLE` has no planner: one worker implements the mission. `SPECULATIVE` has two or three independent candidates implement the same task and picks one by objective checks. | [ORCHESTRATION](docs/ORCHESTRATION.md), [SPECULATIVE_EXECUTION](docs/SPECULATIVE_EXECUTION.md) |
| Usage intelligence | Records what NEXUS's own sessions used and what the runtime reports about limits and plan windows, each value with its source and confidence. A percentage is shown only when the runtime supplied it. | [USAGE_INTELLIGENCE](docs/USAGE_INTELLIGENCE.md) |
| Automatic quota resume | A usage limit pauses the mission, closes a dispatch gate, waits for the reset the runtime reported (or probes on a conservative schedule when it reported none), checks availability and resumes the run through the existing resume path. It survives a restart of NEXUS. | [QUOTA_RECOVERY](docs/QUOTA_RECOVERY.md), [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md) |
| Light UI | A new shell: grouped navigation (Workspace, Intelligence, System), a page header with global status, a light theme by default with a dark override, and new Home, Arena, Policy and Usage pages. A quota banner appears on every page while a wait is active. | [ARCHITECTURE](docs/ARCHITECTURE.md) |

Statements that hold for every 0.3 feature:

- NEXUS does not claim universal superiority of any strategy. Arena results describe the cases, models and versions that were run.
- Usage totals may not be exposed by Claude. Observed usage is what NEXUS's own sessions reported; it is not necessarily the account's full subscription usage, because other Claude clients use the same account.
- Quota reset behaviour depends on what the runtime reports. NEXUS never fabricates remaining quota; a percentage is shown only when the runtime supplied it.
- The runtime usage report is an SDK method declared experimental and unstable. NEXUS treats it as optional and falls back to conservative probing.
- Arena evidence is controlled; mission history is observational and weighted lower. Neither is pooled in displayed counts.
- Policy changes only by explicit promotion. Learning never rewrites NEXUS source code.

The design and its deviations from the implementation are in [V0_3_DESIGN](docs/V0_3_DESIGN.md).

## What's new in 0.2.1

| Feature | What it does | Where to read more |
|---|---|---|
| Overnight Mode | An unattended MISSION run with a wall-clock deadline and an end-of-run power action (shut down, sleep, hibernate or none) that you authorize for that run, in the composer and in a native Windows dialog. NEXUS itself performs the action, from deterministic main-process code, after the agents are stopped and the final report is saved. A Windows shutdown timer is armed as a failsafe before any agent starts. | [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md) |
| Power controller | `WindowsPowerController` runs `System32\shutdown.exe` (and Windows PowerShell for sleep) with argument arrays, no shell and fixed messages. Only the overnight supervisor holds it. Agents have no path to it, and power commands in an agent's shell are refused for every role. | [SECURITY](docs/SECURITY.md) |
| Tray and background | Closing the window during an overnight run asks whether to hide to the tray; the mission continues without the window. In 0.2.1 to 0.6 the work lived in the main process and the tray icon existed only while an overnight run was live; since 0.7 (branch `nexus-0.7`) both belong to the runtime process, which exists with or without a window (see 0.7 above). | [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md) |
| Quota waiting | In an overnight run, a usage limit whose reset time falls inside the mission time is waited out (`QUOTA_PAUSED`) and the run resumes by itself; otherwise the run ends as quota exhausted, which is not a failure. (0.3 adds a probe before the resume and probing when the reset time is unknown.) | [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md) |
| Evidence builder | One `TaskEvidenceBuilder` assembles everything reviewers, verifiers and debuggers are told that the repository cannot show: check results, commits, changed files, reviews, repair history, dependency handoffs, graph revisions, messages sent and received, decisions with their text, and the result the agent reported. Agent-written text is quoted and labelled. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Command classes | Shell commands are classified (`SAFE_READ`, `SAFE_PROJECT_WRITE`, `GIT_LOCAL`, `NETWORK`, `SYSTEM_CHANGE`, `DESTRUCTIVE`, `UNKNOWN`). Heredoc commit messages and `cat > file <<'EOF'` inside the worktree no longer need approval; `git config` of keys that can run code, Git redirected outside the worktree, and the NEXUS database are gated or refused. The project's own package scripts count as verification commands for reviewers and verifiers. | [SECURITY](docs/SECURITY.md) |

## What's new in 0.2

| Feature | What it does | Where to read more |
|---|---|---|
| Dynamic task graph | A working agent can call `propose_graph_change` to add a missing prerequisite, split a task, cancel an obsolete one, rewire dependencies, change a priority or replan the open work. Deterministic code validates the proposal (unique keys, no cycles, finished tasks immutable, criteria carried over). Safe changes apply at once, the rest wait for your approval. Every applied change is a numbered graph revision (version 1 is the approved plan) that you can diff. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Consensus planning | Optional planning mode: three planners with different lenses (risk-first, parallelism-first, minimal-change) plan independently, a critic reviews them, a synthesizer writes the final plan, which goes through the normal plan validation. Falls back to the single planner when no candidate is valid. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Adaptive model routing | One router picks the capability tier of every agent session from the role policy, task risk and size, attempt number, repair severity, escalation and measured performance. The requested policy, the resolved model and the reasons are stored per agent and shown in the Agents view. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Empirical performance | When an implementing task reaches a final state, one outcome row is stored. The Performance view aggregates them by role, model and task category with sample counts; a row has to reach 5 samples before it can influence routing. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Repository intelligence | Static, manifest and Git analysis stores facts about the project (languages, modules, commands, imports, test mapping, hot files and more) with source, confidence, supporting files and a freshness fingerprint. Stale facts are excluded from agent context. | [ARCHITECTURE](docs/ARCHITECTURE.md) |
| Context packs with provenance | Every agent session gets a stored context pack that lists each candidate source (task, criteria, dependency results, decisions, repository facts, memory, messages, review findings) with why it was included or left out. The task inspector has a Context tab. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Dual review with an arbiter | Review mode `dual` (or `auto` for high-risk tasks) runs two reviewers with different lenses, merges duplicate findings, and lets an arbiter accept or reject each finding against the code. Only accepted critical or high findings request changes. | [ORCHESTRATION](docs/ORCHESTRATION.md) |
| Orchestration evidence | Verifiers see sanitized records of the messages, decisions and graph proposals of a task (existence, sender, type and time are authoritative; quoted text is not). | [ORCHESTRATION](docs/ORCHESTRATION.md), [SECURITY](docs/SECURITY.md) |
| New views | Performance (Ctrl+6), Intelligence (Ctrl+7), and in the Run view a Plan inspector (candidate plans, critic findings, final plan, graph revisions with a diff, change proposals) plus a revision selector on the task graph. | |

The design and its deviations from the implementation are in [V0_2_DESIGN](docs/V0_2_DESIGN.md).

## Release history and supported versions

The latest tagged release is 0.9.0. Earlier tags are kept as they
are, for history; no tag has been rewritten or deleted. Dates are those of the tagged commit. The recommendation
column is as each release's own report left it; 0.7.x predates the operating-system containment of 0.8 (0.7 is
not a sandbox, see below).

| Version | Tag | Date | Status | Note |
|---|---|---|---|---|
| 0.1, 0.2.0 | none | 2026-10-04 | Not recommended | Never tagged. Both are before the security fixes of 0.6.0; the worktree pointer defect is recorded as present since 0.1 |
| 0.2.1 | `v0.2.1` | 2026-10-04 | Not recommended | Contains both defects fixed in 0.6.0 (see below) |
| 0.3.0 | `v0.3.0` | 2026-10-05 | Not recommended | Contains both defects fixed in 0.6.0 |
| 0.4.0 | `v0.4.0` | 2026-10-05 | Not recommended | Contains both defects fixed in 0.6.0 |
| 0.5.0 | `v0.5.0` | 2026-10-05 | Not recommended | Contains both defects fixed in 0.6.0. The tag also lacks the 0.5.0 entries of `docs/TEST_STATUS.md` and `docs/BUILD_PROGRESS.md` (see below) |
| 0.6.0 | `v0.6.0` | 2026-10-05 | Has known defects | Contains the fixes of 0.6.0. Report: `docs/V0_6_RELEASE_REPORT.md`. The 0.7 review found them incomplete (see below) |
| 0.7.0 | `v0.7.0` | 2026-10-07 | Superseded | Secure control plane; fixes the known defects of 0.6.0 listed below. Report: `docs/V0_7_RELEASE_REPORT.md` |
| 0.7.1 | `v0.7.1` | 2026-10-10 | Superseded | Context Graph and token intelligence. A real campaign of fifty runs over eight task categories found it non-inferior to 0.7.0 with no case worse; with the Context Graph, on by default, missions used 16% fewer turns. It also fixes a defect that blocked real programs in 0.7.0. Report: `docs/V0_7_1_RELEASE_REPORT.md` |
| 0.7.2 | `v0.7.2` | 2026-10-11 | Superseded | Directors, the Task Compiler, capacity admission, the 2.0 interface. In a real campaign against 0.7.1 it was non-inferior when requests are admitted as written; the default depth passed every hidden evaluation and its comparison is incomplete. No saving is claimed. Report: `docs/V0_7_2_RELEASE_REPORT.md` |
| 0.8.0 | `v0.8.0` | 2026-10-13 | Latest tagged release | Execution isolation (ISOLATED, RESTRICTED, STANDARD), autonomy profiles and boundary requests, application and browser automation, internet research. Verdict PASS against its gates, merged to `main` and tagged locally; when its report was written nothing was pushed. Report: `docs/V0_8_RELEASE_REPORT.md` |
| 0.9.0 | 2026-10-13 | `v0.9.0` | PARTIAL against its own gates, released on the owner's decision | Per-session capabilities, the second security review, release engineering, and operational autonomy (progress and time remaining, network resilience, the Director Line). Not production-ready: the installer was not run, nothing was proven on a real outage, a real long mission or a real messaging service. Report: `docs/V0_9_RELEASE_REPORT.md` |

"Superseded" is this file's word for a version that a later tagged release replaces; no report calls 0.7.x
unsafe for the reasons below, but none of them contains the operating-system containment.

Why 0.2.1 to 0.5.0 are not recommended. `docs/V0_6_RELEASE_REPORT.md` ("Security hardening") and `docs/SECURITY.md`
record two defects that `v0.3.0`, `v0.4.0` and `v0.5.0` do not fix:

1. An agent's shell could rewrite a task worktree's `.git` pointer file. NEXUS's next commit, reset or clean then
   acted on the user's repository or on another task's worktree. Recorded as present since 0.1. Fixed in 0.6.0
   (commit `42a88ea`).
2. A `git config` command with a value option in front of the key (for example `--type bool core.fsmonitor ...`)
   passed the command classifier, and the program the configuration named then ran inside NEXUS's own git calls,
   with NEXUS's environment. Recorded as present since 0.2.1. Fixed in 0.6.0 (commit `42a88ea`).

0.2.1 is affected too. In the source of tag `v0.2.1`, the git service has no check of the worktree pointer and
passes no `core.fsmonitor`, `core.hooksPath`, `core.pager` or `protocol.ext.allow` setting to git, and the command
classifier tests only the first positional word of `git config` as a key and has no rule for non-git commands that
name a `.git` path. This is a reading of the source; the defects were not reproduced on a build of 0.2.1.

Known defects of 0.6.0. The independent security review of the `nexus-0.7` branch (2026-10-06) reproduced these
against code that 0.6.0 also has. They are fixed in 0.7.0.

1. The worktree pointer check of 0.6.0 compares only Git's back-pointer. A Git directory that an agent creates
   itself inside its worktree, with a back-pointer to the worktree and the user's repository as its common
   directory, passes the check, and NEXUS's next commit then moves the user's branch.
2. The rule that a non-git command naming a `.git` path asks first compares the name literally. `.git` followed by
   a space or a dot, and the short name `GIT~1`, are the same file to Windows and pass without a question, so the
   pointer can be rewritten with an ordinary shell command.
3. NEXUS's own read-only git commands (status, diff) do not verify the pointer, and they run the `filter` and
   `textconv` programs of whatever repository the pointer names.
4. A power command written without a space before its switch (`cmd /c shutdown/s`) passed the command classifier
   of the 0.7 branch. The classifier of 0.6.0 matches a command's name the same way (a reading of its source; this
   one was not reproduced on a build of 0.6.0).

Items 1 to 3 are in the source of tag `v0.6.0` (`git-service.ts` and `command-classifier.ts` as of commit
`42a88ea`); they were reproduced on the 0.7 branch before the fix, not on a build of 0.6.0.

Do not run 0.6.0 on a repository whose content you do not trust. 0.7.0 is not a sandbox either (see
`docs/SECURITY.md`): review what agents changed before you rely on a branch.

The 0.5.0 tag gap. Tag `v0.5.0` points at commit `389d95f` (2026-10-05 05:17:26). The test status and build
progress for 0.5.0 were committed 28 seconds later, as `f8e5a67`, which is not in the history of `v0.5.0`. At that
tag, `docs/TEST_STATUS.md` still describes 0.4.0 and `docs/BUILD_PROGRESS.md` has no 0.5.0 section. Current
`main` and later tags have both.

## Authentication

NEXUS does not store, read or manage Claude credentials and has no login flow. Each agent is a
`claude.exe` process started by the official `@anthropic-ai/claude-agent-sdk`, and that runtime uses
whatever credentials the Claude Code runtime already has on this machine. Log in with:

```powershell
claude auth login
```

The Authentication view asks the runtime for its account information (no model call is made) and
shows one of: authenticated, authentication required, runtime unavailable, SDK error, together with
the mode the runtime reports (subscription, API key, third-party provider).

`ANTHROPIC_API_KEY` warning behaviour: if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` exists in the
environment NEXUS was started from, the Authentication view shows

> ANTHROPIC_API_KEY is present and may cause Claude usage to be billed through the API rather than
> your Claude subscription.

Settings, Claude, "Subscription Mode" is on by default. While it is on, NEXUS gives every agent a copy
of its environment with those two variables removed (your system and user environment variables are
never modified). With it off, the variables are passed through and the runtime chooses the credential.
Details and the policy caveat about third-party use of Claude subscription login are in
[docs/AUTHENTICATION.md](docs/AUTHENTICATION.md). NEXUS makes no claim about subscription limits or
cost beyond that document.

## Launching and opening a project

1. Start the app (`pnpm dev`, `pnpm start`, or the installed NEXUS shortcut). Only one window runs;
   starting a second one focuses the first. The window starts the runtime process when none is running and
   connects to it; closing the window leaves the runtime and its work running (see 0.7.0 below).
2. Projects view, "Open Project", and pick a folder. NEXUS resolves the Git root, then profiles the
   project read-only: package managers, languages, frameworks, scripts, and the build, test, lint and
   typecheck commands it will use as automated checks. Nothing in the folder is changed.
3. In the project, write the mission, choose a mode, a preset, a strategy, a planning mode and a review mode, and press Start mission. NEXUS opens on Home.

The strategy selector is shown for every mode except ASK and AUDIT (read-only) and for OVERNIGHT. It defaults to
`ADAPTIVE`. Strategies configure the same engine; they do not add a second one:

| Strategy | What it configures (`src/main/modules/strategy/strategies.ts`) |
|---|---|
| `ADAPTIVE` | Asks the policy engine, records the decision and its reason, then runs the chosen strategy. The choice is fixed for the run. With no policy evidence it follows the default table. |
| `SINGLE` | No planner. The mission becomes one worker task (strongest tier, balanced in ECO), one agent at a time. Checks, review, verification and merge still apply. |
| `BUILD` | Planning `single`, review `auto`, the preset's agent limit. |
| `SWARM` | As BUILD with the swarm planner guidance and the maximum preset's agent limit (the ECO cap in ECO). |
| `CONSENSUS` | Consensus planning (three planners, critic, synthesizer) and dual review. |
| `SPECULATIVE` | No planner. Two candidates by default (three at most) implement the same task, each in its own clone of the repository; objective checks pick one; it then goes through review and verification. Uses more Claude usage. |

Details: [ORCHESTRATION](docs/ORCHESTRATION.md) (Strategies), [ADAPTIVE_POLICY](docs/ADAPTIVE_POLICY.md).

Constraints enforced by the code:

- BUILD, SWARM, REPAIR, MISSION and LOOP need a Git repository with at least one commit.
- ASK and AUDIT also work on a folder that is not a Git repository.
- Agents work from the commit that is `HEAD` when the run starts. Uncommitted changes are not
  visible to writing agents, and the UI warns about a dirty repository.

Navigation is a left sidebar in three groups: Workspace (Home, Projects, Missions, Agents), Intelligence
(Arena, Policy, Usage, Performance, Repository) and System (Overnight, Activity, Memory, Settings). Ctrl+K opens
the command palette, Ctrl+B shows or hides the sidebar, Ctrl+1 to Ctrl+9 open the first nine entries in that order
(Home, Projects, Missions, Agents, Arena, Policy, Usage, Performance, Repository), and Esc closes an overlay
(`src/renderer/src/app/nav.ts`, `hotkeysModel.ts`).

## Run modes

All modes share the same engine. What the code does differently per mode:

| Mode | What actually differs |
|---|---|
| ASK | No planner run. NEXUS creates a single read-only `researcher` task (kind `ask`) from your prompt and starts it immediately, with no plan approval. No worktree, no review, no verification, no mission verification. Works outside Git. Read-only agents run in your project directory. |
| BUILD | Planner guidance: small DAG of bounded tasks, tests for new behaviour. |
| SWARM | Planner guidance only: maximum safe parallel decomposition, shallow wide graph, disjoint `suggestedFiles`. Real parallelism is still limited by the preset's agent cap and file-overlap serialization. |
| REPAIR | Planner guidance only: reproduce, diagnose, fix, regression test. |
| AUDIT | Planner guidance (parallel read-only review tasks, then one synthesis task depending on all of them) plus code rules: a plan containing a `worker` or `debugger` task is rejected and sent back to the planner; tasks with dependencies get kind `synthesis`, the others `audit`; adding a task with a writing role later is refused. Works outside Git. No merges happen because no task writes. |
| MISSION | Planner guidance only: features with implementation and test tasks, architect tasks first where interfaces must be settled, final integration verification task. |
| OVERNIGHT | Not a separate engine mode: the composer starts a MISSION run through `overnight.start`, without plan approval, attached to an overnight record (policy, authorization, failsafe). See [OVERNIGHT_MODE](docs/OVERNIGHT_MODE.md). |
| LOOP | Planner guidance only: objectively checkable mission criteria, first iteration planned as concrete tasks. The composer also sends a `maxIterations` override for LOOP. There is no separate outer loop for LOOP: iteration bounds are the repair bounds that apply to every mode (see [ORCHESTRATION](docs/ORCHESTRATION.md)). |

So BUILD, SWARM, REPAIR, MISSION and LOOP differ only in the planner prompt (and the `maxIterations`
override for LOOP). The one-line descriptions in the UI describe intent, not separate code paths.

Since 0.3 a run also has a strategy (see "Launching and opening a project"). The strategy sets the planning mode,
review mode and agent limit through the run configuration, and `SWARM` also sets the run mode to `swarm`. A run
created without a strategy (ASK, AUDIT, or a caller that sends none) behaves exactly as before 0.3.

## Planning mode and review mode

Both are chosen in the mission composer and stored in the run configuration (`planningMode`, `reviewMode`).
Runs created before 0.2 have neither field and behave as the defaults.

| Option | Values | Behaviour |
|---|---|---|
| Planning mode | `single` (default) | One planner agent, as in 0.1. |
| | `consensus` | Three planners (risk-first, parallelism-first, minimal-change) run concurrently, then a critic and a synthesizer when at least two candidates are valid. With exactly one valid candidate it is used directly; with none, the single planner runs and is told the candidates' errors. Costs several planner sessions. The composer shows a recommendation from `planning.recommend` (a heuristic on prompt length, number of deliverables, scope keywords and repository size); it is advice only. |
| Review mode | `auto` (default) | Two reviewers plus an arbiter for tasks whose risk is `high`; one reviewer for the rest (the `security_reviewer` role for high-risk tasks, `reviewer` otherwise). |
| | `standard` | Always one reviewer, as in 0.1. |
| | `dual` | Every reviewed task gets two reviewers and, when a significant finding survives deduplication, an arbiter. |

ASK runs have no planner, so planning mode does not apply to them.

## Presets

Implemented in `src/shared/settings.ts` (`presetMaxAgents`, `presetRolePolicy`):

| Preset | Parallel agents | Model tiers |
|---|---|---|
| ECO | 2 | Planner and verifier keep their configured tier. Architect, worker, debugger, reviewer and security reviewer move from `strongest` to `balanced`; researcher uses `fast`. |
| BALANCED | The "max parallel agents" setting, capped at 4 | The configured role policy. Defaults: `strongest` for planner, architect, debugger, reviewer, verifier and security reviewer; `balanced` for worker and researcher. |
| MAXIMUM | The "maximum preset agents" setting (default 8) | Same role policy as BALANCED. It only raises parallelism. |

Tiers map to model aliases in Settings (defaults: strongest = `opus`, balanced = `sonnet`,
fast = `haiku`); the runtime resolves the alias. MAXIMUM can use your Claude usage quickly; the
composer shows a warning. A run can override max agents, iterations, duration and plan approval.

## Where results end up

NEXUS never writes to your working tree or your branches. Each run creates an integration branch
`nexus/<run>/integration`, where `<run>` is the first 8 hex characters of the run id. Every task that
passes verification is merged into it with `git merge --no-ff`. The run page shows the branch name.

When the run completes, review and merge it yourself from your repository:

```powershell
git log --oneline main..nexus/<run>/integration
git diff main...nexus/<run>/integration
git merge nexus/<run>/integration
```

The integration branch is also checked out in a worktree under the data directory until the run is
cleaned up. NEXUS does not merge into your branch, push, or delete branches. See
[docs/GIT_WORKTREES.md](docs/GIT_WORKTREES.md).

## Where data is stored

| What | Location |
|---|---|
| Database (SQLite, WAL) | `%APPDATA%\NEXUS\nexus.db` (plus `-wal` and `-shm` files while running). Before a schema upgrade NEXUS keeps `nexus.db.v<old>.bak` next to it |
| Arena trial repositories | `%APPDATA%\NEXUS\arena\<campaign>\<trial>\`; removed by `arena.cleanup` for a finished campaign |
| Task and integration worktrees | `%APPDATA%\NEXUS\worktrees\<run>\<task>\` |
| Electron profile data | `%APPDATA%\NEXUS\` |
| Runtime files | `%APPDATA%\NEXUS\runtime\` (`endpoint.json`: the pipe name and token, readable by your user only; `runtime.log`), `%APPDATA%\NEXUS\runtime-profile\` (the runtime's own profile), `%APPDATA%\NEXUS\overnight.key` |
| Claude session transcripts | Written by the Claude runtime itself under `~\.claude\projects\` |

This is Electron's `userData` directory; the exact path is reported by the app (`app.info` returns
`dataDir`, `dbPath`, `worktreesDir`) and the app can open it. Set the environment variable
`NEXUS_DATA_DIR` before launching to use a different directory instead (used by tests).

## Removing local data completely

1. Uninstall NEXUS from Windows Settings. The installer is configured with
   `deleteAppDataOnUninstall: false`, so the data directory survives uninstalling.
2. Delete the data directory (`%APPDATA%\NEXUS`, or your `NEXUS_DATA_DIR`). This removes the database
   and all worktree directories.
3. In every repository you used with NEXUS, drop the dead worktree registrations and the branches:

   ```powershell
   git worktree prune
   git branch --list "nexus/*" --format="%(refname:short)" | ForEach-Object { git branch -D $_ }
   ```

   `-D` is needed for branches whose commits you never merged. Skip this if you want to keep results.
4. Optional: Claude session transcripts under `~\.claude\projects\` belong to the Claude runtime,
   not NEXUS. Delete them with the runtime's own tooling or by hand if you want them gone.

## Scripts

| Script | Runs |
|---|---|
| `pnpm dev` | `electron-vite dev` |
| `pnpm build` | `node scripts/build-launcher.mjs && electron-vite build` |
| `pnpm start` | `electron-vite preview` |
| `pnpm launcher:build` | `node scripts/build-launcher.mjs`: compile `native/nexus-launch/nexus-launch.cs` to `out/native/` |
| `pnpm sandbox:setup` | `node scripts/sandbox-setup.mjs`: the one-time elevated setup of the ISOLATED profile |
| `pnpm typecheck` | `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` |
| `pnpm lint` | `eslint .` |
| `pnpm format` | `prettier --write .` |
| `pnpm test` | `vitest run` (unit, integration and scenario projects) |
| `pnpm test:unit` | `vitest run --project unit` |
| `pnpm test:integration` | `vitest run --project integration --project arena-cases` (includes `tests/scenarios`) |
| `pnpm test:e2e` | `node scripts/build-launcher.mjs && electron-vite build && playwright test` (Electron UI tests, see [TESTING](docs/TESTING.md)) |
| `pnpm stress` | `vitest run -c vitest.stress.config.ts`: seeded orchestration stress campaign with scripted agents (no Claude usage). See [TESTING](docs/TESTING.md). |
| `pnpm smoke:claude` | Manual test against the real Claude runtime. Consumes Claude usage. |
| `pnpm smoke:power` | Manual test of the real `WindowsPowerController`: schedules a Windows shutdown one hour away, checks it was accepted, aborts it at once and checks nothing is left armed. Never part of `pnpm test`. |
| `pnpm smoke:usage` | Manual test against the real Claude runtime: account information and the experimental usage report. No prompt is sent and no model turn runs. Writes evidence to `docs/acceptance/usage-report-*.json`. |
| `pnpm smoke:cache` | Manual test against the real Claude runtime: seven one-turn sessions on the smallest model that record what the prompt cache read and wrote. Consumes a little usage. Writes evidence to `docs/acceptance` |
| `pnpm accept:graph` | One mission run twice on the real Claude runtime, without and with the Context Graph, with a hidden evaluation. Consumes usage (two BUILD missions). Headless: no window |
| `pnpm bench:retrieval` | The retrieval benchmark of the Context Graph against the 0.7.0 selection (no Claude usage). `NEXUS_WRITE_BENCHMARK=1` stores the figures |
| `pnpm baseline:tokens` | Token figures of the real acceptance runs stored under `docs/acceptance`, and the size of the role prompts (no Claude usage) |
| `pnpm accept:proposal` | `node scripts/dynamic-proposal-acceptance.mjs` (real Claude, see below) |
| `pnpm accept:rotation` | `node scripts/session-rotation-acceptance.mjs` (real Claude, see below) |
| `pnpm accept:arena` | `node scripts/arena-acceptance.mjs` (real Claude, consumes usage): a small Arena campaign |
| `pnpm accept:speculative` | `node scripts/strategy-acceptance.mjs speculative` (real Claude, consumes usage) |
| `pnpm accept:adaptive` | `node scripts/strategy-acceptance.mjs adaptive` (real Claude, consumes usage) |
| `pnpm package` | `node scripts/build-launcher.mjs && electron-vite build && electron-builder --win nsis` |
| `node scripts/release-artifacts.mjs release` | Lays out `release/v<version>/` after `pnpm package` (see "The release folder") |
| `node scripts/verify-signatures.mjs <dir>` | Reports which Windows program files are signed; `--require-signed` fails on any that is not |
| `node scripts/v08-packaged-check.mjs` | Starts a packaged, unpacked application off-screen on a data directory of its own and checks it (no Claude usage) |

Other `smoke:*` and `accept:*` scripts exist in `package.json` (providers, dialog, workspace, compaction,
campaign, Director); each is manual and most consume Claude usage.

Automated tests never call the real Claude API; they use `FakeAgentRuntime`.

Real-mission scripts (not part of any test run; each starts the app, drives it through its IPC bridge
with the **real Claude runtime**, consumes Claude usage, and writes evidence to `docs/acceptance/`):

| Command | Mission |
|---|---|
| `node scripts/adversarial-mission.mjs [path-to-NEXUS.exe]` | Four tasks (three modules and a report task that depends on them), fast-tier workers, a controlled app restart mid-run. Uses the default planning and review modes. |
| `node scripts/v02-acceptance-mission.mjs [path-to-NEXUS.exe]` | The same mission with `planningMode: consensus` and `reviewMode: dual`, plus a repository convention that needs a task no one planned, to provoke a graph proposal. Also restarts the app mid-run. |

| `node scripts/dynamic-proposal-acceptance.mjs [path-to-NEXUS.exe]` | A CSV export whose contract is only readable after a worker runs `npm run generate-schema` (it is packed in a vendor bundle a read-only planner cannot unpack). The contract demands a module no task of the plan delivers; the gate is a real `ADD_TASK` proposal, a graph revision, the new task executed and the original task resumed. |
| `node scripts/session-rotation-acceptance.mjs [path-to-NEXUS.exe\|-] [turns]` | One worker task with a low rotation threshold (`sessionRotationTurns`, default 8 here): the gate is a real session rotated with a structured handoff and a second real session finishing the task. |
| `node scripts/arena-acceptance.mjs [path-to-NEXUS.exe\|-] [caseIds] [strategies]` | A real Arena campaign: by default `bugfix-localized`, `feature-small` and `ui-state-bug` under `SINGLE` and `BUILD`, one repetition, ECO budget. Records what NEXUS measured; changes no threshold. |
| `node scripts/strategy-acceptance.mjs speculative\|adaptive [path-to-NEXUS.exe]` | One real SPECULATIVE task (two candidates, tournament, review, verification) or one real ADAPTIVE mission (profile, decision, reason, outcome). |
| `node scripts/packaged-validation.mjs <NEXUS.exe> <db-dir>...` | No Claude usage. Launches a packaged or installed build on copies of existing databases and checks the schema upgrade, old runs, auth status, project opening and the Overnight UI. |

These launch the window off-screen (`NEXUS_WINDOW_OFFSCREEN=1`); set `NEXUS_ACCEPT_SHOW=1` to see it.
Without an argument the first two and the acceptance scripts launch the dev build (run `pnpm build` first). `scripts/acceptance-mission.mjs` is the
earlier single-mission acceptance script.

## Current limitations

- Packaging targets Windows x64 only; the macOS and Linux Claude binaries are excluded from the
  installer. Other platforms are not supported.
- No automatic merge into your branch and no approval-gated merge action. The `git` and `merge`
  approval kinds exist in the type definitions but nothing creates them. You run `git merge` yourself.
- Memory is a keyword index (SQLite FTS5 with bm25). There is no vector or embedding memory.
- Shell command classification is heuristic. Up to 0.6, inline interpreter code (`python -c`, `node -e`) and
  script files were not inspected, and writing roles could run such commands without approval; since 0.7 they are
  inspected, which is still static inspection. Since 0.8 the operating system contains the code of an enrolled
  project (see "Execution profiles"), but only ISOLATED is meant to hold against hostile code, and a project that
  is not enrolled runs as the user with the policy layer alone. See [SECURITY](docs/SECURITY.md) and
  [V0_8_SECURITY_MODEL](docs/V0_8_SECURITY_MODEL.md).
- NEXUS itself runs the dependency install (`pnpm install`, `yarn install`, `bun install` or
  `npm ci`) in each new worktree and the project's check commands. These run project code and are
  not passed through the agent policy engine.
- MCP support is basic: a list of servers (stdio, http, sse) with per-role enablement. No tool-level
  permissions, no connection test, no discovery UI.
- Quota detection depends on signals from the SDK (`rate_limit_event` with status rejected, assistant
  `rate_limit` or `billing_error`, or the SDK's usage-limit message prefixes). Since 0.3 a quota pause is
  resumed automatically after the reset the runtime reported, or after a probe finds Claude available again
  (see [QUOTA_RECOVERY](docs/QUOTA_RECOVERY.md)); you can still resume by hand. A pause you made yourself is never resumed
  automatically. NEXUS has no spending cap of its own: bounds are turns
  per agent, retries, repair iterations and run duration.
- A task interrupted while its checks were running restarts at the implement stage (the task state
  `running` does not record the stage), consuming a new attempt.
- Orphan worktree cleanup helpers exist in `WorktreeManager` (`findOrphans`, `cleanupOrphans`) but the
  application does not call them. Startup recovery only reconciles worktrees it has records for, and
  NEXUS never deletes branches.
- The planner, reviewer and verifier outputs are schema-checked, but the quality of plans and reviews
  is whatever the model produces. A passing verification means the verifier agent judged the criteria
  met, not that the software is correct.
- Single window, single instance. There is also one runtime process per data directory, which keeps
  running after the window closes until you choose "Stop NEXUS" or it has had nothing to do for two minutes.

### Limitations of 0.3 features

- No real usage limit, real Arena campaign, real speculative task or real ADAPTIVE mission had been run when this was written; see
  [V0_3_RELEASE_REPORT](docs/V0_3_RELEASE_REPORT.md). Their behaviour is covered by unit, integration, scenario and seeded
  stress tests with the scripted runtime (`FakeAgentRuntime`). The only 0.3 check against the real runtime that is
  recorded here is `pnpm smoke:usage` (2026-10-04, Claude Agent SDK 0.3.288, no prompt sent): the usage report answered in
  about one second with plan windows (`five_hour`, `seven_day` and a model-scoped bucket), each with a utilization
  percentage and a reset time, and the account mode was `subscription`. Evidence: `docs/acceptance/usage-report-*.json`.
- NEXUS has no figure for the tokens remaining in a subscription and shows none. Observed usage covers NEXUS's own sessions only.
- The usage report is an experimental SDK method that can change or disappear. When it is missing or fails, recovery
  probes with one minimal session per interval.
- Quota recovery depends on what the runtime reports. With no reset time NEXUS probes on a backoff schedule; an ordinary
  (non-overnight) run with no wait limit probes for as long as NEXUS runs. See [QUOTA_RECOVERY](docs/QUOTA_RECOVERY.md).
- When this was written (0.3) only the Claude runtime existed. Since 0.6 other providers are optional: Codex is
  read-only and Gemini is detected only (see "What's new in 0.6").
- `ALWAYS_FOR_HIGH_RISK` speculation behaves as `AUTO`. Candidates are proposed for exact and category-level contexts, never global ones.
  Learning runs only when you ask for it. A run created without a strategy records no mission outcome.
- The ADAPTIVE decision is fixed when the run is created. An explicit strategy choice is used as given and records no decision.
- Arena needs Node.js 20 or newer on `PATH` (NEXUS ships none); without it a campaign cannot start. Every built-in case is a
  small JavaScript project, so results say nothing about other languages or large repositories. Creating a campaign from a
  user repository is not offered. A campaign can run under the overnight supervisor (Arena, New campaign, Run overnight); a real campaign with a real power action has not been run. Unattended trials deny every tool
  approval request. The `performance-optimization` evaluator decides by timing and runs on one machine.
  Pausing a campaign does not pause runs already running. Budgets are checked after each trial (the wall-clock budget on a timer),
  so the running trial can exceed them. Regression detection compares only the two newest (NEXUS version, model) groups.
  See [ARENA](docs/ARENA.md).
- Small samples: a preference is proposed only when its challenger has at least 5 Arena trials from 3 distinct cases and `MODERATE` evidence (12 weighted trials); missions alone never produce a candidate. No p-values are
  computed, and a table that says two strategies are not separated means exactly that. See [BENCHMARK_METHODOLOGY](docs/BENCHMARK_METHODOLOGY.md).
- Dependency installs, check commands and Arena commands run without your Claude credentials (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `NODE_OPTIONS`, `NODE_PATH`); other environment variables are passed on. The agent shell policy is still a lexical filter
  (see [SECURITY](docs/SECURITY.md)).
- A speculative task costs one extra implementing session per extra candidate and applies to a single-task run only; a
  planned task graph has no speculative tasks.

### Limitations of 0.2.1 features

- Overnight Mode needs Windows. Real sleep and hibernate have not been executed on a real machine, and no real
  shutdown was allowed to complete during development; the shutdown timer was exercised by `pnpm smoke:power` only.
- The failsafe is a Windows shutdown timer, and Windows closes applications without waiting whenever a timed
  shutdown fires, whether or not "force close" is ticked. A normal (non-forced) final shutdown can be stopped by an
  application with unsaved data; the PC then stays on.
- The agent shell policy is a lexical filter, not an operating-system sandbox. Plain and commonly obfuscated power
  commands are refused for every role, but a worker can run code it wrote, so a prompt-injected worker could still
  power the machine off or abort the failsafe through its own program. NEXUS guarantees only that none of its own
  mechanisms gives an agent the power controller or a valid authorization.
- The overnight authorization is sealed with a key kept encrypted for the Windows user. Code running as the same
  user with enough effort could recompute it; the seal defends against edits of the database, not against a
  compromised user account.
- Only one overnight run at a time. An overnight run always uses MISSION mode and skips plan approval.
- After NEXUS was not running for more than 10 minutes, or Windows restarted, an overnight run is ended without a
  power action on the next launch and has to be resumed by hand as a normal run.
- Budgets cover agent sessions and repair tasks. There are no token or cost limits.
- Checkpoints are a record for inspection; recovery reads the live tables, not the checkpoints.
- The cause of the one-off "run ended paused" scenario failure seen in 0.1 is still not proven.
- A rotated session is marked on the handoff session row, not on the session that reached its turn limit.

### Limitations of 0.2 features

- Graph proposals are rate limited. A task may submit at most 5 proposals in total (rejected and malformed
  ones count; retries, resumes and repair sessions of the same task share the allowance), one proposal adds at
  most 8 tasks, and a proposal adding more than 3 tasks needs your approval. Run-wide, once 20 proposals have been
  applied, or 25 tasks have been added by proposals, a proposal that adds tasks no longer applies on its own
  and waits for your approval.
- Anything that touches another agent's task needs your approval: cancelling it, adding or removing a
  dependency of it, changing its priority. So does `REPLAN`. A running task other than the proposer's own can never be
  given or lose a prerequisite, and completed, failed and cancelled tasks cannot be changed at all.
- An agent whose proposal is held for approval is told to carry on and not wait. It is not notified when you
  decide; an approved change is applied to the graph when you approve it and takes effect through the scheduler.
- Repair tasks (children created by the pipeline) cannot be changed or depended on through proposals.
- Measured performance changes routing only for a (role, model, task category) group with at least 5
  outcomes whose first-pass rate is below 50%, and then promotes by one tier. Below 5 samples the Performance view
  marks the row as insufficient and routing ignores it. Outcomes are recorded only for top-level `implement` and
  `repair` tasks that completed or failed.
- Repository analysis is static: manifests, file names and sizes, regular-expression import extraction
  (JavaScript/TypeScript, Python, Go, Rust) and Git history. It is bounded (4000 files, 5 seconds, 200 000 bytes read
  per file, 200 commits of history) and never reads secret-looking files. It does not understand code semantics.
- Freshness fingerprints hash each supporting file's path, size and modification time (at most 50 files per fact),
  not content. A change that keeps size and mtime is not detected; a touched but unchanged file is reported stale.
- Facts that agents recorded (`decision` facts) are the agents' own claims; they are marked as such in the
  fact text and in the prompt. Orchestration evidence shown to verifiers contains agent-written text (subjects,
  titles) that is not proof of anything.
- There is no vector or embedding search: facts are selected by shared paths, modules and terms; memory by SQLite FTS5.
  Full-text search over facts is used only by the Intelligence view.
- Consensus planning and dual review multiply the number of Claude sessions for planning and review. Consensus
  planning starts again from scratch after a pause or restart during planning.
- A dual review whose arbiter returns no valid decision falls back to a fixed rule (see
  [ORCHESTRATION](docs/ORCHESTRATION.md)), so confident critical and high findings stand and other findings are dropped.
- Results are still merged manually: NEXUS never merges the integration branch into your branch.
