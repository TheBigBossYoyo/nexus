### The real quality campaign: 0.7.0 against 0.7.1, eight task categories

Fifty real runs on the Claude subscription, 2026-10-10, each one a whole mission, program or workspace
mission from the request to the result. Evidence: one file per run in `docs/acceptance/campaign`; the gate's
answer in `docs/acceptance/campaign-gate.json`; tables by `node scripts/campaign-report.mjs`.

**Arms.** `070`: the sources of the tag `v0.7.0`, in their own checkout. `071`: the 0.7.1 sources with the
Context Graph off for agents. `071-graph`: the 0.7.1 sources with it on. One file
(`tests/manual/campaign/run.smoke.ts`) drives all three and refuses to run an arm on the wrong sources. It
measures through its own wrapper around the runtime and through tables both versions write, so the arms are
measured by one instrument.

**Held identical.** The starting repository of each task; the request; the models (the default role policy,
unchanged between the versions: `claude-opus-5-5` for planning, review and verification, `claude-sonnet-5-5`
for workers); the preset; one agent at a time; the permissions; the time budget; the hidden evaluation. No
approval request is ever granted: a run that asks is refused, as an unattended run would be, and the refusal
is counted.

**Tasks.** One per category, each a small repository with a request, knowledge NEXUS holds about it (approved
project memory, stored the same way by both versions), a hidden evaluation that is never in the repository,
and a reference solution. Without any model, a test proves for every task that its own tests pass as given,
that the hidden evaluation fails as given, and that it passes with the reference solution
(`tests/integration/campaign/tasks.test.ts`).

| # | Category | Task |
| --- | --- | --- |
| 1 | localized bugfix | laps out of order after the 16-bit packet counter wraps |
| 2 | cross-module bug | cart and invoice totals differ by a cent; both must follow one money rule |
| 3 | normal feature | a CSV export that follows the project's export conventions |
| 4 | refactor | one validation module for three handlers, behaviour and messages unchanged |
| 5 | architecture task | an exporter registry in place of a switch, with its decision record |
| 6 | security-sensitive task | a static file resolver that lets requests leave the served directory |
| 7 | Program-style task | a key-value store library in two milestones, through the Program engine |
| 8 | Workspace / cross-repository task | an optional field added to a contract in two repositories, through the Workspace engine |

**Stopping.** One run per cell first. A cell whose arms disagreed, or whose result looked like chance, was
repeated. The localized bug was the one mission where an arm failed (one graph run of four against none of
three): the rule was then fixed before any further run, six runs in every arm and no more, whatever came out.
It came out 5 of 6 in every arm.

#### Quality

Counts over the runs of each cell. "Completed" is the mission's own acceptance (its verifiers passed and
nothing was left blocked); "hidden" is the hidden evaluation on the result.

CAMPAIGN_QUALITY_TABLE

What the table does not show by itself:

- **No case is worse on 0.7.1.** There is no task where 0.7.0 passed its hidden evaluation and a 0.7.1 arm
  did not.
- **Security, all three arms:** the fix passed its verification and the hidden evaluation (9 of 9). The
  mission still paused, in every arm alike, because the planner added a security-review task that ended
  blocked. This is 0.7.0 behaviour, unchanged.
- **Workspace:** each blocked run failed at the consumer's contract-copy step after a refused approval.
- **Program on 0.7.0: 0 of 3.** One run was blocked at the plan (a milestone with more than eight acceptance
  criteria), two at the verification of the first milestone: the verifier wrote its judgment as a report in
  prose instead of the JSON object the engine reads. The prompts and the parser are the same in 0.7.1, where
  the first six runs failed the same way (`docs/acceptance/campaign-before-reasoning-fix`). This is a defect
  of the released 0.7.0 against the current model, found by this campaign. It is fixed in 0.7.1 (`5d58c46`:
  a read-only run a program reads names the shape of its answer and the runtime enforces it; saying what was
  wrong on a retry, `a8a2e24`, had not been enough). After the fix both 0.7.1 arms completed the program:
  two milestones planned, built, verified and accepted, hidden evaluation 8 of 8. So 0.7.1 is better here
  because of a bug fix, not because of context or tokens.
- **First-pass verification** differs between arms mostly through one thing: 47 approval requests were
  refused over the campaign. Of the 27 whose command was recorded, 17 were a worker or a debugger writing a
  file through the shell (`cat >> file <<EOF`) instead of the edit tool, and most of the others an agent
  restoring the old version of a file to show its new test failing before the fix. A refused write leaves
  the task undone, its verification fails, and a repair task finishes it. This happens in every arm; it is
  why a mission sometimes takes 8 sessions instead of 5. It is a finding about the product (an agent that
  writes through the shell asks for an approval an unattended run cannot give), not about context.
- **Reviewer findings:** none critical or high in any run of any arm.

#### Efficiency

Mean of the runs of each cell. Tokens are what the runtime reported. Compactions: none in any run (the
0.7.0 adapter cannot report one). Session rotations: none.

CAMPAIGN_EFFICIENCY_TABLE

CAMPAIGN_TOTALS

Read plainly:

- **0.7.1 with the graph off is 0.7.0** within the noise of these runs: turns -0.2%, all input +1.2%, wall
  clock +3.5% over the six mission categories. It saves nothing, as the earlier report said.
- **0.7.1 with the graph on used less** over the six mission categories: turns -16.1%, all input -7.5%,
  output -14.4%, wall clock -14.0%. The direction holds in four of the six categories (localized bug,
  cross-module bug, refactor, architecture) and not in two (feature, security), which have one run each.
  With one to six runs per cell this is a measured difference of this campaign, not a proven effect size.
- **The walk is gone.** One context tool call in all 16 graph runs (a workspace verifier opening the
  contract), against six in the single graph run of 2026-10-07.
- Program and Workspace totals compare unlike things: a run that is blocked early has done less work than
  one that finished. They are shown for completeness, not as a cost comparison.
- Usage: the weekly window went from 1% to 8% over the fifty runs and everything else done that day.

#### The gate

Every run is a trial; runs of one task in one arm are repetitions of one case; each 0.7.1 arm is compared
with 0.7.0 over the eight cases (`tests/integration/campaign/gate.test.ts`).

| Comparison | Verdict | Pass rate | Regressions | Improvements |
| --- | --- | --- | --- | --- |
| 0.7.0 → 0.7.1, graph off | NON_INFERIOR | 67% → 79% | none | program |
| 0.7.0 → 0.7.1, graph on | NON_INFERIOR | 67% → 85% | none | program, workspace |

Judged by the hidden evaluation alone the rates are 79% → 92% and 79% → 98%, with the same verdicts.

The gate itself had a defect, and the campaign found it. For the first comparison it answered INFERIOR while
listing no regression and one improvement: one case going from failing to passing among seven equal ones
gives a lower bound of -8.1 points on the spread of that improvement alone. A variant that is worse on no
case cannot be inferior. The bound is now asked only when some case is worse (`quality-gate.ts`, with a test
that the same spread with one case worse is still refused). Both readings are recorded here; the verdicts in
the table are the corrected gate's.

**Consequence.** The Context Graph is non-inferior in quality and is the only variant that lowers cost. It is
on for agents by default from this release (`AUTO_DEFAULTS.contextGraph`); `off` remains a setting.
