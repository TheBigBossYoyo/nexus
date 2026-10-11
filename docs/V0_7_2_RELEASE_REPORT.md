# NEXUS 0.7.2 release report

Verdict: **PASS**, 2026-10-11. Merged into `main` with a merge commit and tagged `v0.7.2`, locally. Nothing pushed.

Branch `nexus-0.7.2-director-ui-compiler`. Parent: NEXUS 0.7.1 (`main` at `dbe38e9`, tag `v0.7.1`), merged into
this branch at `3fcd1e0` (docs/V0_7_2_PARENT_RECONCILIATION.md). Final source: `be46477`.

The work was started by Codex and taken over at its checkpoint `522f898`. Nothing of it was discarded. It was
reviewed independently, area by area, and continued. Every finding, its severity and its state are in
docs/V0_7_2_REVIEW_FINDINGS.md; this report states what the release is, what was verified and how, and what
the verdict rests on.

## What the verdict rests on

| Condition | State |
| --- | --- |
| Release-material MEDIUM findings open | **0** of 40 triaged (below) |
| CRITICAL or HIGH open | None. 1 CRITICAL and 33 HIGH fixed; for 9.3 the cause is fixed and the effect measured again on the final source |
| Full suite on the final source | 196 files, 4,197 tests, all passed |
| End-to-end on the final source, with the visual baselines and the accessibility check | 35 passed, 0 failed, 3 skipped (the capture specs that run on request) |
| Stress on the final source | Passed: every stress file, with the new seeded stress of the compiler, the Director, the registry, the kernel and the depth policy |
| 1,000 orchestrator seeds on the final source | Passed: seeds 1 to 1,000, the same seeds and assertions as one run, in batches |
| Package and unpacked walkthrough | Built from a clean tree; every check of the packaged application true |
| Quality against 0.7.1, final-source runs, EXACT | NON_INFERIOR over eight categories, 23 runs: pass rate 85% to 91% |
| Quality against 0.7.1, default depth | INSUFFICIENT_EVIDENCE, kept: Program and Workspace were not run in it. No hidden evaluation failed in 18 runs |
| Provider and security boundaries claimed | Each has a test named in "What was found and fixed" and in the triage |

Every condition holds on the final source. What stays open is recorded and none of it bears on a boundary
this release claims: fourteen MEDIUM and thirty-five LOW findings deferred to 0.7.3, the comparative quality
of the default depth, and a run of the installer by hand.

## MEDIUM findings

Forty MEDIUM findings were open or partly open on `be766d7`. Each has one final disposition, in the table
"MEDIUM triage" of the ledger, with its impact, whether it can be reproduced, the commit and the test.

| Disposition | Count | Which |
| --- | ---: | --- |
| Release-material, fixed | 22 | 1.2 to 1.6 (ChatGPT connection and capacity), 3.4 to 3.6 (quota truth and leases), 6.6, 6.7 (intent), 7.2 (additions of consequence), 8.3 (the Context Graph switch), 9.5 (advisory use on the Usage page), 14.7 (recovery), 5.3, 11.7 (wording that claimed more than is true), 12.4, 12.7, 12.9, 12.10 (keyboard, focus and errors on critical paths), 13.3, 13.4 (tests of admission and of the paid-credit rule) |
| Superseded or duplicate | 2 | 5.4 (fixed earlier with R.3), 6.9 (same as 7.2; the confirmation exists since the decision in the preview) |
| Not reproducible | 2 | 14.8 (0 of 6 full runs since a likely cause was removed), 8.5 (the write it names is one synchronous pass) |
| Deferred to 0.7.3, with the reason in its row | 14 | 4.3, 6.5, 6.8, 5.5, 8.4, 9.4, 9.6, 10.4, 13.5, 11.5, 11.8, 11.9, U2.3, U2.4: labels, layout and density; duplicated text in prompts (a cost); a count of sessions; an unreachable routing field; inspection and deletion of what was sent; further test pairs |
| **Release-material and open** | **0** | |

Nothing was relabelled to get there: a finding was deferred only where no boundary this release claims depends
on it, and its row says why. Two were found while fixing and fixed with the rest: a ring drawn around the whole
page by the focus fix, and a type error in a new test.

## What 0.7.2 is

- **Sign in with ChatGPT.** The official flow (dynamic registration, loopback callback, PKCE, state and nonce,
  identity validation), credentials in protected storage, rotating refresh. A token the provider refuses is
  refreshed once and the request sent once more before a sign-in is asked for.
- **Strategic Director, Technical Director, Council.** Advice only: nothing a Director writes can start work,
  change a policy or grant a permission. The strategic role is ChatGPT's, the technical role Claude's, through
  a session with no tool, no project and no settings. A Council is a memo, an independent challenge and a
  synthesis, each saved before the next call; an interrupted request is never replayed by itself.
- **Task Compiler.** A request is admitted as a specification before work starts: the request as written is its
  root, what a model adds is marked with where it came from, and a question that changes the outcome stops the
  start until the user has decided, in the preview, what to keep. In the default depth, AUTO, the compiler
  gives a request the least depth that is enough for it (docs/PROVIDERS.md, "The depth AUTO chooses"): none
  for a localized request that says exactly what is wanted, a council only for a broad change to something
  sensitive. An addition of consequence (a new dependency, a secret touched, verification weakened, data sent
  outside, history rewritten) stops for the user whatever the model reports. Every user entry point goes through it
  (missions, overnight, programs, workspaces, task additions and instructions, replans, criterion changes).
- **Capacity admission.** Every agent session is decided, claimed and released by one kernel: a durable
  decision before the dispatch, a slot kept until the stop is confirmed, a wait that costs no attempt, and a
  recovery that resumes what waited. A task whose session finds no provider is held alone while the rest of
  its mission goes on; the mission waits only when nothing else of it can. The record of a wait names the
  provider, the reasons and, per candidate provider, its reset time where the provider gave one.
- **Director outcome learning.** What became of a mission is recorded once when it ends, with the advice it was
  admitted with: verified or not, failed tasks, repair cycles. It is shown with the decision. The counts are
  evidence to read, not a score that routes anything.
- **What goes to OpenAI is stated** where the user connects, in the composer and in docs/PROVIDERS.md. The
  connection's switch is what allows any sending, and a project can be kept away from OpenAI on its own.
- **UI 2.0** on every view, reviewed twice: once on the code and once on rendered pages in both themes and two
  sizes.

## What was found and fixed

Fourteen independent reviews (the two of the UI in two rounds), the real acceptance and the real campaign. In
all: 1 CRITICAL, 33 HIGH, 59 MEDIUM and 40 LOW findings. The CRITICAL and every HIGH are fixed. Forty-one MEDIUM are fixed;
the others have a disposition each (see "MEDIUM findings"). Each fix has a test unless its row in the
ledger says otherwise. The ones that mattered most:

| Finding | Effect before the fix |
| --- | --- |
| A rotated, repaired, reviewed or verified session lost the user's later instructions (CRITICAL) | Work continued against the first request only |
| The Technical Director could never be admitted | Every Technical Director request, every Council and every TECHNICAL or COUNCIL compilation waited for ever; the tests granted themselves the evidence production never writes |
| The strategic provider's real answers were refused | Valid JSON of a slightly different shape failed every compilation that had an ambiguity; the shape is now enforced by the provider |
| The default depth stopped every real request | Six campaign requests of six came back needing a decision, and the only way to decide was to rewrite the request; the user now decides in the preview, and both instructions say what a question is for |
| One evidence reference outside the scope discarded a whole paid compilation | The reference is removed and the specification says so |
| A capacity wait blocked Programs and Workspaces, consumed task attempts and looked like a stall | A wait is a wait everywhere, and it holds one task, not its mission |
| A dead worker kept its slot until restart; a shutdown spent task attempts | Slots are released on confirmed exit; admission closes after the orchestrator has stopped its sessions |
| Notes written by agents reached the compiler as unlabelled evidence | They are left out; the rest carries its trust; credentials are taken out |
| No statement of what goes to OpenAI, and no way to keep one project away from it | Stated where the user connects; a switch per project |
| The mission planner and the workspace planner read the user's checkout, not the commit the run executes | Each reads a snapshot at the admitted commit |
| A plan could ask a read-only task for what its role may not run | See "The program cell" below |

One decision taken as reviewer and recorded in the ledger: the planner's graph section keeps showing agent
notes, labelled as unverified (8.2), because the saving measured for 0.7.1 came from it.

## Real acceptance

On 2026-10-10. Evidence files are in docs/acceptance; none holds an account identity.

| What | Result | Evidence |
| --- | --- | --- |
| Technical Director alone, real Claude runtime, production routing | PASS: one session, no tool offered and none used although the objective asked for a file to be read and tests to be run, working directory outside the project, memo validated, slot released, execution not authorized | `technical-director-2026-10-10T19-02-28-138Z.json` |
| STANDARD compilation, real ChatGPT | PASS: request unchanged, 6 recommendations with provenance, stopped for a decision on a real ambiguity | `v72-live-2026-10-10T19-47-04-306Z.json` |
| TECHNICAL compilation, real ChatGPT and Claude | PASS: strategic pass, challenge by Claude, drift check; 22 recommendations; stopped for a decision | same file |
| Strategic Director, real ChatGPT | PASS | `v72-live-2026-10-10T19-48-40-838Z.json` |
| Council, real ChatGPT and Claude | PASS: memo, challenge, synthesis; 14 disagreements kept; execution not authorized; usage on record per stage | same file |

ChatGPT inference was used only while the application itself reported the connection signed in, a model chosen
and the paid-credit confirmation switched on by the user. The scripts read that and never change it. The
earlier `v72-live` files of the day are the failed runs that showed four of the defects above.

## Real campaign against 0.7.1

The campaign of 0.7.1 (docs/V0_7_1_RELEASE_REPORT.md), with its harness, tasks and hidden evaluations, run on
the 0.7.2 sources on 2026-10-10 and 2026-10-11. Real Claude agents carried out every mission; in the default
depth each request was first compiled by the built application with real ChatGPT. Baseline: 0.7.1 with the
Context Graph, as released. Evidence: one file per run in docs/acceptance/campaign, each naming its commit; the
specifications of the default depth in `specs-072` (the policy before) and `specs-072-depth2` (the policy now);
the gate's answer in `campaign-gate-072.json`.

Two views are kept apart. **Every development run** is the engineering history: nothing is removed from it,
the three program runs that paused before the fix among them. **The final-source runs** are those made on
`be766d7` or later, the commit that told a plan what a read-only task can run; the line is drawn at that fix by
the commits before it (`6404450`, `ca43de4`), not by any score. The candidate is judged by the second view.

Six mission categories (localized bug, cross-module bug, feature, refactor, architecture, security), sum of
the cell means, against the thirteen runs of the baseline (11 of 13 completed, 12 of 13 hidden evaluations
passed, 270 turns):

| Arm | View | Runs | Completed | Hidden evaluation passed | Turns | All input | Output |
| --- | --- | ---: | --- | --- | ---: | ---: | ---: |
| EXACT | every development run | 28 | 24 of 28 | 27 of 28 | 292 (+8.1%) | +5.9% | +8.9% |
| EXACT | final source | 15 | 13 of 15 | 14 of 15 | 296 (+9.6%) | +10.8% | +14.1% |
| Default depth | every development run | 18 | 15 of 18 | 18 of 18 | 296 (+9.6%) | +9.6% | +7.6% |
| Default depth, the policy before | twelve runs on `ca43de4` | 12 | 10 of 12 | 12 of 12 | 319 (+18.0%) | +18.3% | +12.5% |
| Default depth, the policy now | final source | 6 | 5 of 6 | 6 of 6 | 251 (-7.0%) | -7.7% | -2.3% |

Program and Workspace, EXACT:

| Cell | 0.7.1 with the Context Graph | 0.7.2 before `be766d7` | 0.7.2 final source |
| --- | --- | --- | --- |
| Program | 1 of 1 completed (2 of 2 with the run of the graph-off arm), 98 turns | 0 of 3 | 6 of 6, hidden evaluation passed, 76 to 92 turns |
| Workspace | 2 of 2, 95 and 126 turns | 2 of 2 | 2 of 2, 88 and 88 turns |

The quality gate of 0.7.1 (`evaluateGate`, the same code), over the eight categories, each case the mean of
its runs, against 0.7.1 with the Context Graph:

| Comparison | View | Verdict | Pass rate | Worse | Better | Turns / input |
| --- | --- | --- | --- | --- | --- | --- |
| EXACT | every development run (41 runs) | INFERIOR | 85% to 85% | program | localized-bug, security | -5.0% / -4.3% |
| EXACT | final source (23 runs) | **NON_INFERIOR** | 85% to 91% | localized-bug | security | -2.6% / +1.3% |
| Default depth | every development run | INSUFFICIENT_EVIDENCE | 81% to 83% over six | none | localized-bug | +9.6% / +9.6% |
| Default depth | final source | INSUFFICIENT_EVIDENCE | 81% to 83% over six | none | localized-bug | -7.0% / -7.7% |

The first line is INFERIOR on account of the three program runs before the fix. They stay in the evidence and
in that line. The one case the final source is worse in is the localized bug: one of five runs failed there
(a repair that could not delete a scratch directory, finding R.11), where the baseline failed one of six.

How far to trust the cost figures: one cell ran between 31 and 70 turns in identical runs. Over the six
mission categories EXACT reads 8 to 10% above the baseline; with Program and Workspace, which now take fewer
turns, the gate's figure is 3% below in turns and 1% above in input. The six EXACT runs made on the last
commit, while the 1,000-seed stress was running on the same machine, were the highest of all. EXACT is taken
to cost what 0.7.1 costs within that spread; no figure here is precise to a few percent.

What this says:

- **EXACT: quality held.** The gate on the final-source runs is NON_INFERIOR, with a higher pass rate than the
  baseline (91% against 85%): every run of the last repetition completed, the security cell among them for
  the first time in any arm. Cost is level within the spread described above.
- **Default depth: product default, and no longer the expensive one in what was observed.** Under the policy
  before (five words decided the depth) it used 18% more turns and input than 0.7.1 over twelve runs. Under the
  policy now, the same six requests were compiled LIGHT twice, STANDARD three times and TECHNICAL once (before:
  STANDARD four times, TECHNICAL, COUNCIL), and the six runs used 7% fewer turns and 8% less input than the 0.7.1 baseline. That
  is one run per cell, where identical runs of one cell have differed by a factor of two: it shows the policy is
  not more expensive on these requests and proves no saving. None is claimed.
- **Default depth, quality: no hidden evaluation failed** in eighteen runs under the two policies. Compared with
  0.7.1 the gate says INSUFFICIENT_EVIDENCE: Program and Workspace cannot be admitted in a depth other than
  EXACT by the harness, and that was not extended. The label stays; AUTO is the default because it is the
  intended experience and its routing is conservative, not because it was shown to be better.
- **Workspace** completed every run. The **security** cell usually ends paused, in every arm of both versions,
  with its hidden evaluation passed: the planner adds a review task whose reviewer reports a finding nobody is
  there to answer. It completed once, in the last EXACT repetition.

### The program cell

The first three runs of the program cell on 0.7.2 paused, where 0.7.1 had completed two of two. The cause was
read from the database of a fourth run while it ran: the mission planner asked its verifier task to probe the
new module with a `node -e` one-off, which the verifier role may not run; the verifier reported a blocker, the
mission paused for intervention and the program with it until its 90 minute budget ended.

No change of 0.7.2 explains it: the planner and the verifier are told the same as in 0.7.1, by the same models.
A control run on the 0.7.1 sources the same night also paused, differently: a task's verifier failed a finished
task on mission criteria that only a later task could meet
(`program__071-graph__control-observed-2026-10-11T04-28-10Z.json`; read from its database and stopped by hand,
so it is an observation and is in no total). Both are gaps in what a plan and a verifier are told, present in
0.7.1, and both are closed in `be766d7`: a planner is told what a read-only task can run, and mission criteria
shown with a task say whose they are. From that commit on the program cell completed six of six with the hidden
evaluation passed, in 76 to 92 turns against 98 and 105 on 0.7.1. Six runs are not proof that it cannot
recur; they are what was measured. The instruction is to a model: the structural form, a contract of what
each role can run that planning reads, is recorded as deferred hardening (VerifierCapabilityContract).

The runs of the EXACT arm are on four commits (`6404450`, `ca43de4`, `be766d7`, `91fa759`) and those of the
default depth on two (`ca43de4` under the policy before, `91fa759` under the policy now). Each file names its
commit. `91fa759` is the release source but for its version string.

### A repair that could not clean up

One run of the localized-bug cell failed because a repair session could not delete a scratch directory it
had made. Nothing held the directory: no handle, watcher or scanner. Its three deletions were classified high
risk and asked for approval, and the campaign refuses every approval by design; the run's record shows three
requests and three refusals. With a user present the deletion is approved. It is the same class as the
program cell, a plan that asked for evidence its sessions could not produce within what they are allowed,
and is covered by the same deferred hardening. The same cell failed once in six on 0.7.1.

## Checks on final source

Final source `be46477`; any commit after it changes documents and evidence only. No check is carried over
from an earlier commit.

| Check | Result |
| --- | --- |
| Typecheck, lint | Clean |
| Full suite (`pnpm test`) | 196 files, 4,197 tests, all passed. It holds the security corpus (`tests/integration/security`), the Arena suites, and the Program, Workspace, Overnight, scheduler and recovery tests |
| End-to-end (`pnpm test:e2e`) | 35 passed, 0 failed, 3 skipped (capture specs that run on request). It holds the eleven visual baselines and the accessibility check of every page in both themes, with keyboard order, names, states and contrast |
| Stress (`pnpm stress`, every file but the orchestrator seeds) | 11 files, 18 tests passed, 1 skipped: Arena, Context Graph, control plane and its runtime (scheduling and recovery), Overnight and its workloads, policy, Program, usage, Workspace, and the new `intelligence-stress` (Task Compiler, Director gateway, ChatGPT capacity registry, capacity kernel, depth policy; 300 seeds each) |
| 1,000 orchestrator seeds | Passed. Seeds 1 to 1,000 with the test's own switches (`NEXUS_STRESS_START`, `NEXUS_STRESS_RUNS`), the same seeds and assertions as one run, in batches of 250 and 125 so that each batch gives its memory back. Test processes stayed near 0.7 GB together |
| Package | `release/v0.7.2/NEXUS-Setup-0.7.2.exe`, 208,194,604 bytes, built from `4c75a98` (the release source with its documents) on a clean tree. The unpacked application was started and walked through by `scripts/v72-packaged-check.mjs`: identity (version 0.7.2, that commit, not dirty, schema 16), runtime ready with its endpoint restricted, a worker started (claude and codex), a project opened, every page rendered, no mission and no overnight run left, signed out of ChatGPT, no renderer error: all true. The installer itself was not run |

How the seeds were obtained, because it took more than one attempt. On `91fa759`, which is this source but
for its version string, all 1,000 passed in one go. On `be46477`, seeds 1 to 750 passed at the first attempt.
Seeds 751 to 1,000 failed three times, each time with one or a few seeds reporting "did not settle: timed out
waiting for a final run state", and each time while another heavy run shared the machine: once on battery
power with the suite and the end-to-end tests running, once beside the suite (seed 967), once beside the
end-to-end tests (seed 894). Seed 967 replayed alone passed three times of three. Run with nothing beside
them, seeds 751 to 1,000 passed. The failing seeds are kept under `test-results/stress-failures`. No assertion
and no timeout was changed. What this says about the test: its time limit for a mission to settle is short
enough to be missed on a starved machine; that is a property of the test under load and is recorded as a
LOW finding (R.13), not excused. The suite and the end-to-end tests showed the same sensitivity (a timing
assertion of an Arena case, a refused access to a temporary git file, two closed pages) and passed when run
alone; those runs are the ones reported above.

Logs: `test-results/v072` (`suite-final11.log`, `e2e-final12.log`, `stress-final7.log`,
`stress-1000-final7-from-1.log`, `-from-251.log`, `stress-1000-final8-from-501.log`,
`stress-1000-final13-from-751.log`, `-from-876.log`).

## What is not claimed

- No token saving for 0.7.2, in either depth.
- That AUTO is better than EXACT or than 0.7.1: quality in the default depth is INSUFFICIENT_EVIDENCE against
  0.7.1, with no hidden evaluation failed.
- No multi-provider failover of workers: a worker session moves to another provider only where the user chose
  that provider for the role, or on recorded quality evidence, and this version records none.
- No knowledge of ChatGPT allowance or reset time: both are shown as unknown. What the compiler and the
  Directors used is shown as the tokens the provider reported, a measure of the work and not a share of a plan.
- No accessibility conformance: an automated check runs on every page in both themes and the findings of two
  review rounds were fixed where listed; no screen reader was used.
- A mission's sessions that belong to no task (planning, the final verification) and speculative candidates
  still wait for capacity as a whole mission.
- A change of Claude account made while the application was closed is not noticed by the binding of
  observations to an account (3.4).
- The installer was built and its unpacked application walked through by script; the installer itself was not
  run.

## After this release

Deferred to 0.7.3, each recorded in the ledger: the fourteen MEDIUM findings above; the LOW findings; a
VerifierCapabilityContract, so that planning reads what each role can run instead of being told in a prompt; a
campaign arm of its own for the depth policy, with Program and Workspace admitted in a depth other than EXACT;
a run of the installer by hand.
