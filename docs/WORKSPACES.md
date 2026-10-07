# Workspaces (0.5)

A mission changes one repository. A workspace is a set of related repositories that one goal can change
together: a shared library, the services that use it, the applications built on those. Each enrolled
repository stays an ordinary NEXUS project. The workspace adds what lies between them: who depends on whom,
the contracts they share, the order work and releases must take, and one verification that looks at all of
them at once.

How a cross-repository mission runs is in [MULTI_REPO_ORCHESTRATION.md](MULTI_REPO_ORCHESTRATION.md),
contracts in [CONTRACTS.md](CONTRACTS.md), release trains in [RELEASE_TRAINS.md](RELEASE_TRAINS.md).

Source: `src/shared/workspace.ts` (data, schemas, pure decisions), `src/main/modules/workspace/` (`engine.ts`,
`contracts.ts`, `discovery.ts`), `src/main/modules/overnight/workspace-workload.ts`,
`src/main/modules/ipc/v5-handlers.ts`, migration `007-workspaces`, UI in
`src/renderer/src/views/workspaces/`.

## Who does what

| | |
|---|---|
| The workspace engine (`WorkspaceEngine`) | Owns the truth. It enrolls repositories, keeps the graph and the contracts, validates plans, starts tasks, verifies the whole and prepares releases. It decides from persisted state only |
| Claude | Proposes one thing: a cross-repository plan, from a read-only session. The plan is parsed and validated against a schema and against the workspace before anything is stored |
| The orchestrator | Unchanged. Every task of a plan is an ordinary mission run in its own repository, with its own planner, worktrees, checks, review and verification |

Nothing in a workspace publishes, pushes, tags or merges. The results stay on branches in each repository.

## What a workspace is

A workspace has a name, a description and a policy. It holds:

- enrolled repositories, each linked to one NEXUS project (`workspace_repositories`),
- services recorded per repository,
- dependencies between repositories (the organization graph),
- contracts, with their consumers and their versions,
- cross-repository missions with their tasks, and workspace programs,
- prepared release trains,
- workspace memory and a decision trail.

A repository can be enrolled in more than one workspace. Within one workspace a project is enrolled once and a
key is used once.

## Enrolling repositories

Overview tab, Enroll repository (`workspace.enroll`). Enrolling is always an explicit act: you choose a
folder in the native folder picker, or the call names a path. Cancelling the picker enrolls nothing.

What happens:

1. The folder is opened as a NEXUS project (an existing project for that path is reused).
2. It must be a Git repository, or the call fails with `not_a_repository`.
3. A repository that is already enrolled in the workspace is refused.
4. The key is the one you gave, or a short name made from the project name (lower-case letters, digits and
   dashes, at most 40 characters). When a key you did not choose is taken, `-2`, `-3` and so on are added.
   A key you chose that is taken is refused.
5. The repository's facts are read: current branch, the URL of `origin` (credentials in the URL are removed
   before it is stored), languages, frameworks and check commands from the project profile, and the package
   name and version from its own manifest.
6. The key is added to the policy's allowed repositories.
7. The graph's manifest edges are recomputed (see below).

`workspace.refresh` reads the facts again and recomputes the manifest edges. A repository never inherits
another one's stack: each has its own profile and its own commands.

`workspace.unenroll` removes the enrollment with its services, its edges, the contracts it provides and its
roles as a consumer, all in this workspace. The repository folder and its project are not touched. It is refused while any mission of the workspace is
open (a state other than `DRAFT`, `COMPLETED`, `FAILED`, `CANCELLED`). `workspace.remove` removes the whole
workspace's NEXUS records under the same condition. Removing a project from NEXUS removes its enrollments too
(foreign key with cascade).

### Roles

`library`, `service`, `application`, `website`, `documentation`, `infrastructure`, `other` (the default).
The role is a label. It is shown in the UI and given to Claude in the plan prompt and the task prompt. No
decision of the engine depends on it. `workspace.setRole` changes it.

### Health

Each repository shows one of three levels in the Overview tab:

| Level | When |
|---|---|
| `attention` | The repository is not allowed by the workspace policy: no mission may change it |
| `unknown` | It is allowed but has no build command and no test command: its tasks cannot be checked, and a mission that changes it fails its global verification, unless its role is `documentation` (see MULTI_REPO_ORCHESTRATION.md) |
| `ok` | Enrolled, allowed, and it has at least a build or a test command |

### Services

A service is a name and a one-line description recorded for a repository (`workspace.addService`). It is shown
in the Overview tab. It is not given to the planner and no decision uses it.

## The organization graph

An edge says `from` depends on `to`: `to` is changed, verified and released first. The graph is a set of
edges between enrolled repositories. Every stored edge has provenance: where it comes from, which file shows
it, and a sentence saying what.

| Source (`provenance.source`) | How it gets there |
|---|---|
| `manifest` | Discovered by NEXUS from the repositories' own manifests |
| `contract` | Created when you declare a consumer of a contract (`workspace.addConsumer`) |
| `user` | You declared it (`workspace.addDependency`) and gave a reason |

An edge without provenance is not stored.

### Discovery

Discovery (`discover` in the engine; it runs on enroll, on refresh and on `workspace.discover`, the Discover
button on the Graph tab) reads files only. Nothing is installed, resolved or fetched, and no source code is
scanned. It recomputes the `manifest` edges: all of them are deleted and the ones found now are inserted.
Edges from `contract` and `user` are kept.

Per repository, the first manifest found in the repository root is read, in this order: `package.json`,
`Cargo.toml`, `pyproject.toml`, `go.mod`. A manifest larger than 2 MB, or a `package.json` that is not valid
JSON, counts as absent (the next file is tried). A repository with no manifest yields no edges.

| Manifest | Name and version | Dependencies read |
|---|---|---|
| `package.json` | `name`, `version` | `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` |
| `Cargo.toml` | `[package]` `name`, `version` | `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]` |
| `pyproject.toml` | `[project]` or `[tool.poetry]` `name`, `version` | the PEP 621 `dependencies` list and `[tool.poetry.dependencies]` (not `python`) |
| `go.mod` | `module` (no version) | `require` lines and `replace` directives |

A dependency of repository A becomes an edge `A -> B` when B is another enrolled repository and either:

- the dependency's name equals B's manifest name, or
- the dependency's specification is a local path that resolves to B's root folder: `file:`, `link:` or
  `portal:` paths, a TOML `path = "..."`, or a `replace ... => ./path` in `go.mod`.

Every discovered edge has the kind `package_dependency`, and its provenance names the manifest file and the
line of the first occurrence of the dependency's name in it.

Discovery does not look at imports, HTTP calls, generated clients, deployment files, CI configuration or
documentation. Those relationships exist as edge kinds (`imports`, `api_provider_consumer`, `schema`,
`generated_client`, `deployment`, `documentation`) so you can declare them, and NEXUS does not find them.

### Declared edges

`workspace.addDependency` takes the two repository keys, a kind and a reason (at most 400 characters). It
refuses a repository depending on itself, an empty reason, and an edge that would close a cycle among the
edges already stored.

Declaring a consumer of a contract also adds an edge from the consumer to the contract's provider, with
`source: contract`, unless one from that source already exists. The kind is `api_provider_consumer` for an
`openapi` contract, `imports` for `typescript_api`, and `schema` for every other kind. This path does not
check for cycles.

`workspace.removeDependency` deletes any edge by id. A `manifest` edge you delete returns at the next
discovery.

### The order

`dependencyOrder` puts every repository after everything it depends on. `levels` groups the repositories that
could go at the same time. The order is deterministic (ties are broken by name). A cycle is reported with the
repositories in it and is never ordered: the Graph tab shows the cycle and a mission cannot start (see
MULTI_REPO_ORCHESTRATION.md).

## Policy

The policy is stored as JSON on the workspace and validated with a strict schema (an unknown key is refused).
Policy tab, `workspace.setPolicy`. A workspace is created with the default policy (`workspace.create` takes a
name and a description only).

| Field | Default | Meaning |
|---|---|---|
| `allowedRepositories` | `[]` (a repository is added when enrolled) | Keys of the repositories a mission may change. Empty means nothing runs. Every key must be an enrolled repository |
| `protectedBranches` | `main`, `master`, `release` | Branch names, at most 20. Stored and shown for your own release process. The engine does not read it (see Limits) |
| `maxRepositoriesPerMission` | 5 | 1 to 20. A plan may span at most this many repositories |
| `maxTasksPerMission` | 12 | 1 to 40. A plan may have at most this many tasks |
| `maxParallelRepositories` | 1 | 1 to 4. Tasks of different repositories with no dependency between them may run at the same time. Within one mission a repository never has two tasks running; two missions can work in the same repository at once, each on its own branches |
| `reviewMode` | `standard` | `standard`, `dual` or `auto`. Passed to every task's run |
| `publishing` | `never` | The only value the schema accepts. NEXUS does not publish |
| `requireConsumerUpdateOnBreakingChange` | `true` | A breaking contract change fails the global verification when a consumer is not up to date |
| `missionStrategy` | `BUILD` | The strategy of every task's run: `SINGLE`, `BUILD`, `SWARM`, `CONSENSUS`, `SPECULATIVE`, `ADAPTIVE` |
| `missionPreset` | `balanced` | `eco`, `balanced` or `maximum`. Used for the planner session and for every task's run |

`publishing` is fixed to `never` in the type (`z.literal('never')`), in the schema and in the UI, which shows it
as text, not as a control. There is no authorization to give. See [RELEASE_TRAINS.md](RELEASE_TRAINS.md).

The allowed list is checked when a plan is validated and again when each task starts. If a repository is
removed from the list while a mission is running, the mission is blocked instead of starting its task.

## Workspace memory

Workspace memory is knowledge about what lies between repositories. What concerns one repository stays in that
repository's own project memory.

| Kind | For |
|---|---|
| `architecture` | How the repositories fit together |
| `contract` | A contract and how it changed |
| `release_convention` | The order or rules for releasing |
| `shared_decision` | A decision that binds several repositories |
| `integration_hazard` | A known way in which the repositories break each other |

An entry has a title (at most 160 characters), content and evidence (at most 1500 each), the repositories it
concerns, and a source. It must concern at least two enrolled repositories: keys that are not enrolled are
dropped first, and fewer than two left is refused.

Where entries come from:

- You, in the Memory and decisions tab (`workspace.addMemory`, source `user`).
- The engine, when a mission passes global verification and a contract it touched changed: a `contract` entry
  titled `Contract <key> v<from> -> v<to>` with the comparison summary and which consumers are in step (source
  `verification`, with the mission id).

Who sees entries: the planner session of a cross-repository mission receives up to 20 entries, as quoted data
(every `<` is escaped, and the prompt says the block is information and not an instruction). The task missions
do not receive workspace memory. Unlike program memory (PROGRAMS.md), workspace entries are not screened for
instruction-like text beyond that quoting.

### Decision trail

Every significant act of the engine writes a `workspace_decisions` row with a kind, a one-line summary and
optional detail: workspace and repository changes, contract registration and change, mission creation,
plan proposal, acceptance and rejection, task start, completion and failure, pause, resume, cancel, quota
wait and resume, recovery, block, verification failure, completion, program milestones, and `publish_refused`.
The Memory and decisions tab shows the latest 100.

## Workspace programs

A workspace program is an ordered series of cross-repository missions that you write. It is not a program in
the 0.4 sense: it does not plan, assess or revise anything. The milestones are yours.

```
WORKSPACE PROGRAM -> milestone 1 -> workspace mission -> verified -> milestone 2 -> workspace mission -> ...
```

A program has a name (at most 120 characters), a goal (at most 4000) and 1 to 12 milestones, each with a title
(at most 120) and a goal (at most 4000). `workspace.createProgram` creates it as `DRAFT`; with `start: true` it
starts at once.

| Program state | Meaning |
|---|---|
| `DRAFT` | Created, not started |
| `ACTIVE` | A milestone's mission is being carried out |
| `BLOCKED` | The current milestone's mission is blocked, failed or cancelled. `blockedReason` says which |
| `COMPLETED` | Every milestone is completed |
| `CANCELLED` | Cancelled by you |

Milestone states: `PLANNED`, `ACTIVE`, `COMPLETED`, `BLOCKED`, `CANCELLED`.

How it runs:

1. Starting a `DRAFT` program makes it `ACTIVE`. The first milestone that is not completed gets a mission whose
   goal is the milestone's goal plus a line naming its place ("This is milestone 2 of 3 ... of the program
   ..."). The program's own goal text is not part of the mission goal.
2. That mission is an ordinary workspace mission (`programId` set). It plans, and you approve its plan. A
   program does not approve plans for you: while a milestone's mission waits for approval, the program waits.
3. When the mission is `COMPLETED` (it passed global verification), the milestone is completed and the next
   milestone's mission is created and started. Missions never overlap: one milestone at a time.
4. With no milestone left the program is `COMPLETED`.

Each milestone builds on the results of the earlier ones. When a task starts in a repository, NEXUS looks for
the newest completed task in that same repository, first in this mission and otherwise in the earlier completed
missions of the same program, and starts the new task's run from that task's result commit. A repository an
earlier milestone did not change starts from the commit checked out in it now. So a task of milestone 2
contains milestone 1's work in every repository milestone 1 changed.

Failure and resuming:

- A blocked mission blocks the program, with the mission's reason. `workspace.resumeProgram` resumes the
  blocked mission and the program continues. Resuming the mission itself also lets the program continue.
- A mission that was cancelled or removed blocks the program, and the milestone's mission link is cleared.
  `workspace.resumeProgram` then starts a new mission for that milestone.
- `workspace.cancelProgram` cancels every mission of the program that is not finished and marks every milestone that is not
  completed as cancelled. Completed milestones, their missions and their result branches stay.
- A program is advanced after each step of its mission and by the engine's 15 second timer, so it continues
  after a restart together with its mission.

A workspace program is not an overnight workload; only a single workspace mission is (see
MULTI_REPO_ORCHESTRATION.md). The Workspaces view has no screen for programs in 0.5: they are created and
driven through the IPC channels below.

## The Workspaces view

Navigation, Workspaces. The list shows each workspace with its counts, and New workspace. The Home page shows
workspaces with an active mission. A workspace page has seven tabs:

| Tab | What it offers |
|---|---|
| Overview | Enroll repository; per repository the health, role, branch, path, remote, languages, package, check commands, a Missions may change checkbox (the allowed list), services and their form, Refresh and Remove |
| Graph | A picture of the graph (providers on the left, a dashed line for an edge you declared, a cycle notice instead when there is one), a table of every edge with its source and provenance, Discover, remove an edge, and a form to declare one |
| Contracts | Register a contract, declare consumers and their copy paths, capture a version, the version list and the latest comparison. See CONTRACTS.md |
| Missions | New mission (Create, or Create and start), the list, and per mission: state and notices, the plan awaiting approval with Accept and Reject, the tasks in order with their result branch and commit and a link to the task's run, the verification checks, per contract the comparison and the consumers, Start, Pause, Resume, Cancel and Prepare release train |
| Release trains | Prepared trains with their ordered steps, and Cancel train. States that NEXUS does not publish |
| Memory and decisions | Add a memory entry; the entries; the decision trail |
| Policy | The allowed repositories and every field of the policy; publishing is shown as `never` |

Not in the view: workspace programs, and running a workspace mission overnight.

## IPC channels

All channels are validated by the schemas in `src/shared/ipc.ts`. Changes are announced to the renderer with
`{ kind: 'workspace', workspaceId }`.

| Channel | Does |
|---|---|
| `workspace.list` | Summaries: repositories, contracts, active missions, active programs |
| `workspace.get` | Everything about one workspace (`WorkspaceDetail`), with the order or the cycle |
| `workspace.create` | Creates a workspace (name, description) with the default policy |
| `workspace.setPolicy` | Replaces the policy |
| `workspace.remove` | Removes the workspace's records |
| `workspace.enroll` | Enrolls a repository (a path, or the folder picker) |
| `workspace.refresh` | Reads a repository's facts again |
| `workspace.unenroll` | Removes an enrollment |
| `workspace.setRole` | Changes a repository's role |
| `workspace.discover` | Recomputes the manifest edges |
| `workspace.addDependency` | Declares an edge, with a reason |
| `workspace.removeDependency` | Deletes an edge |
| `workspace.addService` | Records a service |
| `workspace.registerContract` | Registers a contract and captures its first version |
| `workspace.addConsumer` | Declares a consumer of a contract |
| `workspace.captureContract` | Reads the contract at the provider's `HEAD` and records a version when it changed |
| `workspace.addMemory` | Adds a memory entry |
| `workspace.createMission` | Creates a mission from a goal (at most 8000 characters), optionally starting it |
| `workspace.mission` | A mission with its tasks |
| `workspace.startMission` | Starts a draft mission |
| `workspace.decidePlan` | Accepts or rejects the plan |
| `workspace.pauseMission`, `workspace.resumeMission`, `workspace.cancelMission` | User actions on a mission |
| `workspace.createProgram`, `workspace.startProgram`, `workspace.resumeProgram`, `workspace.cancelProgram` | Workspace programs |
| `workspace.prepareRelease` | Prepares a release train from a completed mission |
| `workspace.publishRelease` | Always refused and recorded (see RELEASE_TRAINS.md) |
| `workspace.cancelRelease` | Marks a prepared train cancelled |
| `overnight.startWorkspaceMission` | Runs a workspace mission under the overnight supervisor (see MULTI_REPO_ORCHESTRATION.md) |

Without the engine in the process, `workspace.list` returns an empty list and the other channels fail with
`runtime_unavailable`.

## Data model (migration 007, additive)

Migration 007 creates tables and indexes only; no earlier table is changed.

| Table | Holds |
|---|---|
| `workspaces` | Name, description, policy (JSON) |
| `workspace_repositories` | One enrolled repository: key, project, path, role, remote, branch, languages, frameworks, commands, package name and version, manifest file. Unique per workspace on key and on project |
| `workspace_services` | A service of a repository |
| `workspace_dependencies` | An edge: from, to, kind, provenance (JSON) |
| `workspace_contracts` | A contract: key, name, kind, provider repository, path. Unique per workspace on key |
| `workspace_contract_consumers` | A consumer of a contract: repository, optional copy path, provenance. Unique per contract and repository |
| `workspace_contract_versions` | A version: number, hash, commit, surface (JSON), parse error. Unique per contract and number |
| `workspace_missions` | A mission: goal, state, resume state, blocked reason, plan (JSON), planner run id, verification (JSON), error, times, optional program id |
| `workspace_tasks` | A task: mission, repository, key, ordinal, title, objective, criteria, dependencies, contracts, state, run id, base and result commit, result branch, summary, error. Unique per mission on key |
| `workspace_programs` | A program: name, goal, milestones (JSON), state, blocked reason |
| `workspace_release_trains` | A train: mission, name, state, plan (JSON), `publish_authorized` (0 by default) |
| `workspace_memory` | A memory entry |
| `workspace_decisions` | The decision trail |

Every table references `workspaces` with a cascading foreign key (tasks through their mission), so removing a
workspace removes all of its rows. Repository rows also cascade from their project, and contracts, consumers
and services cascade from the repository that owns them. A mission's `program_id` and the run ids that
missions and tasks record are plain text, not foreign keys.

## Workspaces in the Context Graph (0.7.1)

Each workspace has its own graph: `repositories/`, `contracts/`, `architecture/`, `decisions/`,
`standards/`, `hazards/`, `notes/`. Repositories, dependencies, contracts and workspace memory are projected
into it; the workspace tables stay the source of truth.

| Relation | From the record |
| --- | --- |
| repository DEPENDS_ON repository | a workspace dependency |
| repository PROVIDES contract | the contract's provider |
| repository CONSUMES contract | a contract consumer row |
| repository AFFECTED_BY hazard, DECIDED_BY decision, RELATED_TO entry | the repositories a memory entry names |
| workspace repository DERIVED_FROM project root | the enrolled repository is that NEXUS project |

A task in one repository reads its own project's graph and the graphs of the workspaces that enrol it. The
last edge is the way in: from the project to "this repository as the workspace sees it", and from there to
the contracts it provides or consumes and the knowledge that names it. A contract of two other repositories
is not reached. On the retrieval benchmark the 0.7.0 pack misses the contract and the integration hazard of
a cross-repository change; the graph finds both.

A repository that is not enrolled in the workspace cannot read the workspace's graph: every graph call takes
the spaces the caller may read, and a node outside them reads as not found.

## Limits

- Discovery reads the root manifest of each repository only (`package.json`, `Cargo.toml`, `pyproject.toml`,
  `go.mod`, first one found). It does not read workspace-level manifests in subfolders, imports, API calls,
  deployment or CI files. Everything else in the graph is declared by you.
- A package name is matched as written. Dependency specifications other than the local-path forms above are
  not resolved to a repository.
- `protectedBranches` is validated, stored and shown, but nothing in the engine reads it. Tasks always run on
  new branches in worktrees created by the orchestrator, and no step of a workspace mission commits to or
  checks out a branch of your checkout, so the list does not change what NEXUS does.
- Roles and services are labels; they do not change decisions.
- Edges added through `workspace.addConsumer`, and edges discovered from manifests, are not checked for
  cycles when they are stored. A cycle shows on the Graph tab and stops a mission from starting.
- Workspace memory is entered by you or written after a verified contract change. Nothing summarizes missions
  into it, and tasks do not receive it.
- The Workspaces view has no screen for workspace programs and no control to run a workspace mission
  overnight. Both work through IPC.
- Publishing is not implemented and cannot be enabled.
- What the tests cover: `tests/unit/workspace/workspace-model.test.ts` (graph order, surfaces, comparison,
  plan validation, release planning, states, discovery), `tests/integration/workspace/engine.test.ts`
  (onboarding, contracts, a mission, a failing consumer, policy refusal, a failed task, a usage limit with a
  restart, parallelism, memory, programs, the overnight workload), `tests/scenarios/v5-workspace.test.ts`
  (three repositories on the real orchestrator with the scripted runtime) and
  `tests/stress/workspace-stress.test.ts` (seeded histories). Behaviour with a real Claude session, a real
  repository of your own and the UI against a live engine is not covered by these.
