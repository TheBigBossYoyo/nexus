# Workers

**There is no worker manager in NEXUS.** This page exists because 0.7 was to have one, and says what is there
instead.

## What 0.7 was to have

Independent workers with a lifecycle of their own: start, heartbeat, lease, run an assigned agent session,
report events, stop, crash and recover, so that a worker that dies does not take the control plane with it.

## What exists

- Agent sessions run inside the NEXUS main process, through the provider runtimes. A Claude session is a
  `claude` process started by the Claude Agent SDK; a Codex session is one `codex exec` process per turn. Those
  processes are the only separation there is. They are children of NEXUS and end with it.
- The orchestrator has leases on tasks, not on workers: a task whose lease expires and whose pipeline is not
  running is dispatched again. A session that crashes fails its task, which is retried by the existing rules.
- The control plane reports "Agent sessions" as a health component and counts running sessions against the
  global limit. It does not start, stop or watch workers.
- After a restart of NEXUS, runs are paused and recovered by the orchestrator and the engines, as since 0.1.

## What is missing

- Worker processes owned by a manager, with heartbeats and leases.
- Recovery of a crashed worker's session by another worker.
- A control plane that survives the loss of the process that runs the sessions. Today they are the same process.

See `V0_7_RELEASE_REPORT.md` for what a release of 0.7 still needs.
