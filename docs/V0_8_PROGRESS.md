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

## Next

1. Second isolation probe round, then the launcher and `contained: true`: job object, token, ACL roots outside
   the profile, the pipe DACL. Fail closed when ISOLATED cannot be set up.
2. WebResearchProvider over the fetch (and a search backend), ResearchArtifact with provenance, screening,
   the envelope, download quarantine, Context Graph nodes; the research tool for agents.
3. BrowserAutomationProvider (Playwright direct), ApplicationUnderTestManager, the local endpoint registry,
   the agent tools, Electron.
4. RoleCapabilityContract in planning; unattended rules (overnight, Arena) for enrolled projects.
5. End-to-end and accessibility runs of the new UI; the task inspector's research and application panels.
6. Hostile corpora, fault injection, soak, reviews, final regression, package, report.
