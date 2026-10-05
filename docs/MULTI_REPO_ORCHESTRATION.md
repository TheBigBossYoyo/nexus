# Multi-repository orchestration (0.5)

The life of a cross-repository mission: one goal, several repositories, one task per repository change, run in
dependency order, verified together. The workspace model is in [WORKSPACES.md](WORKSPACES.md); the contract
rules the verification uses are in [CONTRACTS.md](CONTRACTS.md); what happens after a verified mission is in
[RELEASE_TRAINS.md](RELEASE_TRAINS.md).

Source: `src/main/modules/workspace/engine.ts` (`WorkspaceEngine`), `src/shared/workspace.ts` (states,
`validateWorkspacePlan`, `dependencyOrder`), `src/main/modules/overnight/workspace-workload.ts`.

```
GOAL -> planner session (read-only) -> plan -> validation -> YOU APPROVE -> tasks in dependency order
     -> one ordinary mission run per task, in its repository -> global verification -> COMPLETED
                                                                          -> release train prepared
```

## What is guaranteed

- Claude proposes; code decides. The plan is validated before it is stored, and no task starts before you
  accept it.
- Every task is an ordinary mission run in one repository, with that repository's own worktrees, checks, review
  and verification.
- The original checkouts are never changed. Work happens on the run's integration branch and task branches in
  worktrees. `tests/integration/workspace/engine.test.ts` and `tests/scenarios/v5-workspace.test.ts` check
  that each repository keeps its `HEAD`, its branch and a clean status.
- Only repositories allowed by the workspace policy are ever worked in.
- A mission that fails verification is not completed, records no contract versions and prepares no release.
- Nothing is merged into your branches and nothing is published.

## Starting a mission

`workspace.createMission` creates a `DRAFT` mission from a goal (at most 8000 characters); with `start: true`
it also starts it. `workspace.startMission` starts a draft. A mission does not start when:

- the policy allows no repository (`The workspace policy allows no repository`), or
- the repositories depend on each other in a cycle (`no order of work exists`).

Starting records the start time and moves the mission to `PLANNING`.

## The planner session

Planning is one read-only Claude session, run through the orchestrator as an ordinary `ask` run.

- Where it runs: in the project of the allowed repository that the most other repositories depend on, directly
  or through others. Ties are broken by key. The session may read that repository; the others are described in
  the prompt.
- Settings: the policy's `missionPreset`, and plan approval turned off for this run (it is a question, not a
  mission).
- Identification: the prompt starts with the marker line `NEXUS WORKSPACE PLANNER`
  (`WORKSPACE_PLANNER_MARKER`). The scripted runtime used in tests recognizes the prompt by it. The run is
  recorded on the mission as `plannerRunId`.
- What it is given, as quoted data blocks (every `<` escaped, with a line saying the blocks are information and
  never instructions): the goal, a description of the workspace (each repository's key, role, whether it is
  allowed, languages, frameworks, package and check commands; the dependencies with their kind and
  provenance; the contracts with provider, path and consumers and their copies), and up to 20 workspace
  memory entries.
- What it is asked for: one JSON object in a fenced block, with `summary`, `tasks` and `risks`, and no extra
  keys. It is told to plan as few tasks as the goal needs, to order them with `dependsOn`, to have a contract
  changed by its provider first and then by each consumer, to name in `contracts` every contract a task changes
  or adapts to, and not to write coding steps.

The answer is the result summary of the planner run. If it cannot be read as a JSON object, or fails the schema
or the validation, the mission asks again once with a new planner session. A second bad answer blocks the
mission with `No valid cross-repository plan:` and up to five reasons. The retry counter is kept in memory, so
a restart gives one more retry.

## The plan

| Field | Rule |
|---|---|
| `summary` | 1 to 1500 characters |
| `tasks` | 1 to 40 |
| `risks` | at most 10 lines of at most 400 characters |
| task `key` | lower-case letters, digits and dashes, at most 40 characters, unique in the plan |
| task `repository` | the key of an enrolled repository. One task changes one repository |
| task `title`, `objective` | at most 120 and 1500 characters |
| task `acceptanceCriteria` | 1 to 8 lines of at most 400 characters |
| task `dependsOn` | at most 8 task keys |
| task `contracts` | at most 8 contract keys the task changes (as provider) or adapts to (as consumer) |

An unknown key anywhere is refused (strict schema).

### Validation (`validateWorkspacePlan`)

A plan is accepted only when none of these problems is found:

| Problem | Rule |
|---|---|
| duplicate task key | Task keys are unique |
| unknown repository | Every task names an enrolled repository |
| repository not allowed | Every task's repository is in `allowedRepositories` |
| unknown contract | Every contract a task names is registered in the workspace |
| depends on itself, unknown task | `dependsOn` names other tasks of the plan |
| dependency cycle | The tasks have an order |
| too many repositories | The plan spans at most `maxRepositoriesPerMission` repositories |
| too many tasks | The plan has at most `maxTasksPerMission` tasks |
| graph not respected | For every edge `A -> B` of the organization graph, each task in `A` must depend on each task in `B`, directly or through others |

The last rule is checked only when the plan has no cycle, and only between tasks that exist: an edge whose
provider repository has no task in the plan asks for nothing. It uses every edge of the graph, whatever its
source. The rule is strict: with `A -> B`, if the plan has two tasks in `B`, each task in `A` must come after
both.

The validation does not check that a task's `contracts` list is complete or that a consumer task names the
contract its provider changes. It checks the structure of the plan, not whether the plan is a good one.

## Approval

A valid plan is stored on the mission and as one task row per planned task (state `PLANNED`, ordered by
dependency order into `ordinal`). The mission becomes `AWAITING_APPROVAL`. This is unconditional: a plan that
changes several repositories is always shown first, and the workspace policy has no setting that skips it.

- Accept (`workspace.decidePlan` with `accept: true`): the mission becomes `ACTIVE`.
- Reject (`accept: false`): the task rows and the plan are deleted and the mission goes back to `PLANNING`; a
  new planner session is started. There is no limit on how often you reject.

Nothing runs in any repository before you accept. `tests/integration/workspace/engine.test.ts` checks that no
mission run exists while the plan awaits approval.

## Running the tasks

In `ACTIVE`, the engine repeats one pass until nothing changes (at most 60 passes per trigger):

1. Look at the tasks that are `RUNNING`. A run that is still going is left alone (a run paused for recovery is
   resumed; a run paused for a usage limit is waited for; a run paused for any other reason blocks the
   mission with `the run of task ... is paused and needs attention`). A run that completed makes its task
   `COMPLETED`. Any other end makes it `FAILED` and blocks the mission (see Failure).
2. When every task is `COMPLETED`, the mission becomes `VERIFYING`.
3. Start every task that is ready. A task is ready when all tasks in its `dependsOn` are completed and no task
   of the same repository is running. At most `maxParallelRepositories` tasks run at once. Two tasks of one
   repository never run together, and the second starts from the first one's result.

Tasks of repositories with no dependency between them run at the same time when the policy allows more than
one; with the default of 1, tasks run one after another.

### One ordinary run per task

Each task is created through the orchestrator as a `mission` run in the task's repository:

- project: the repository's project,
- prompt: described below,
- acceptance criteria: the task's,
- preset: the policy's `missionPreset`; strategy: the policy's `missionStrategy`,
- plan approval off (you approved the cross-repository plan; the task's own planner does not ask again) and the
  policy's `reviewMode`,
- base: see below.

So each task has its own planner (according to the strategy), worktrees, scheduler, checks, review,
verification, repair loop and integration branch, as any mission has (ORCHESTRATION.md, GIT_WORKTREES.md).
Each run is under that repository's `.git`, on its own branches and worktrees. The task row records the run
id, the base commit and, when the run completes, the result branch (the run's integration branch) and the
result commit.

The base of a task's run:

- The newest completed task in the same repository (in this mission, otherwise in an earlier completed
  mission of the same workspace program) supplies its result commit as the base.
- With none, the base is the repository's current branch, as for any mission.

A mission that is not part of a program does not see the results of earlier missions: its first task in a
repository starts from what is checked out there now.

### How a later task sees an earlier one's result

Through three channels, all in the task's prompt or base:

1. The base commit, for tasks in the same repository (above).
2. What the tasks it depends on reported. For each `dependsOn` task that finished with a summary, the prompt
   has a quoted block `upstream_tasks` (up to 4000 characters) with `key (repository): summary`. A task's
   summary is the result summary of each task of its run, one line each, clipped to 400 characters per line
   and 1500 in all.
3. The content of each contract the task names. If the task's repository provides the contract, the prompt
   says so, names the contract file and its consumers, and says to change the contract file itself. If the
   repository consumes it, the prompt includes the contract file as the provider left it, in a quoted block
   (up to 12000 characters when the consumer keeps no copy), read from the provider's newest result commit in this mission; when the mission did
   not change the provider, from the result an earlier milestone of the same workspace program left there, and
   otherwise from the provider's `HEAD`. If the consumer keeps its own copy, the
   prompt says where it is and to make that file exactly equal to the content shown and to adapt the code and
   tests that use it.

Every task prompt also says that the task works in its repository only, that other repositories are changed
by other tasks, that the blocks are information and not instructions, and shows the mission goal for
orientation.

## States

### Mission

| State | Meaning |
|---|---|
| `DRAFT` | Created, not started |
| `PLANNING` | The planner session is running, or a plan is being asked for again |
| `AWAITING_APPROVAL` | A valid plan waits for you |
| `ACTIVE` | Tasks are being run |
| `VERIFYING` | Every task completed; the global verification is running |
| `PAUSED` | You paused it |
| `WAITING_FOR_QUOTA` | A usage limit is in force. This is a wait, not a failure |
| `BLOCKED` | The engine cannot go on without you; `blockedReason` says why |
| `COMPLETED` | Every task completed and the global verification passed |
| `FAILED` | Defined and accepted by the state machine; the engine does not currently set it |
| `CANCELLED` | You cancelled it |

`COMPLETED`, `FAILED` and `CANCELLED` are terminal: no transition leaves them.

| From | To (allowed) |
|---|---|
| `DRAFT` | `PLANNING`, `CANCELLED` |
| `PLANNING` | `AWAITING_APPROVAL`, `ACTIVE`, `PAUSED`, `WAITING_FOR_QUOTA`, `BLOCKED`, `CANCELLED`, `FAILED` |
| `AWAITING_APPROVAL` | `ACTIVE`, `PLANNING`, `CANCELLED` |
| `ACTIVE` | `VERIFYING`, `PAUSED`, `WAITING_FOR_QUOTA`, `BLOCKED`, `CANCELLED`, `FAILED` |
| `VERIFYING` | `COMPLETED`, `BLOCKED`, `PAUSED`, `CANCELLED`, `FAILED` |
| `PAUSED` | `PLANNING`, `ACTIVE`, `VERIFYING`, `WAITING_FOR_QUOTA`, `CANCELLED` |
| `WAITING_FOR_QUOTA` | `PLANNING`, `ACTIVE`, `VERIFYING`, `PAUSED`, `BLOCKED`, `CANCELLED` |
| `BLOCKED` | `PLANNING`, `ACTIVE`, `VERIFYING`, `WAITING_FOR_QUOTA`, `CANCELLED` |

The engine refuses any other transition. `COMPLETED` is reached only from `VERIFYING`.

### Task

| State | Meaning |
|---|---|
| `PLANNED` | Waiting for its dependencies or a free slot |
| `READY` | Defined; the engine starts a `PLANNED` task directly and does not set it |
| `RUNNING` | Its run is going |
| `COMPLETED` | Its run completed; the result is recorded |
| `FAILED` | Its run failed or was cancelled; `error` says what |
| `BLOCKED` | Defined; the engine does not set it (a resume would reset it to `PLANNED`) |
| `CANCELLED` | The mission was cancelled before the task completed |

## Pause, resume, cancel

| Action | Allowed from | Effect |
|---|---|---|
| Pause (`workspace.pauseMission`) | `PLANNING`, `ACTIVE`, `VERIFYING`, `WAITING_FOR_QUOTA` (pausing a paused mission changes nothing) | Remembers the state to return to, sets `PAUSED`, and pauses every live run of the mission (the planner session and the running tasks) with the reason `user`. No new task starts |
| Resume (`workspace.resumeMission`) | `PAUSED`, `BLOCKED` | Resets every `FAILED` or `BLOCKED` task to `PLANNED` (it gets a new run; the old run is forgotten), clears the blocked reason, returns to the remembered state (or `ACTIVE` when there is a plan, `PLANNING` when there is not), and resumes the runs the pause stopped. A run paused for a usage limit is left to quota recovery |
| Cancel (`workspace.cancelMission`) | any state that is not terminal | Cancels every live run, marks every task that is not completed as `CANCELLED`, and sets `CANCELLED`. Completed tasks keep their result branches. A cancelled mission cannot be resumed |

A task that failed is retried by Resume with a new run, which starts from the newest completed task result in
its repository (the failed run's work is not reused). Resuming a mission whose global verification failed
verifies again; it does not run the tasks again (see Failure).

## A usage limit is a wait

The engine does not run its own quota recovery. It observes the usage dispatch gate and the runs.

- If the gate is closed, or one of the mission's live runs is paused with the reason `quota`, a mission in
  `PLANNING` or `ACTIVE` records the state to return to, writes `quota_wait` and becomes `WAITING_FOR_QUOTA`.
  Nothing is failed and no task is started. `VERIFYING` does not wait: verification starts no Claude session.
- The runs themselves are resumed by the ordinary quota recovery controller (QUOTA_RECOVERY.md), which also
  reopens the gate.
- When the usage service reports a change and nothing limits the mission any more, it returns to its state and
  writes `quota_resumed`. The engine also checks on a 15 second timer.

`workspace.resumeMission` does not accept `WAITING_FOR_QUOTA`; Pause does. The UI offers no Resume in that
state: the mission continues by itself.

### A consumer that keeps a copy

A consumer with a copy path must make its copy equal to the contract, so it is given the contract whole and
verbatim (up to 200 KB; a larger contract blocks the mission with that reason), between two lines that carry a
random token. Content of a repository cannot end that block, because it cannot know the token. The prompt says
the block is data, not instructions.

## Recovery after a restart

The engine subscribes to the run events (`run.completed`, `run.failed`, `run.cancelled`, `run.paused`,
`run.resumed`) and moves the mission that owns the run, found through the task's run id or the mission's
planner run id. State is kept in the database at every step.

At startup (after the program engine's recovery) `recover()` looks at every open mission:

- Missions in `PLANNING`, `ACTIVE`, `VERIFYING` or `WAITING_FOR_QUOTA` write a `recovered` decision, resume the
  runs that the orchestrator paused at startup (reason `recovery`), and take a pass.
- Missions in `PAUSED`, `BLOCKED` or `AWAITING_APPROVAL` are left as they are.

A task whose run is already recorded is not started again. The integration test restarts the engine with a task
running and checks that the same run continues and that three tasks produced three runs. A restart between
creating a run and recording it on the task or the mission is not handled (see Limits).

## Global verification

When every task is `COMPLETED` the mission becomes `VERIFYING` and the engine builds a
`WorkspaceVerification`: a list of checks, one comparison per contract, and `passed` when every check passed.
Everything is read from the stored runs and from Git commits; no Claude session is started.

Per task:

| Check | Passes when |
|---|---|
| `task <key> completed` | The task's run is `completed` |
| `checks of <key>` | The last check run on the run's integration branch passed (when there is none, the last check run of any of its tasks). When no check run exists, the check fails and says so: nothing shows that the repository still builds and passes its tests |
| `result of <key>` | The task left a result commit |

Per contract that the mission touched (a task names it in `contracts`, or the mission changed its provider
repository):

- The contract file is read at the provider's newest result commit (after) and at the base commit of the
  provider's first task (before), and the two are compared (CONTRACTS.md). Nothing is stored yet.
- `contract <key> is readable` fails when the file after the mission cannot be read as its kind, and
  `contract <key>` fails when it cannot be read at all.
- For each consumer, a check `<repository> is in step with contract <key>`:
  - A consumer with a declared copy passes when the copy, read at the consumer's result, has the same content
    hash as the provider's new file. A copy that differs passes when the change is not breaking, and says the
    consumer has an older, compatible version. A copy that differs after a breaking or unknown change fails.
  - A consumer without a declared copy passes when the mission changed that repository (any task completed
    there), or when the change is not breaking. It fails when the change is breaking and the repository was
    not changed.
  - With `requireConsumerUpdateOnBreakingChange` off, these checks pass whatever the state of the consumers.

And one workspace-wide check, `release order`, which passes unless the graph has a cycle. A repository
without a version in its manifest is reported in a `versions` note that does not fail the mission.

### When it passes

All of this happens, and then the mission is `COMPLETED`:

1. For each touched contract whose comparison is not `identical`, a new contract version is recorded at the
   provider's result commit. A contract version is recorded only for verified work.
2. For each such contract with at least two repositories involved, a workspace memory entry is written.
3. When the release plan has at least one step, a release train is prepared in the state `PREPARED`
   (RELEASE_TRAINS.md).
4. `finishedAt` is set and a `completed` decision is written.

### When it fails

The verification is stored on the mission, a `verification_failed` decision names the failed checks, and the
mission becomes `BLOCKED` with a reason that lists the first four failed checks. No contract version is
recorded, no memory entry is written and no release train is prepared. The tasks and their result branches
are kept.

## Running a workspace mission overnight

A cross-repository mission can be the workload of the overnight supervisor (`overnight.startWorkspaceMission`,
workload type `workspace_mission`). The supervisor is the one in OVERNIGHT_MODE.md: one implementation of
arming, the deadline, finalization, the power decision, the countdown and restart recovery. The workload only
knows how to start, pause, resume and cancel the mission and how to describe it. The Workspaces view has no
control for this in 0.5; the call is made through IPC.

Order of events:

1. The call must carry the explicit confirmation (`confirmed: true` and the authorization sentence). The main
   process asks for the native confirmation too, listing the policy.
2. Only one overnight workload can be live (Windows has one shutdown timer). The mission must not be terminal.
3. The overnight record and the authorization are written, then the failsafe timer is armed, and only then does
   the mission start. When Windows refuses the failsafe, nothing starts. With the end action `NONE` or the
   failsafe disabled no timer is armed.
4. The workload starts the mission if it is a `DRAFT`, and resumes it if it is `PAUSED` or `BLOCKED`. A mission
   that is already working continues. A mission in `AWAITING_APPROVAL` is not touched.

Nobody is there overnight to approve a plan. Because a plan is always shown first, the mission's plan must
already be accepted when the night starts. A draft started overnight plans, reaches `AWAITING_APPROVAL` and
ends the night as `BLOCKED`.

What counts as a blocker (the workload reports `BLOCKED` and the supervisor finalizes):

| Mission state | Ending |
|---|---|
| `COMPLETED` | `SUCCESS` |
| `FAILED`, or the mission no longer exists | `FAILED` |
| `CANCELLED` | `USER_CANCELLED` |
| `BLOCKED` (a failed task, an invalid plan twice, a failed verification, an engine error, a policy change), with its reason as the detail | `BLOCKED` |
| `AWAITING_APPROVAL` (`The cross-repository plan is waiting for approval.`) | `BLOCKED` |
| `PAUSED` (`The mission is paused.`) | `BLOCKED` |
| `WAITING_FOR_QUOTA` | no ending; the supervisor applies its usage-limit rules (OVERNIGHT_MODE.md): it waits when the reset is before the deadline, otherwise ends `QUOTA_EXHAUSTED` |
| anything else | the night goes on until the deadline (`TIME_LIMIT`), at which the mission is paused |

The mission keeps its own task queue, its usage wait and its global verification. The supervisor owns the
deadline and the power lifecycle. The watchdog and the run budgets of OVERNIGHT_MODE.md are for mission runs
and are not applied to this workload.

The report, `overnight-workspace-<start>.md` in the NEXUS reports directory, is built from persisted state
only (a workspace mission has no single project to copy it into). It lists the mission id, goal and times, the
outcome with its terminal reason, the tasks by repository with state, result branch and commit, the global
verification (each check passed or failed), the usage-limit waits and the power action. It states that nothing
was published and that the original checkouts were not changed. The workload's finalization reads the mission
and task rows; it does not commit anything itself.

`tests/integration/workspace/engine.test.ts` runs a workspace mission under the supervisor with the fake power
controller: a missing authorization is refused, the failsafe is the first power call, an unapproved plan ends the
night as `BLOCKED` with no power action, and an approved mission ends `SUCCESS`, with the report and the
final shutdown replacing the failsafe.

## Failure modes

| What happens | What the mission does |
|---|---|
| The planner session returns no answer, no JSON, or a plan that fails the schema | One more planner session, then `BLOCKED`: `No valid cross-repository plan: ...` |
| The plan fails validation (unknown or disallowed repository, order, limits) | The same |
| The policy no longer allows a task's repository when it is about to start | `BLOCKED`; the task is not started |
| A task's run fails or is cancelled | The task is `FAILED`; the mission is `BLOCKED` with `Task <key> (<repository>) failed: ... Nothing that depends on it was started.` Tasks that were already running keep running |
| A task's run is paused for a reason other than a usage limit or recovery | `BLOCKED`: the run needs attention |
| Every task completed but verification fails | `BLOCKED` with the failed checks; verification stays stored |
| A repository has no build or test command, or none ran | Its `checks of <key>` fails, so the mission cannot pass verification: checks that did not run are not passed checks. A repository whose role is `documentation` is excused and the check says so |
| A contract the mission touched cannot be read as its kind after the mission | `contract <key> is readable` fails |
| The engine throws an unexpected error in a pass | `BLOCKED` with the error text |
| A usage limit | `WAITING_FOR_QUOTA`, then back by itself |
| NEXUS restarts | The mission continues (above) |
| A repository is unenrolled, or a workspace removed, during a mission | Refused while any mission of the workspace is open |

## Limits

- A failed task blocks the mission; it does not fail it. `FAILED` is never set by the engine. After a failed
  verification, Resume verifies again from the same results. Fixing the cause means starting a new mission.
- The verification of a contract reads the provider at its result commit in this mission. When the mission did
  not change the provider it reads the result an earlier milestone of the same workspace program left there,
  and outside a program `HEAD` of the provider's checkout.
- Without a program, a mission's tasks start from what is checked out in each repository now, not from the
  results of earlier missions. Merge a result branch into your branch yourself to build on it.
- A run is created before the engine records it on the task or the mission. The engine writes a marker
  (`workspace-starting:<mission id>` in the settings table) before it creates a run and removes it once the run
  is recorded. After a restart, a run of the workspace's repositories that was created after the marker, is
  not recorded on the mission and carries the planner marker or the task prompt's opening line is cancelled, and
  the mission starts the step again. A run of yours in the same repository is not touched.
- `READY` and `BLOCKED` task states and the `FAILED` mission state exist in the types and are not set.
- Resume is accepted only from `PAUSED` and `BLOCKED`. A mission waiting for the usage limit resumes by itself
  when the limit clears.
- One mission can have several planner sessions over its life (each retry or rejection). Only the latest is
  recorded on the mission.
- The consumer check for a consumer without a declared copy counts any completed task in that repository as
  an update. It does not check that the task adapted to the contract.
- A cross-repository mission verifies by checks and by contract comparison. It does not run the repositories
  together (no integration tests across repositories), and a contract kind that NEXUS cannot read is reported as
  unknown, not guessed (CONTRACTS.md).
- Tests: `tests/integration/workspace/engine.test.ts`, `tests/scenarios/v5-workspace.test.ts` (a real
  orchestrator and the scripted runtime, three repositories) and `tests/stress/workspace-stress.test.ts`
  (seeded histories of plans, outcomes, usage limits, user actions and restarts; it checks one writer per
  repository, the parallel limit, dependency order, no run in a disallowed repository, a completed mission
  has a passed verification, a release train exists only for a completed mission and is never authorized for
  publishing, and contract versions are recorded only for verified work). A real Claude session, real
  repositories of your own and a real usage limit were not part of these.
