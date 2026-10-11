# NEXUS 0.7.2 implementation progress

Status: PARTIAL. Updated 2026-10-11. Branch: `nexus-0.7.2-director-ui-compiler`. The verdict, what was
verified and what is missing are in docs/V0_7_2_RELEASE_REPORT.md; the sections below are the record of how
the work went and are not rewritten. The newest is at the end.

The user has requested continued implementation, not another checkpoint stop. No merge,
tag, push, parent-verdict change, or real Claude campaign is authorized. Real GPT acceptance
requires explicit confirmation that paid credits are disabled; selecting the Plus account
does not satisfy that requirement.

## Remaining work, in dependency order

1. Canonical compiler admission: Programs, Workspaces, queued engineering work, intent
   metadata and references, context references, stale checks, history and integration/E2E.
   Implemented: shared engine admission and scheduler starts; immutable metadata, canonical refs,
   inspector/history, resume snapshot binding and ordered amendments. Final breadth/E2E review remains.
2. Production Director orchestration and durable decisions, escalations and outcomes.
   In progress: production advisory routing, pinned Claude adapter and durable records are wired;
   real technical quality admission remains closed. Current changes are not yet a committed acceptance block.
3. Capacity and quality admission controlling actual dispatch, waits and recovery.
4. Complete UI 2.0 pass across all product surfaces.
5. Diagnose Windows security-fixture teardown and performance evaluator timeout; obtain
   assertion verdicts without weakening gates.
6. Complete official OpenAI authentication and usage lifecycle.
7. Final UI, responsive, keyboard, contrast and two independent UI review rounds.
8. Independent focused reviews of the thirteen requested areas; repair confirmed findings.
9. Bounded real GPT Director and STANDARD compiler acceptance after safe-state confirmation.
10. Stable-source full regression, build, package and production walkthrough.

## Starting evidence

Checkpoint commit `2048943b0b1b50b65576913235e7e0e39caf5bca` has a clean packaged
walkthrough receipt. Focused intelligence checks passed 318 tests. The prior full suite
and full Electron run were not final acceptance: security teardown and performance timeout
remain open, and a fresh full E2E run is required after final source changes.

## External dependencies

- Live GPT: explicit no-paid-overage confirmation pending. Offline implementation remains doable.
- Real Claude, Council, TECHNICAL compiler and cross-provider comparison: deliberately
  deferred until the user's reset and separate 0.7.1 closure.
- Parent 0.7.1 remains PARTIAL; no released PASS is possible until its separate gates close.

## Current admission implementation

Migration 14 stores immutable user goal/constraint/acceptance metadata, canonical context references,
entity admission and ordered amendment history. Programs, Workspace Missions/Programs, task additions,
task instructions, Mission/Program replans and criterion edits use the compiler. Internal milestones
inherit root provenance without recursive compilation. EXACT preserves raw text without model calls.
Legacy engineering recovery is guarded at the production orchestrator boundary; an explicit preview
can admit a paused Mission. Resume previews bind retained execution snapshots and accepted predecessor
results instead of an unrelated checkout. Same-task amendments are serialized and survive worker replacement.

Independent review findings repaired: duplicate workspace references, cross-workspace retrieval,
JSON escaping, initial task snapshot drift, legacy Mission recovery bypass, resume snapshot mismatch,
lost earlier instructions, and failed blocker resolution changing instruction history.

Evidence: broader focused validation passed 499 tests across 25 files. After the final snapshot-evidence
refinement, 84 intelligence tests across 13 files passed. Both typechecks, changed-file lint and the
development build passed. Six Electron scenarios passed on the current build: existing Mission/Director
admission, root/queue admission, user amendments, full internal Program execution and cross-repository
Workspace execution through verification and release preparation. The rendered inspector was inspected.
These are development checks,
not stable final-source release acceptance. No new package or live inference claim is made.

## Current Director/capacity implementation

After local admission commit `2c85abb`, migration 15 adds durable routing and Director decision,
escalation and outcome records. User-requested escalations persist without inference and require an
explicit request to invoke; dismissal is limited to unclaimed requests. Council keeps each stage and
unresolved disagreement. The production Director and Task Compiler use one advisory admission kernel.
Claude advice is pinned to its runtime and scoped quality evidence; worker review policy cannot redirect it.
The user-selected GPT primary policy is recorded separately from comparative fallback-quality evidence.
No real technical approval or live inference was granted by these changes.

The router enforces local session reserves, a separate exclusive OpenAI slot, durable claims and
per-call outcomes. Unknown plan allowance stays unknown. Explicit due GPT probes retain the adapter's
probe lease. Confirmed dead process-owned HTTP leases can be reclaimed after restart; hosted child
sessions stay quarantined until stop confirmation. Authoritative usage recovery updates Claude pools;
optimistic startup, account checks and wait expiry do not prove quota recovery.

Independent review found stale Claude recovery, excess OpenAI concurrency and permanent HTTP lease
quarantine; repairs and focused fake-provider integration scenarios now cover them. It also confirmed
that actual worker occupancy is not yet connected to these leases: global scheduler/worker admission,
provider-scoped waits, coherent provider handoff and recovery remain independently doable next work.
Development evidence: 409 tests across 21 intelligence, usage and IPC files passed. Node and renderer
type checks, lint and the development build passed. Five Electron scenarios passed on this build,
including saved escalation, explicit waiting advice, routing inspection and canonical workload admission.
The rendered escalation screen was inspected. Independent repair verification found no additional
confirmed material regression in these three repairs. This is not final stable-source acceptance.

## 2026-10-10: Claude takes over as reviewer and continuing engineer

Parent 0.7.1 is still PARTIAL; its real campaign is running. Nothing here is merged or tagged, and no parent
gate is closed by it. What follows was done on this branch while that campaign ran.

Handoff. The uncommitted worker-capacity work found after `522f898` was preserved unchanged as `3a86454`
(one type error and one failing test, both in its new test file; stop and recovery handling untested).

Independent review of that work found six defects, each fixed with a test or caught by an existing one:

| Defect | Effect | Fix |
| --- | --- | --- |
| Admission required per-call tool authorization of every candidate | Codex could never be admitted; "Claude unavailable, eligible Codex work continues" was unreachable | A provider is admissible when the NEXUS policy authorizes its tool calls or its own sandbox confines it (`6af22b1`) |
| Leases of hosted sessions were quarantined at boot with no way to release them | One crash under load left every later session waiting for capacity, for ever | Evidence-based reclamation: owner process and every worker process of that start gone, still so after 30 s; evidence saved per lease (`d26154b`) |
| The dispatch gate no longer applied the ramp after a usage reset | All sessions restarted at once after a reset | The ramp applies while Claude is available; while it is limited, admission decides per session (`1ecddb4`) |
| Admission skipped an account with no email or outside subscription mode | A scripted runtime, an account without an email and every API-key user had all work wait for ever (4 runtime-process tests paused) | The requested primary needs no identity; a stand-in does, because its evidence is bound to a profile (`828d211`) |
| A provider's quota or authentication refusal also raised a capacity wait | The run paused as `capacity`: no quota banner, no countdown, no automatic resume, no overnight shutdown (3 end-to-end tests) | A capacity wait is only for work never dispatched; the refusal pauses as before (`ec031e4`) |
| A provider the user chose for a role was treated as a stand-in | Cross-model review waited for quality evidence (1 end-to-end test) | The requested provider is primary (`ec031e4`) |

Regression failures named in the earlier checkpoint:

- Windows EPERM at teardown of the security corpus: an antivirus scanning the temp directory flagged the
  corpus files (their text is attack-shaped on purpose) and locked them. Fixed on the parent branch
  (`514a7ea`): the fixtures are built inside the checkout. It reaches this branch with the reconciliation;
  until then the two security test files are not run here.
- Performance evaluator at its 120 s limit: profiled. 108 s on the unoptimized fixture, spent re-timing runs
  that are seconds long and on one 28 s run judged "far too slow" only after it returned. Now about 40 s,
  with the ratio limit, the rounds and the verdicts unchanged (case version 4, `36da8ed`).

State of the checks on this branch at `ec031e4`: type checks and lint pass; unit and integration 178 files,
3,145 of 3,145 (the two security files excluded as said); the end-to-end run before the last fix was 30
passed, 4 failed, and the three files that held the failures then passed 15 of 15. A full end-to-end run on
final source is still owed.

Not yet reviewed by me: OpenAI authentication and storage, the Director and Council, the Task Compiler's
entry boundaries and snapshot consistency, instruction history, the UI. Not yet done: provider-scoped wait
state in the UI, crash tests on a real runtime process for worker admission, everything that needs real
providers.

## 2026-10-10, later: reconciliation with 0.7.1, twelve reviews, two rounds of fixes

0.7.1 was closed and tagged (`v0.7.1`, not pushed) and merged into this branch at `3fcd1e0`
(docs/V0_7_2_PARENT_RECONCILIATION.md). The suite on the merged tree: 182 files, 4,084 of 4,084.

Twelve of the fourteen independent reviews are done. Every finding, its severity and its state are in
docs/V0_7_2_REVIEW_FINDINGS.md: that file is the ledger, this section is the summary.

| Review | Verdict in one line |
| --- | --- |
| 1 OpenAI and sign-in correctness | Sound flow; one 401 latched the pool (fixed) |
| 2 OAuth and credential security | Sound; the data directory reached agent environments (fixed) |
| 3 Capacity accounting | Leases and pauses had four ways to be lost or to stick (fixed) |
| 4 Routing and failover | A capacity wait blocked Programs and Workspaces and looked like a stall (fixed); waiting is run-wide (limitation) |
| 5 Director architecture | Authority boundary sound; five MEDIUM on records and escalations (open) |
| 6 Task Compiler intent | CRITICAL: a rotated worker lost the user's instructions (fixed); replan notes were one slot (fixed) |
| 7 Compiler prompt injection | Agent notes reached the compiler unlabelled (fixed); READY rests on the model's own report (open, MEDIUM) |
| 8 Context Graph integration | Same agent-note defect; the planner section accepted as designed |
| 9 Token Intelligence regression | The request was unbounded in worker packs (fixed); advice in every pack and calls before planning (open) |
| 10 Privacy | No statement of what goes to OpenAI and no redaction (fixed); no switch per project (open) |
| 13 Test quality | Subsystems tested alone; kernel and orchestrator never met (fixed with scenarios); default AUTO path untested end to end (open) |
| 14 Scheduler and recovery | A wait cost an attempt, a dead worker leaked a slot, shutdown consumed attempts (fixed) |

Open and HIGH after the second round: the workspace half of 6.3, 9.2, 9.3 (no measurement), 10.1 (switch per
project), 13.2. Reviews 11 (UI/UX) and 12 (accessibility) wait for the UI work.

Not done, and needed for a verdict other than PARTIAL: real Claude Technical Director acceptance; real Council
and real Task Compiler acceptance (both need ChatGPT inference, which only the provider's own paid-credit
confirmation in the app may allow); Director outcome learning; the provider-scoped wait in the UI; UI 2.0 with
its two reviews; a full end-to-end, stress and package run on final source.

## 2026-10-10 and 2026-10-11: real acceptance, the rest of the brief, the real campaign

Done since the section above:

- Real acceptance of the Technical Director, the Strategic Director, a Council and the STANDARD and TECHNICAL
  depths of the Task Compiler, with the defects they showed fixed (R.1 to R.5 in the ledger).
- Director outcome learning (migration 16); the switch per project for OpenAI; the workspace planner on the
  admitted snapshot; UI 2.0 on the 0.7.2 screens, with both UI reviews and a second round on rendered pages;
  an automated accessibility check in the end-to-end tests.
- The default depth stopped every real request (R.8): the user now decides in the preview.
- A wait for a provider holds one task, not its mission (4.4, 4.6); capacity facts keep the time they were
  observed (3.5, partly).
- The real campaign of 0.7.1 on the 0.7.2 sources, in EXACT and in the default depth, against 0.7.1 as
  released. It showed the cost of the default depth (9.3) and two gaps in what a plan and a verifier are
  told (R.9, R.10), fixed in `be766d7`.
- Full suite, end-to-end, stress and the 1,000 seeds on the final source; the package.

Not done: forty MEDIUM findings are open or partly open. The release report lists the ones that bear on a
gate and what reaching PASS takes.
