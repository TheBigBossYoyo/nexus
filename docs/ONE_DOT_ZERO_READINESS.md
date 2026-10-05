# NEXUS 1.0 Readiness

Date: 2026-10-05, at the end of the unattended release train of 2026-10-04 to 2026-10-05. No `v1.0.0` tag, no
release candidate tag and no release candidate branch was created.

## Executive Verdict

**NOT READY FOR RC.**

In order of weight:

1. **0.7 is not done.** The persistent runtime, the client and runtime boundary and the worker manager do not
   exist (`V0_7_RELEASE_REPORT.md`). 1.0 is defined on top of them.
2. **The agent boundary is application code, not an operating-system boundary.** The security review of this
   night found HIGH defects in boundaries that had been in every release. Four were fixed. One cannot be fixed
   in the classifier: a writing agent can write a script and run it, and that script can do what the user can
   do, `shutdown` and `shutdown /a` included.
3. **The reliability campaign found defects in released versions at 5000 histories that 1000 had not found,**
   and the first full end-to-end run of 0.7 found a defect that would have paused every resumed run. All are
   fixed. They say the depth of validation still had something to find.
4. **There is no evidence that NEXUS is better than plain Claude.** The comparison that was started did not finish, and the earlier data is six trials.
5. **Real-runtime evidence is thin and recent.** Every real run of 0.4, 0.5 and 0.6 was one small task on
   disposable repositories, made within hours of the code being written. Nothing ran for hours, no real usage
   limit was ever met, the installer was never executed, and NEXUS never completed a real overnight shutdown of
   its own (the shutdown of this night is done by the development supervisor, which uses the same power
   controller).

## Highest completed release

**0.6.0** (`v0.6.0`, `main` at `0a2874f`). Released tonight: 0.3.0, 0.4.0, 0.5.0, 0.6.0, each with a release
report. 0.7 is PARTIAL on the branch `nexus-0.7`.

## Reliability

Deterministic seeded simulations with scripted runtimes; no Claude usage. Run on the 0.7 code.

| Area | Asked | Run | Result |
|---|---|---|---|
| Scheduler | 10,000 | 10,000 seeded queues through `allocate` | passed |
| Program | 5,000 | 5,000 | **1 failure (seed 1552), a real defect of 0.4.0, fixed; 5,000 passed after the fix** |
| Workspace | 5,000 | 5,000 | passed |
| Usage | 5,000 | 5,000 | passed |
| Control Plane | 5,000 | 5,000 histories of 60 steps, twice (before and after the gate fix) | passed; a deliberate fault in the capacity rule was caught within 5 seeds |
| Overnight (power) | not asked | 2 x 5,000 | **4 failures, one real defect since 0.3.0, fixed; 2 x 5,000 passed after the fix** |
| Orchestrator | not asked | 1,000 per release (0.3, 0.4, 0.5, 0.6), 100 after the hardening of NEXUS's git | passed; in the 0.4 run 3 seeds timed out under machine load and passed alone |

- **Recovery:** covered inside every engine's histories (restarts are one of the random steps) and by E2E tests
  that quit and relaunch the built app. The first full E2E run of 0.7 failed four of them: after a restart or a
  usage wait the queue answered a resumed run that it may hold no session, and the orchestrator paused the run
  again. Fixed (a run with no capacity waits behind a closed gate; a resumed run is answered from the present
  state); the four tests pass.
- **Fault injection:** no new campaign was built. The existing suites inject agent session crashes, SDK
  failures, quota events, restarts, provider outage, evaluator failure, a branch that refuses a move, an
  unreadable contract, a missed schedule and a failed scheduler pass. **Not covered:** database failures in
  general, loss of network, worker death and renderer crash as asked (there are no worker processes; work does
  not need the window).
- Programs, seed 1552: a result built on an older state of the program branch was verified, accepted, refused
  by the branch and blocked, again on every resume. Now rejected at the gates and redone.
- Overnight, four seeds: after a failed power action the failsafe stays armed; a restart of Windows within a
  minute of arming left the record saying "armed". The record overstated; no power action was taken wrongly.
- Not run: 10,000 Arena trials in history, large event histories, a multi-hour soak. Nothing is known about
  memory, timers or database growth over days.

## Repository Safety

No new campaign of disposable Git scenarios was run. Proven by tests on real repositories that run with every
`pnpm test`, and by the real runs of this night:

| Property | Evidence |
|---|---|
| Dirty user changes are preserved | `git-safety` tests; six real runs tonight check the user's checkout before and after |
| The user's branches are not modified | NEXUS writes only `nexus/` branches; `fastForwardBranch` refuses a checked-out branch and a non-ancestor |
| Force push impossible by default | NEXUS has no push; an agent's `git push` asks |
| Cross-repository scope | workspace policy checked at plan time and at every task start; two real cross-repository runs |
| Worktree cleanup | confined to the worktrees directory after resolving links |
| Cancel, crash, partial missions | recovery scenarios; the program stress invariant "the branch contains every accepted result" |
| NEXUS does not write through a changed worktree pointer, and its git runs nothing a repository configures | new tonight; both tests fail without the fix |
| An agent cannot move a branch or tag outside `nexus/` without approval | new tonight, on the 0.7 branch only |

Not proven: these properties against an agent that hides its commands in a script (see Security).

## Security

Three independent adversarial reviews tonight (0.5 workspaces; 0.6 providers; the boundaries of the whole
application on the 0.7 code), read-only, each asked for concrete scenarios.

- **Critical: 0.**
- **High: 5 found, 4 fixed, 1 open.**
  - Fixed in 0.5.0: global verification passed for a repository whose checks never ran.
  - Fixed in 0.6.0: the Codex tool was resolved in the working directory, so a planted `codex.cmd` ran.
  - Fixed in 0.6.0 (in every release before): an agent's shell could rewrite a worktree's `.git` pointer, and
    NEXUS then committed, reset and cleaned in the user's repository or another task's worktree.
  - Fixed in 0.6.0 (since 0.2.1): `git config` behind a value option passed the classifier; the configured
    program then ran inside NEXUS's own git with NEXUS's environment.
  - **Open, by design:** a writing agent can write a script and run it; the script is not inspected.
- **Medium: 6 found by the boundary review, 1 fixed on the 0.7 branch** (moving refs outside `nexus/`). Open:
  agent-written text rendered into other agents' prompts under headings without a fence (message types cannot
  be forged); a repository's `.claude/settings.json` hooks when "respect the project's Claude configuration" is
  on; overnight approves plan and graph changes by default; a trial's code can read the hidden evaluator at
  evaluation time, so **Arena results can be gamed by an agent that tries to**; bare `git` resolved by the
  system's search.
- **Open risks:** no operating-system sandbox. "An agent cannot trigger or cancel the overnight shutdown" holds
  against commands the classifier recognises, not against an agent that hides them in a file. `v0.3.0`,
  `v0.4.0` and `v0.5.0` do not contain the fixes above.

Found sound by the reviews: path confinement of the file tools; the power module's isolation and fixed
arguments; no IPC channel, tool or schedule carries a power parameter; strict schemas on every channel, sender
checks, `contextIsolation`, `sandbox`, the content security policy; NEXUS never pushes, tags or merges into a
user branch; worktree removal confined; project commands run without a shell, resolved on PATH only; test
switches unusable in a packaged build.

By the campaign's rule ("if a confirmed HIGH cannot be fixed, readiness is NO"): one HIGH is open.

## Autonomous Operation

| | State |
|---|---|
| Overnight | Missions, Arena campaigns, programs and workspace missions run under one supervisor; tested with the fake power controller, 2 x 5,000 histories, E2E. **No real overnight run of NEXUS ended in a real shutdown** |
| Quota wait and resume | Tested with the scripted runtime (scenarios, 5,000 histories, E2E for a known and an unknown reset). **Never met for real** |
| Restart recovery | Tested in every engine and in E2E; one real restart in the middle of a real program (0.4 acceptance) |
| Power lifecycle | Failsafe first, final action, cancel; isolation test; fixed arguments. Real Windows timers were scheduled and cancelled in earlier smoke tests; a real completed shutdown, sleep and hibernate are NOT VERIFIED |
| Long-horizon programs | One real program of three small milestones. Nothing longer |

## Multi-Repository

Workspaces are released in 0.5.0: enrollment, graph, six contract kinds, cross-repository missions, global
verification, prepared release trains, workspace programs. Two real cross-repository missions on three small
repositories, 15 of 15 gates each. Weak points: `compatible` is judged on what NEXUS can read from a contract
file and counts everything as output, so a new required property is `compatible`; a failed verification cannot
be repaired inside the mission; workspace programs and overnight workspace missions have no screen and no real
run.

## Provider Layer

Released in 0.6.0. Claude is unchanged and required. Codex is driven through its own command line tool,
read-only; two real missions were reviewed by a real Codex session and one real review found a planted defect.
Gemini is detected only. Heterogeneous speculation exists for scripted providers only, because the one real
second provider may not write. NEXUS does not choose a provider from evidence.

## Arena Evidence

**Does the evidence support that NEXUS improves on plain Claude? INSUFFICIENT.**

| | |
|---|---|
| Plain Claude (SINGLE) | 3 trials on 2026-10-04 (0.3), 3 passed; 1 trial tonight (`testing-gap`), passed |
| BUILD | 3 trials on 2026-10-04, 3 passed after a NEXUS defect was fixed; tonight's first BUILD trial was running when the session stopped |
| ADAPTIVE | Not an Arena strategy: the Arena compares concrete strategies, and ADAPTIVE chooses among them from that evidence. No ADAPTIVE comparison exists |
| Sample sizes | 3 per strategy, one repetition, three small cases |
| Results | Every evaluated trial passed its hidden evaluation; BUILD used 5 to 9 sessions per trial, SINGLE 3 |
| Confidence | None. NEXUS itself labels this evidence INSUFFICIENT and proposed no policy change |

A comparison on the packaged 0.6.0 build (three other cases, SINGLE and BUILD, six trials) was started at 06:49.
One trial had been evaluated when the session stopped at about 07:15; the run ended with the computer's
shutdown and left no evidence file. Also open: a trial's code can read the hidden evaluator at evaluation time
(Security), so even a large campaign would need that closed first.

## Migrations

`node scripts/migration-campaign.mjs`, the 0.7 development build on copies of nine real databases:

| Written by | Schema | Content | Result |
|---|---|---|---|
| 0.1 | 1 | a real mission | 9 of 9 checks |
| 0.2.0 | 2 | a real mission | 9 of 9 |
| 0.2.1 | 3 | a real mission with session rotation | 9 of 9 |
| 0.3.0 (first build) | 4 | a real Arena campaign, 6 runs | 9 of 9 |
| 0.3.0 (first build) | 4 | a real ADAPTIVE mission | 9 of 9 |
| 0.3.0 (final) | 5 | upgraded by 0.3.0 | 9 of 9 |
| 0.4.0 | 6 | a real program, 10 runs | 9 of 9 |
| 0.5.0 | 7 | a real workspace mission | 9 of 9 |
| 0.6.0 | 8 | a real mission reviewed by a real Codex session | 9 of 9 |

For each: the build launches, the schema is upgraded through every version in order to 9, the older file is
kept as a backup, no table lost or changed its number of rows, every run opens with all its tasks and agents,
every program, workspace, workspace mission and Arena campaign is listed and opens, the pages render.
Last run: 9 of 9 checks on each of nine databases, the 0.6 one holding a real mission with a Codex review (`migration-campaign-2026-10-05T19-37-27-463Z.json`; a run minutes earlier is kept too: it counted a newly registered Arena case version as a changed table). There is no 0.7 database to migrate from, and the campaign used the development build. Each release
was also validated as a packaged build against the 0.1, 0.2.0 and 0.2.1 databases.

## UI / Accessibility

Five independent reviews tonight: 0.3 (twice), 0.4 Programs, 0.5 Workspaces with 0.6 Providers, and the
latest application with the Control Center. Findings rated HIGH on the released pages were fixed before each
release (truthfulness of overnight and provider consent texts, actions offered that the engine refuses). Open:

- **Control Center (0.7, unreleased): 3 HIGH open.** Cancel and Delete without confirmation; an error shown
  beside an endless "Loading"; blocked work that cannot be opened from the queue.
- Released pages, MEDIUM: errors of a failed cancel or remove shown behind the dialog (Workspaces); list rows
  whose accessible name omits the state; the Workspaces tab strip at 1024 px; the Providers enable switch below
  the capability table; plan usage on the Providers page without the provenance label.
- Across the application: page widths and empty, loading and error patterns differ between pages; Home and
  the Control Center both answer "what is running" and do not link to each other; 17 navigation entries.
- A dark theme exists in the tokens and in Settings and does not follow the system setting. It was not looked
  at tonight. Keyboard access, focus and screen sizes were reviewed from the source, not by using the app.

Not at the quality a release candidate needs.

## Packaging

| Version | Installer | Size | SHA-256 | Commit |
|---|---|---|---|---|
| 0.6.0 (highest release) | `release/NEXUS-Setup-0.6.0.exe` | 207,358,553 | `eb1a885599cfb2d6b0de44b196ca3304ab2502fd52c58d0f86fdb591de4e65ba` | `bf0f782` |

The unpacked build (`release/win-unpacked/NEXUS.exe`) was verified on three older real databases, 20 of 20
checks each. **The installer was not executed** (Bitdefender; antivirus was not touched). Installed
launch, upgrade install and uninstall are NOT VERIFIED, as in every release so far.

## Known Limitations

- Everything under "Not verified" and "Known limitations" in the release reports of 0.3 to 0.6.
- 0.4.0 has a known defect in programs (fixed in 0.5.0); 0.3.0 to 0.5.0 lack the security hardening of 0.6.0.
- The built-in Arena cases need Node.js on PATH; one evaluator measures by timing.
- No performance, scale or soak test exists.

## Conditions required before 1.0

1. Finish 0.7: the runtime as its own process, the boundary, the worker manager, with their tests, a real run
   with two workload types, and a security audit of the new surface.
2. Decide the agent confinement: a restricted token or job object for agent processes (no shutdown privilege,
   no writes outside the worktree and the temp directory, network by policy), or an explicit accepted risk in
   the release notes.
3. Close the open MEDIUM security findings, the Arena evaluator isolation first, because Arena evidence feeds
   the adaptive policy.
4. Run the reliability campaign before every release at 5,000 or more histories per engine, the orchestrator
   included.
5. Real evidence over time: programs and workspace missions on real repositories for days, at least one real
   usage limit, one real overnight run that ends in a real shutdown, the installer executed on a clean machine.
6. An Arena comparison with enough tasks and repetitions to say something, published whatever it says.
7. Performance and soak tests; the open accessibility items.

## Recommendation

**NOT READY FOR 1.0 RC.** No release candidate was prepared.
