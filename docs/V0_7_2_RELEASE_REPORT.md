# NEXUS 0.7.2 development checkpoint

Status: **PARTIAL**, 2026-10-08. This is a checkpoint of ongoing development, not a release verdict or a completed implementation of the supplied specification.

Branch: `nexus-0.7.2-director-ui-compiler`. Parent: `nexus-0.7.1-token-intelligence` at `59e0502`. Main, release tags and remotes have not been changed. Package identity is `0.7.2-development`.

## Implemented and connected

- Runtime-owned official ChatGPT sign-in: dynamic registration, persistent host identity, loopback callback, PKCE/state/nonce, signed identity validation, isolated registrations, protected atomic credential storage and serialized rotating refresh. Public model catalog and streamed Responses adapter; no API-key fallback or host tools.
- The user's Plus account completed the official sign-in and granted plan-use scope in an isolated development profile. Seven catalog models were returned; the user selected GPT-6.1-Sol. At this checkpoint paid-credit confirmation remains false and **no live inference request has been sent**. Browser sign-in and catalog success do not prove inference entitlement, quality, or quota.
- Durable advisory Director requests and scoped history. Missing technical capability waits without spending strategic capacity or downgrading the requested level. Council is a fixed memo/challenge/synthesis protocol; each validated stage is saved before the next call. Failures retain completed stages and disagreement. Interrupted requests require explicit review/retry and are not replayed.
- An isolated Claude Technical Director adapter exists behind an admission callback, with no tools, MCP servers, project settings or approvals. Fake sessions verify the boundaries and bounded cleanup; an unconfirmed stop quarantines the adapter and retains handles for disposal retries. Primary failure classifications survive cleanup failure, and native start/end/stream error text is sanitized. **It is not enabled in the production runtime and has no real quality evidence.**
- Immutable raw intent storage, bounded schemas, provenance, AUTO/EXACT/LIGHT/STANDARD/TECHNICAL/COUNCIL policies, separate semantic and structured intent comparisons, cache/single-flight behavior and context invalidation. Consequential ambiguity waits for clarification. EXACT makes no advisory model calls.
- Engineering mission and Overnight mission IPC admission default to AUTO. A validated scoped specification is required before execution; repository snapshot changes are checked again before run insertion. Overnight compilation blocks before native authorization or power arming. Original whitespace is preserved. Internal tasks do not recursively compile.
- Durable ChatGPT capacity observations, account registration binding, backoff and probe leases. Policy separates role quality, capabilities, local reserves and observed capacity. No Codex/SIWC shared pool is inferred, and unknown allowance/reset are displayed without fabricated percentages.
- Director, compiler preview, ChatGPT connection and capacity UI; navigation and embedded build identity. Admission freezes the draft, announces blockers and focuses the explanation. Full advisory operations settle before database closure, including retrieval and outcome persistence. Malformed compiler, drift and council artifacts produce local validation messages without echoing private schema keys or values.

## Verification receipts and limits

| Check | Result at this checkpoint |
| --- | --- |
| Node and renderer type checks | Passed; Node check rerun after cleanup and schema-error privacy fixes |
| Full lint | Passed after correcting type-only imports |
| Focused intelligence, persistence, IPC and Overnight renderer tests | 318 passed in 14 files after cleanup and malformed-artifact privacy fixes; OAuth hint/browser-error privacy checks and restored migration assertions also passed in an earlier 27-test focused rerun |
| Current targeted Electron checks | 3 passed: compiler lock/focused blockers, durable waiting/connection UI, Overnight authorization and simulated power lifecycle |
| Complete Electron assertion run | 29 passed, 2 failed, 2 optional capture tests skipped. Failures were intentional capacity/navigation image changes and a queue test reading approval detail before scheduler reconciliation. Both failed cases plus two compiler/provider cases passed in the latest four-test rerun; no threshold or product gate was relaxed. The full run preceded the final schema-error privacy patch. |
| Earlier mission and renderer security Electron checks | Passed; not a substitute for final all-page E2E |
| Visual baseline confirmation | The updated two usage snapshots passed again with snapshot-update mode disabled and the existing tolerance unchanged |
| Unpacked production checkpoint | Passed: exact clean committed build identity, runtime protocol 1, all 13 database migrations, restricted runtime endpoint, idle worker startup, 19 navigation pages, core light/dark wide/narrow captures, no renderer errors and endpoint removal on shutdown. No mission, inference or power action was started. Fresh-profile walkthrough only; installer and installed-upgrade acceptance remain open. |
| Full regression during development | 170 passing files, 3 failing files; 4,012 passing tests, 2 failing tests, plus one teardown failure; source changed during this run, so it is not final-source acceptance |
| Security corpus isolated rerun | All 916 assertions passed; teardown still failed with Windows EPERM on an empty fixture directory |
| Performance case isolated rerun | Existing unoptimized fixture evaluator reached its 120-second timeout; the required assertion-based verdict remains unresolved |
| Council checkpoint test from the mixed-source full run | Failed before the matching implementation loaded; passed in the current focused runs |
| Capacity stress | Fake/deterministic transitions, restart/CAS/backoff/lease checks; no real multi-provider failover evidence |
| Real Claude work | Intentionally deferred until the reset on 2026-10-10; no new real session started |
| Real GPT work | Sign-in and catalog observed; inference and quality acceptance pending external paid-credit confirmation |

The full-suite failures have not been suppressed and no evaluator timeout or acceptance threshold has been relaxed. No clean final regression is claimed.

## Independent reviews

Two UI review rounds inspected source and actual development-build screenshots in light and dark/narrow layouts. Fixed findings: full objective disclosure, council categories/evidence, truthful deferred states, editable drafts during admission, off-screen/unannounced blockers and capacity loading copy. The latest lock/focus behavior was checked through Electron E2E. Connected-account rendering, completed long recommendations, measured contrast and the full keyboard/page matrix still need acceptance.

Repeated independent technical/security review found and drove fixes for callback ownership/replay, account/catalog races, storage failure latching and consent withdrawal, intent/context mismatch, repository TOCTOU, interrupted-request recovery, malformed-output error privacy, complete-operation shutdown, council stage persistence and quarantined technical cleanup. These reviews are static/fake-test evidence; they do not establish real provider quality or production Claude behavior.

The subsequent technical review identified cleanup masking the primary failure; this is fixed and independently rechecked. An additional review of packaged UI screenshots was attempted but the reviewer reached an account usage limit before completing it. That attempt is not counted as a completed review.

Compiler, drift and every Director stage now sanitize schema diagnostics; the independent technical reviewer confirmed capacity/auth failures retain their classifications. Two affected usage-page snapshots were regenerated after visual inspection of the intentional capacity panel and navigation changes. The queue test now waits for its required pending-approval detail, rather than just the existence of an adopted mission; the same state/detail assertion remains mandatory.

Production package checks rendered all 19 navigation views, started a provider-capable idle worker without a session, verified all 13 migrations and removed the runtime endpoint on shutdown. The initial identity check correctly rejected a dirty stamp: electron-vite's transient timestamped configuration bundle was included in Git status during configuration evaluation. The generated-file ignore rule is narrowed to that numeric bundle name; the refreshed package passed clean-identity verification. The reproducible check is `scripts/v72-packaged-check.mjs`; current receipts and screenshots are under ignored `test-results/v72-package`. The package is `release/v72-development/win-unpacked/NEXUS.exe`.

The protected Plus profile was reopened in the current development app and the official catalog refreshed successfully. GPT-6.1-Sol remains selected; paid-credit confirmation remains false. No inference was sent. This live profile is separate from the fresh signed-out production walkthrough.

## Required work still open

1. Complete compiler entry boundaries for Programs, Workspaces and user engineering queue items, including canonical intent references, explicit goal/constraint metadata and stale-start checks. Current coverage is engineering missions and Overnight missions only.
2. Complete typed compiler passes, explicit consequential user decisions, canonical-reference storage and inspection/history integration. Current compiler development is bounded but does not implement every requested pass or eliminate duplicated snapshots.
3. Wire the technical adapter and Director escalation orchestration after capacity/role quality admission; implement durable routing/escalation artifacts and outcome learning. Real technical/council validation remains deferred.
4. Integrate the capacity/quality kernel with global worker scheduling, reserves, provider-scoped waits, recovery and coherent failover. Current Claude dispatch/recovery continues through the inherited machinery.
5. Complete UI 2 across Home, Mission Control, task/agent inspectors, Programs, Workspaces, Arena, Policy, Context, Control Plane, Activity, Overnight, Settings, command palette and search. The new surfaces are an initial integration, not the requested complete UI evolution.
6. Resolve full-regression infrastructure/evaluator failures without weakening gates, then run a stable final source through all required tests, fake-provider Arena comparisons, stress and visual/accessibility acceptance.
7. Perform bounded real GPT acceptance after the user confirms external paid credits are disabled. Never infer this confirmation from the account plan or elapsed time. Returning OAuth now sends retained account hints without exposing browser-launch URL errors; live refresh/reconnect, `earliest_refresh_at` handling and revocation acceptance still need completion/verification.
8. Complete installer, installed-upgrade and full-workload acceptance on the finished implementation. The unpacked production checkpoint has passed identity/startup/page/shutdown checks; it does not establish these broader acceptance gates.
9. Close the parent reconciliation gates separately. Neither this report nor the new advisory foundations waive them.

See [parent reconciliation](V0_7_2_PARENT_RECONCILIATION.md) and [implementation ledger](V0_7_2_IMPLEMENTATION_PLAN.md). Update this checkpoint as development proceeds; do not promote its status on the strength of mocked protocol success.
