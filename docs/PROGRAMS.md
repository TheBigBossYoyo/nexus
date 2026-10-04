# Programs (0.4)

A mission executes one piece of work. A program pursues an engineering goal across several milestones, each
worked on by one or more missions, and reassesses its plan as it goes.

```
PROGRAM GOAL -> MILESTONE -> MISSION -> TASK DAG -> VERIFIED OUTCOME -> REASSESSMENT -> NEXT MILESTONE
```

Source: `src/shared/program.ts` (data, schemas, pure decisions), `src/main/modules/program/` (engine,
reasoning, memory, background engineering), migration `006-programs`.

## Who does what

| | |
|---|---|
| The program engine (`ProgramEngine`) | Owns the truth. It decides what happens next from persisted state only, enforces the state machines and the budgets, and writes the decision trail |
| Claude | Proposes: a plan of milestones, a judgment of a milestone, a revision of the remaining plan. Each proposal is text from a read-only session; it is parsed and validated against a schema before anything is stored or acted on |
| The mission planner and the orchestrator | Unchanged. A mission of a program is an ordinary run with a strategy; the mission planner turns a milestone into tasks |

A program plan is a short list of milestones (at most 12). It contains no coding tasks.

## Vocabulary

| Term | Meaning |
|---|---|
| Program | Goal, success criteria, constraints, policy, optional schedule, state |
| Goal | The statement, its success criteria, constraints and risks (`ProgramGoal`) |
| Milestone | A verifiable step: objective, acceptance criteria, dependencies, expertise area, state |
| Workstream | A named stream of work a milestone belongs to |
| Mission | One run that worked on a milestone (`program_missions`: attempt, strategy, base and result commit) |
| ProgramPlan | What the planner returns: goal, success criteria, milestones, risks, constraints |
| ProgramPlanRevision | A stored version of the remaining plan, with its trigger, its diff and its status |
| ProgramDecision | One entry of the engine's decision trail |
| ProgramCheckpoint | A snapshot of where the program stood |
| ProgramOutcome | The result when the program ends |
| ProgramPolicy | Budgets and behaviour (presets Conservative, Balanced, Autonomous) |
| ProgramSchedule | Autonomous work windows |
| ProgramMemory | Validated long-horizon facts |
| BacklogItem | A proposal for later work |

## States

Program: `DRAFT`, `PLANNING`, `ACTIVE`, `PAUSED`, `WAITING_FOR_QUOTA`, `BLOCKED`, `REPLANNING`, `COMPLETED`,
`CANCELLED`, `FAILED`.

Milestone: `PLANNED`, `READY`, `ACTIVE`, `VERIFYING`, `COMPLETED`, `BLOCKED`, `DEFERRED`, `CANCELLED`.

The allowed transitions are tables in `program.ts`; the engine refuses any other. Three rules worth knowing:

- A milestone reaches `COMPLETED` only from `VERIFYING`.
- `WAITING_FOR_QUOTA` never leads to `FAILED`. A usage limit is a wait.
- A terminal program state has no way out.

## The loop

One pass handles one transition; the engine repeats until a pass changes nothing. It is driven by run events,
usage changes and a 15-second timer, and operations on one program never interleave.

1. `PLANNING`. A planner session receives the goal, repository facts, project history, Arena and policy
   evidence, the open backlog and the program memory. Its answer becomes plan version 1, `proposed`. The policy
   decides whether a person approves it.
2. `ACTIVE`. The next milestone is the first `READY` one in roadmap order (a `PLANNED` milestone becomes `READY`
   when its dependencies are completed). The engine generates a mission: the milestone's objective and
   criteria, the gaps of an earlier rejected attempt, what is already completed, the constraints, the relevant
   memory entries and the approach noted at the last revision.
3. The mission runs as an ordinary run, with the policy's strategy (ADAPTIVE by default).
4. Verification (below). Accepted: the milestone is `COMPLETED` and the program branch moves to the mission's
   result. Rejected: the milestone goes back to `READY` with the gaps.
5. Backlog proposals and validated memory entries from the verification are stored.
6. `REPLANNING`. A reassessment session sees what happened and either keeps the remaining plan or proposes a
   revision. Then back to 2. With no milestone left the program is `COMPLETED`.

A failed or cancelled mission consumes an attempt, leaves a backlog item with the failure as evidence, and
triggers a reassessment. It does not fail the program.

## Where the work goes

A program has a branch, `nexus/program-<id>`, created at the commit that was checked out when the program
started. It is never checked out in the user's working tree.

- The first mission of a milestone starts from the program branch.
- A retry starts from the previous attempt's result, so it continues that work.
- Only an accepted milestone moves the program branch (to the mission's result commit).

The user's checkout and branches are not touched. To use the result, merge the program branch.

## Milestone verification

A mission that reports success has not thereby completed its milestone.

Deterministic gates first:

| Gate | Passes when |
|---|---|
| `mission_completed` | The mission run is `completed` |
| `checks_passed` | The last check run on the integration branch passed (or no check command is configured, which the gate says) |
| `mission_verified` | The mission-level verifier passed, when the mission had one |
| `no_blocking_findings` | No task review is left requesting changes |
| `changes_present` | The mission changed at least one file. Recorded, not blocking |

A failed blocking gate rejects the milestone without a verifier session. Otherwise a verifier session receives
the milestone, its criteria, the gates, the mission's recorded evidence and the diff, and returns a judgment:
a verdict, each criterion with evidence, the gaps, and optional backlog and memory proposals. `accepted` with
an unmet criterion is treated as `rejected`. A judgment that cannot be read is asked for once more; after that
the program is `BLOCKED` and the milestone stays in `VERIFYING`. A milestone is never accepted without a
judgment. The evidence (gates, judgment, verdict, result commit) is stored on the milestone.

The verifier session reads the repository as it was before the mission; the mission's result reaches it as a
diff (clipped at 12 KB) and as the recorded evidence.

## Replanning

After an accepted milestone (when milestones remain), a rejected one, a failed mission, or a milestone that
used all its missions. The reassessment may keep the plan, or return every remaining milestone as it should be
from now on: added, split, reordered, changed, deferred or dropped. Completed milestones are fixed and their
keys cannot be reused.

The user can ask for a reassessment at any time (`program.replan`, "Reassess plan" on the program page) with a
note saying what should change. It happens at the next point where no run is in flight, before the next
mission. The note is given to the reassessment session as the user's request about the plan; the resulting
revision carries the trigger `user` and goes through the same validation and approval as any other.

Every revision is stored with a diff (`added`, `removed`, `deferred`, `changed` with the changed fields,
`reordered`, and the order before and after). A reassessment that cannot be read never blocks the program: the
accepted plan stands. Reassessments are counted against `maxReplans`.

## Backlog

Agents, the milestone verifier, a failed mission and background jobs may propose: bugs, debt, test gaps,
performance issues, architecture risks, security findings, documentation gaps. An item stores title,
description, category, severity, evidence, provenance, complexity, dependencies, a recommended milestone and a
status (`proposed`, `accepted`, `scheduled`, `done`, `rejected`, `obsolete`).

A proposal is not work. Nothing in the backlog is executed because it is there; the planner and the
reassessment see the open items and may plan a milestone for them, and a person changes an item's status. An
open item with the same title is not stored twice.

## Program memory

Durable facts worth keeping across milestones: architecture decisions, rejected approaches, hazards,
performance baselines, interfaces, security constraints, important failures, user decisions. Entries come from
milestone verification and are validated before they are stored. Refused: anything that looks like a
transcript, an instruction addressed to a later agent, an entry whose evidence only repeats it, and a
duplicate.

A mission does not receive the memory. It receives at most six entries relevant to its milestone, selected by
shared words in title, tags and content and weighted by kind (`selectMemory`). Which entries were selected,
and the words that matched, are recorded with the mission's decision.

## Expertise profiles

Frontend, Backend, Reliability, Security, Testing, Architecture. A profile is a row per project and area:
accepted and rejected milestones, missions, the path prefixes its accepted milestones touched, and the memory
entries recorded on its milestones. It is a record. It is not a long-lived Claude session; work always uses
normal Agent SDK sessions.

## Policy and budgets

| Field | Meaning |
|---|---|
| `maxDurationMinutes` | Active time. Waiting for a usage limit, pauses and closed work windows do not count |
| `maxAgents` | Parallel agents of one mission |
| `maxConcurrentMissions` | 1. A program's milestones run one after another in 0.4 |
| `maxMissionsPerMilestone` | Missions before a milestone is blocked |
| `maxTotalMissions` | Missions of the whole program |
| `maxReplans` | Reassessment sessions |
| `maxRepairs` | Stored with the policy; missions keep the run's own repair limits in 0.4 |
| `usageBehavior` | `wait`: a usage limit is waited out. `stop`: the program pauses for the user |
| `quotaWaitMaxMinutes` | Longest single wait before the program is blocked |
| `speculation` | Whether the SPECULATIVE strategy may be requested |
| `arenaExploration` | Stored with the policy; nothing starts a campaign by itself |
| `approvalPolicy` | `plan`: the user approves the first plan and every revision. `initial`: the first plan only. `none` |
| `missionStrategy`, `missionPreset` | What each mission is created with |
| `respectWorkWindows` | Work only inside the schedule's windows |

| Preset | Approval | Usage limit | Missions | Strategy |
|---|---|---|---|---|
| Conservative | every plan | stop | 10, 2 per milestone | BUILD |
| Balanced | first plan | wait | 30, 3 per milestone | ADAPTIVE |
| Autonomous | none | wait | 100, 4 per milestone | ADAPTIVE, speculation allowed |

A budget that runs out blocks the program with the reason. Resuming a blocked program gives its blocked
milestones another round of attempts.

An error inside the engine blocks the program with the error as the reason. A program is never left looking
busy while nothing drives it.

## Restart

Runs that were active are paused by the orchestrator at startup. A program on the Conservative preset, or one
that asks for approval of every plan, is paused with the reason `restart` and waits for the user. Any other
live program continues: its run is resumed, and a milestone that was being verified is verified, not run
again.

## IPC

`program.list`, `program.get`, `program.presets`, `program.create`, `program.start`, `program.pause`,
`program.resume`, `program.cancel`, `program.decidePlan`, `program.replan`, `backlog.list`, `backlog.setStatus`,
`expertise.list`, and the background channels (BACKGROUND_ENGINEERING.md). Changes are announced with
`{ kind: 'program', programId }`.

## Database (migration 006, additive)

`programs`, `program_workstreams`, `program_milestones`, `program_missions`, `program_decisions`,
`program_checkpoints`, `program_plan_revisions`, `program_memory`, `backlog_items`, `expertise_profiles`,
`background_jobs`.

## Limits

- One mission at a time per program.
- The milestone verifier judges from the diff and the recorded evidence; it does not run the result.
- Program reasoning sessions return JSON as text. An answer that does not parse is retried once.
- The reassessment after every milestone costs one session per milestone.
- A program's result stays on its branch. NEXUS does not merge it into the user's branch.
- `maxRepairs` and `arenaExploration` are stored and not enforced by the engine in 0.4.
