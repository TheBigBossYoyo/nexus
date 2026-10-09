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
