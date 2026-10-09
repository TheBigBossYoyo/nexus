# NEXUS 0.7.2 implementation progress

Status: PARTIAL. Updated 2026-10-09. Branch: `nexus-0.7.2-director-ui-compiler`.

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
