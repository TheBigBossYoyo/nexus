# NEXUS 0.8: triage of what 0.7.2 deferred

Written 2026-10-11 on `nexus-0.8-isolation-autonomy`, from `docs/V0_7_2_REVIEW_FINDINGS.md` as released
(`v0.7.2`, `ad3cb43`). 0.7.2 deferred fourteen MEDIUM findings to a 0.7.3 that will not be made: 0.8 follows
0.7.2 directly. Each one gets a disposition here, and so do the two hardening items and the open LOW findings
that bear on what 0.8 is about.

0.8 is about execution isolation, autonomy by capability grants, safe Internet research and app interaction, and
reliability. A finding is absorbed when it concerns execution security, authentication, process lifecycle,
network safety, prompt injection, provider isolation, browser or app interaction, scheduler recovery, resource
leaks, IPC security, or autonomy and approvals. A finding about prompt cost, wording or layout is not absorbed:
it would widen 0.8 without serving its gates.

Dispositions: ABSORB_IN_0_8, DEFER_TO_0_9, OPTIONAL_PRODUCT_POLISH (no release is promised it), SUPERSEDED.

## The fourteen deferred MEDIUM findings

The ledger's triage counts fourteen; its table has fifteen rows marked VALID_DEFERRED because 8.5 is half not
reproducible and half deferred. The deferred part of 12.10 (a toast history) is listed too.

| ID | Area | What is open | 0.8 theme it touches | Disposition | Reason |
|---|---|---|---|---|---|
| 4.3 | Overnight display | A capacity wait reads "paused" on the Overnight page | None (a label; nothing is finalized wrongly) | OPTIONAL_PRODUCT_POLISH | Display only. The mission's own page is right |
| 5.5 | Routing record | No field says a Claude stand-in was a fallback | None | DEFER_TO_0_9 | Not reachable: nothing in production records the quality evidence that would admit a stand-in. 0.8 adds no such evidence |
| 6.5 | Prompt size | The older instruction section of a first pack has no cap | None (cost) | DEFER_TO_0_9 | A cost. 0.8 must not change worker prompts for a reason outside its gates, and the campaign against 0.7.1 would have to be run again to show no regression |
| 6.8 | Context provenance | Memory, knowledge notes and workspace memory reach prompts with a source label and no admission | Prompt injection, trust classes | ABSORB_IN_0_8, narrowed | 0.8 writes new kinds of text into these stores' neighbourhood: research evidence from the web. The rule 0.8 needs is the one this finding asks about: text that did not come from the user is rendered as labelled data with its trust class, never as an instruction. Absorbed as: every store that feeds a prompt renders its entries through the untrusted-content envelope when their trust class is not the user's; a test per store. Not absorbed: routing user-curated memory through the Task Compiler, which stays an extension |
| 8.4 | Prompt size | Program text twice in the planner prompt | None (cost) | DEFER_TO_0_9 | As 6.5 |
| 8.5 | Context | Workspace runs read every workspace the project is enrolled in, not the mission's own | Scope of grants | DEFER_TO_0_9 for retrieval; the constraint is taken into the 0.8 design | Which context is relevant is not an authority question. What 0.8 takes from it: a capability grant is scoped to one workspace and is never widened by a project's membership of another |
| 9.4 | Telemetry | A session that only waited is counted as a session | Autonomy metrics | DEFER_TO_0_9 | The 0.8 metrics count interruptions, boundary requests and denials, not sessions. No 0.8 number depends on the count |
| 9.6 | Prompt size | The admitted intent twice in Program and Workspace prompts | None (cost) | DEFER_TO_0_9 | As 6.5 |
| 10.4 | Privacy | The inspector shows the ids of what was sent to a provider, not the text; nothing can be deleted | Auditability | DEFER_TO_0_9 | 0.8's audit answers what ran, what was reached on the network and under which grant. The text of provider requests and deletion of stored specifications are a privacy feature of their own |
| 11.5 | UI | The capacity section is on Usage, the connection on Providers | None | OPTIONAL_PRODUCT_POLISH | Placement |
| 11.8 | UI | The statement of what goes to OpenAI is dense | None | OPTIONAL_PRODUCT_POLISH | Layout of a statement that is present and complete |
| 11.9 | UI | Records are disclosure elements, not a table | None | OPTIONAL_PRODUCT_POLISH | Polish |
| 12.10 | Accessibility | No history of past toasts | Boundary inbox, security events | SUPERSEDED for what 0.8 adds, OPTIONAL_PRODUCT_POLISH for the rest | A boundary request and a policy denial are records with a page of their own in 0.8, not toasts, so nothing of consequence that 0.8 adds can expire unseen. A history of ordinary toasts stays polish |
| 13.5 | Tests | Untested pairs: a capacity wait with the queue, with crash recovery; AUTO with a stale specification; a ChatGPT 401 during overnight; a resumed run with the Context Graph | Fault injection, scheduler recovery | ABSORB_IN_0_8, the recovery pairs | The fault-injection suite of 0.8 injects a runtime kill and a worker kill during a capacity wait and during a queued start, and a provider outage during overnight. The pairs that are not about faults (AUTO with plan approval and a stale specification) are DEFER_TO_0_9 |
| U2.3 | UI | Three paragraphs in the capacity section | None | OPTIONAL_PRODUCT_POLISH | Density |
| U2.4 | UI | Two visual patterns for two kinds of wait | Boundary waits are a third kind | OPTIONAL_PRODUCT_POLISH, with a constraint on 0.8 | 0.8 must not add a third pattern: a task that waits for a boundary decision uses the existing waiting notice |

Absorbed: 6.8 (narrowed), 13.5 (the recovery pairs). Superseded in part: 12.10. Deferred to 0.9: 5.5, 6.5, 8.4,
8.5, 9.4, 9.6, 10.4. Polish with no release: 4.3, 11.5, 11.8, 11.9, U2.3, U2.4.

## The two hardening items

| Item | Disposition | Reason |
|---|---|---|
| VerifierCapabilityContract (R.9, R.11) | ABSORB_IN_0_8 as `RoleCapabilityContract` | It is the same question 0.8 asks everywhere: what may this actor do without anyone being asked. In 0.8 the answer is data (the capability broker's decision for a role in a workspace), so planning can read it and a plan can be checked against it: a verification step that needs a shell, a browser, an app launch or the network is accepted only if the role that gets it holds the capability |
| A campaign arm for AUTO's depth policy | DEFER_TO_0_9 | An intelligence measurement. 0.8 adds no intelligence feature and spends its bounded real-provider budget on the autonomy, research and app-use acceptance |

## Open LOW findings that 0.8 touches

Thirty-five LOW findings are open. These are the ones inside the 0.8 themes; the others stay as the ledger has
them.

| ID | What is open | Disposition | Reason |
|---|---|---|---|
| 2.2 | The ChatGPT credential file relies on DPAPI and the profile's ACL; code running as the user can ask DPAPI for it | ABSORB_IN_0_8 | Credential isolation is a release gate. The answer is not an ACL on one file: untrusted code must not run with an identity that can read the NEXUS data directory at all. The sentinel tests of 0.8 cover this file's directory |
| 2.1 residual | Code that already knows the credential file's absolute path is stopped by path rules only | ABSORB_IN_0_8 | The same gate: an operating-system denial replaces the path rule as the boundary |
| R.11 | A repair session could not delete a scratch directory it made in its own worktree: three deletions asked for approval, nobody was there | ABSORB_IN_0_8 | This is approval spam in its plainest form. Under AUTONOMOUS_PROJECT a deletion inside the task's own worktree or temp root is authorized by the grant |
| R.12 | The security cell ends paused: a reviewer's finding waits for an answer nobody gives | DEFER_TO_0_9 | A matter of what a mission does with a review finding, not of authority |
| R.13 | The orchestrator stress misses its settle time on a starved machine | ABSORB_IN_0_8 as a rule for the runs, not as a change of the test | 0.8 adds long soaks and more stress. They are run one at a time and the report says so; no timeout is raised to pass |
| 5.7 | The technical Director's session runs in the NEXUS data directory with the coding system prompt | ABSORB_IN_0_8 | A provider process whose working directory is the data directory is the wrong default once that directory is what isolation protects. It gets a directory of its own |
| 7.4, 7.6 | Compiled advice and program memory enter prompts without replacement of format characters or a trust label | ABSORB_IN_0_8 with 6.8 | One envelope for every piece of text that is not the user's |
| 14.8 (LOW row) | A resume landing after the orchestrator shut down can start a planner that ends crashed | ABSORB_IN_0_8 if the fault-injection suite reproduces it; otherwise it stays open | Recovery is a gate; a fault that cannot be produced is not fixed blind |
| 3.9, 10.7 | Advisory leases not capped at the reserve; routing records and checkpoints never pruned | DEFER_TO_0_9, measured in 0.8 | The soak measures database and event growth. If the growth is unbounded at the soak's scale, pruning becomes release-material and is done then |

## What this triage does not do

It does not reopen any finding the ledger closed, and it does not re-run the fourteen reviews. The absorbed
items are tracked in `docs/V0_8_PROGRESS.md` with the commit that closes each; an absorbed item still open at the
0.8 gate is named in the release report.
