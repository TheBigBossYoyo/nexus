# NEXUS 0.7.2 release report

Verdict: **PARTIAL**, 2026-10-11. Not merged, not tagged, nothing pushed.

Branch `nexus-0.7.2-director-ui-compiler`. Parent: NEXUS 0.7.1 (`main` at `dbe38e9`, tag `v0.7.1`), merged into
this branch at `3fcd1e0` (docs/V0_7_2_PARENT_RECONCILIATION.md). Package identity `0.7.2-development`.

The work was started by Codex and taken over at its checkpoint `522f898`. Nothing of it was discarded. It was
reviewed independently, area by area, and continued. Every finding, its severity and its state are in
docs/V0_7_2_REVIEW_FINDINGS.md; this report states what the release is, what was verified and how, and why the
verdict is not PASS.

## Why PARTIAL

Everything the release set out to build is built, the real acceptance passed, and the checks are green on the
final source, with one of them completed one commit earlier (see "Checks on final source"). The verdict is PARTIAL for one reason, with one thing to know beside it.

1. **Forty MEDIUM findings are open or partly open.** The brief asks for every material MEDIUM to be fixed.
   The CRITICAL and thirty-two of the thirty-three HIGH findings are fixed; the MEDIUM findings were fixed where
   they touched a release claim directly, and the rest were not reached. Some of them are material. The ones
   that bear on a gate:
   - *Truthful usage telemetry.* After a switch of Claude account, the limits observed for one account can be
     written to the other's pool (3.4). A retry time from local policy is stored as reported by the provider,
     and a concurrent observation can be overwritten by an older copy (the open half of 3.5). What the compiler
     and the Directors spend is kept as receipts and appears nowhere on the Usage page (9.5).
   - *ChatGPT connection.* A local failure (an answer that is not JSON, an oversize request, a network error
     during a refresh) is recorded as a failure of the provider's capacity, with a backoff of five minutes to
     six hours (1.2). Errors are classified coarsely (1.5). A pending sign-in cannot be cancelled (1.3); a
     storage fault cannot be recovered inside the application (1.4); a model removed from the catalog is still
     sent (1.6).
   - *Instruction history.* An amendment is recorded before the action takes effect, so a refused action
     leaves an instruction that never applied (6.7). Accepted text is cut later without notice in three places
     (6.6).
   - *Accessibility.* Focus is not moved on navigation (12.9); controls that a view disables while it works
     drop the focus (12.4); toasts expire with no history (12.10).
   The full list is the ledger's; each row says what is open.
2. **The default depth costs more Claude usage than 0.7.1, and this is measured, not fixed.** Finding 9.3
   (HIGH) said nothing measured the cost. It is measured now: a mission admitted in the default depth used
   18% more turns and 18% more input than the same mission on 0.7.1, with the same quality. Admitted in EXACT
   depth it costs what 0.7.1 costs. The release claims no saving, so the finding contradicts no claim; it stays
   open as a cost a user should know, and it is stated on this page.

Not verified by hand in this session: the installer was built and its packaged application checked by script;
nobody walked through the installation.

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
  start until the user has decided, in the preview, what to keep. Every user entry point goes through it
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
all: 1 CRITICAL, 33 HIGH, 59 MEDIUM and 40 LOW findings. The CRITICAL is fixed. Thirty-two HIGH are fixed and
one (9.3) is measured and stated above. Nineteen MEDIUM are fixed. Each fix has a test unless its row in the
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
depth each request was first compiled with real ChatGPT. Baseline: 0.7.1 with the Context Graph, as released.
Evidence: one file per run in docs/acceptance/campaign, the specifications of the default-depth arm in
`specs-072`, the gate's answer in `campaign-gate-072.json`. `pnpm exec node scripts/campaign-report.mjs` with
`NEXUS_CAMPAIGN_ARMS=071-graph,072,072-auto` prints every cell.

Two arms: **EXACT**, where the request is admitted as written and no strategic provider is called, and
**default depth**, where AUTO chose the depth (four requests STANDARD, one TECHNICAL, one COUNCIL) and the
additions were dropped by the unattended decision "my request only" where a decision was asked for.

Six mission categories (localized bug, cross-module bug, feature, refactor, architecture, security), sum of
the cell means:

| Arm | Runs | Completed | Hidden evaluation passed | Turns | All input | Output | Wall time |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: |
| 0.7.1 with the Context Graph | 13 | 11 of 13 | 12 of 13 | 270 | baseline | baseline | 1,282 s |
| 0.7.2, EXACT | 22 | 18 of 22 | 21 of 22 | 283 (+4.7%) | +2.6% | +6.7% | 1,394 s (+8.7%) |
| 0.7.2, default depth | 12 | 10 of 12 | 12 of 12 | 319 (+18.0%) | +18.3% | +12.5% | 1,464 s (+14.2%) |

Program and Workspace, EXACT only:

| Cell | 0.7.1 with the Context Graph | 0.7.2, before `be766d7` | 0.7.2, on `be766d7` |
| --- | --- | --- | --- |
| Program | 1 of 1 completed (2 of 2 with the run of the graph-off arm) | 0 of 3 | 5 of 5, hidden evaluation passed |
| Workspace | 2 of 2 | 2 of 2 | 1 of 1 |

The quality gate of 0.7.1 (`evaluateGate`, the same code), on the eight categories against 0.7.1 with the
Context Graph:

| Comparison | Verdict | Pass rate | Worse | Better |
| --- | --- | --- | --- | --- |
| 0.7.2 EXACT, every run | INFERIOR | 85% to 81% | program | localized-bug |
| 0.7.2 EXACT, the 15 runs on the final source `be766d7` | NON_INFERIOR | 85% to 84% | localized-bug | none |
| 0.7.2 default depth | INSUFFICIENT_EVIDENCE: program and workspace were not run in it | 81% to 83% over six | none | localized-bug |

The first line is INFERIOR on account of the three program runs before the fix described below. They stay in
the evidence and in that line.

What this says:

- **Quality held.** Every hidden evaluation of the default-depth arm passed, and the EXACT arm failed one, in
  the cell where 0.7.1 also failed one of six, with the same two tasks failed (on 0.7.2 the repair could not
  delete a scratch directory it had made, and reported the task failed for that alone). The security
  cell ends paused in every arm of every version, with its hidden evaluation passed: the planner adds a review
  task whose reviewer reports a finding nobody is there to answer.
- **EXACT costs what 0.7.1 costs**, within the noise of these runs.
- **The default depth costs about 18% more.** The specification adds text to the planner's prompt, and the
  planner writes more tasks and criteria from it. Before the mission starts, a compilation took 19 to 24
  seconds and two ChatGPT calls for STANDARD (about 800 input tokens on the compiler's call), 53 seconds for
  TECHNICAL and 106 seconds for COUNCIL. With two runs per cell the figure is an estimate: one cell alone
  ranged from 31 to 68 turns between identical runs.
- **Workspace: three of three completed**, hidden evaluations passed.

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
shown with a task say whose they are. On that commit the program cell completed five of five with the hidden
evaluation passed, in 76 to 88 turns against 98 and 105 on 0.7.1. Five runs are not proof that it cannot
recur; they are what was measured.

The runs of the EXACT arm are on three commits (`6404450`, `ca43de4`, `be766d7`); the default-depth arm is on
`ca43de4`, before the two sentences of `be766d7`, and was not run again after them. Each file names its commit.

## Checks on final source

The final source is `be766d7`; the commits after it change documents, evidence and the campaign gate's test.

| Check | Result |
| --- | --- |
| Typecheck, lint | Clean |
| Full suite (`pnpm test`) | 191 files, 4,139 tests, all passed |
| End-to-end (`pnpm test:e2e`, with the visual captures and the accessibility check) | 35 passed, 0 failed, 3 skipped (the capture specs that run on request) |
| Stress, default (`pnpm stress`) | 11 files, 14 tests passed, 1 skipped |
| Stress, 1,000 orchestrator seeds | Passed on `ca43de4` (6,654 s) and before that on `8198028`. **Not completed on `be766d7`**: the run was started and was stopped by the machine for lack of memory while this session was idle; it was not started again. `be766d7` differs from `ca43de4` by two sentences in prompts and one test file, none of which the stress reads |
| Package | PACKAGE_LINE |

Logs of these runs are under `test-results/v072` (`*-final4.log`, and `stress-1000-final3.log` for the seeds).

## What is not claimed

- No token saving for 0.7.2. In the default depth it uses more than 0.7.1; the figure is above.
- No multi-provider failover of workers: a worker session moves to another provider only where the user chose
  that provider for the role, or on recorded quality evidence, and this version records none.
- No knowledge of ChatGPT allowance or reset time: both are shown as unknown.
- No accessibility conformance: an automated check runs on every page in both themes and the findings of two
  review rounds were fixed where listed; no screen reader was used.
- A mission's sessions that belong to no task (planning, the final verification) and speculative candidates
  still wait for capacity as a whole mission.

## To reach PASS

1. Go through the open MEDIUM findings: fix the material ones, starting with those listed under "Why PARTIAL",
   and record a decision for each of the others.
2. Decide what the default depth should be, knowing its cost: keep AUTO and say so in the composer, or make
   EXACT the default and AUTO a choice.
3. Walk through the installer once by hand.
4. Run the program and workspace cells in the default depth, which the gate has no evidence for, and the
   checks again on the final source, the 1,000 seeds among them.

A first fix of the list in 1 is on the branch `nexus-0.7.2-medium-fixes` (finding 1.2: a ChatGPT request that
ended without an answer about capacity no longer plans a backoff). Its own tests pass; it has not been through
the full suite, the end-to-end tests or the stress, and it is not merged into the release branch.
