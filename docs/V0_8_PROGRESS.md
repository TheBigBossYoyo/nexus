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

## Next

1. Windows isolation research result, then the launcher (job object, restricted token, ACL roots).
2. Map tool calls to capabilities and put the broker where `ask` is today for enrolled projects.
3. IPC for enrollment, grants and the boundary inbox; the UI.
4. Environment allowlist; pipe ACL and per-kind dispatch.
5. Network proxy, WebResearchProvider, ResearchArtifact, download quarantine.
6. BrowserAutomationProvider, ApplicationUnderTestManager, the agent tools.
7. Hostile corpora, fault injection, soak, reviews, final regression, package, report.
