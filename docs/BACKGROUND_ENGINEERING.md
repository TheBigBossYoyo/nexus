# Background engineering (0.4)

Optional analysis jobs on a project. Off by default. A job only reads, and its only output is proposals in
the backlog.

Source: `src/main/modules/program/background.ts`.

## Rules

| Rule | How it is enforced |
|---|---|
| Off unless the user turns it on | `BackgroundSettings.enabled` is false by default; `start` refuses while it is off |
| Only the kinds the user enabled | `start` refuses a kind that is not in `BackgroundSettings.kinds` |
| A job runs when someone asks for it | Nothing schedules a job in 0.4. `background.start` is the only way |
| Read-only | A job is an `ask` run: no worktree, an agent without write tools |
| Proposals, not changes | The session's answer is parsed as `{ summary, proposals[] }`; proposals become backlog items with the status `proposed` and the provenance `background_job`. Nothing else is done with them |
| One job of a kind per project at a time | `start` refuses a second one |

## Job kinds

| Kind | Looks for |
|---|---|
| `dependency_audit` | Outdated majors, unused or duplicated packages, missing lock entries. Reads manifests and lock files; installs nothing |
| `flaky_test_analysis` | Timing assumptions, shared state, order dependence, real network or clock, unseeded randomness |
| `intelligence_refresh` | A summary of the repository's current structure |
| `dead_code_analysis` | Unused exports, unreachable branches, files nothing imports |
| `test_gap_analysis` | Behaviour with no test |
| `performance_baseline` | Hot paths and obvious algorithmic or I/O costs. Runs no benchmark |
| `architecture_audit` | Module boundaries, cycles, layering violations, duplicated responsibilities |

Every proposal needs concrete evidence. An empty list is a valid answer.

## Lifecycle

`queued`, `running`, `completed`, `failed`, `cancelled`. A job whose answer does not parse is `failed` with the
reason and stores nothing. At startup a job whose run ended while NEXUS was closed is settled, and one whose
run is gone is failed.

A job uses the Claude runtime and the account's usage, on the `eco` preset. A usage limit pauses its run like
any other run.

## IPC

`background.settings`, `background.setSettings`, `background.jobs`, `background.start`, `background.cancel`.
Changes are announced with `{ kind: 'backlog', projectId }`.

## Limits

- Jobs are started by hand. There is no schedule for them in 0.4.
- A job reads with the agent's ordinary read tools; it does not run the project's commands.
- The quality of a job's findings was not measured.
