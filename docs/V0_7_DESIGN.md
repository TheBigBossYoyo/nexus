# NEXUS 0.7 Design: Secure Control Plane

Status of this document: the design that the `nexus-0.7` branch implements. What is implemented, tested and not
verified is recorded in `V0_7_PROGRESS.md` and, at the end, in `V0_7_RELEASE_REPORT.md`. Where the two differ, the
report is right.

## 1. What 0.7 changes

Until 0.6 everything NEXUS did lived in the Electron main process: the database, the engines, the agent
sessions and the window. Quitting NEXUS stopped the work, and a fault in one agent session's host was a fault of
the whole application.

0.7 separates three roles. They are one executable.

```
 nexus-desktop                 the window. A client. Owns nothing durable.
      │  named pipe, authenticated, versioned, one closed set of channels
 nexus-runtime                 the control plane. Owns the database, the queue, the scheduler,
      │                        the engines, schedules, the overnight supervisor, power control.
      │  process channel (fork), one per worker
 nexus-worker-N                one agent session at a time, under a lease. Decides nothing.
      │
 provider process              claude.exe (Agent SDK) or `codex exec`, as before
```

| Role | How it is started | Source |
|---|---|---|
| `nexus-desktop` | `NEXUS.exe` | `src/main/desktop.ts` |
| `nexus-runtime` | `NEXUS.exe --nexus-runtime`, by the desktop when none answers; detached | `src/main/runtime-electron.ts` hosting `src/main/runtime/core.ts` |
| `nexus-worker-N` | `NEXUS.exe` run as Node (`ELECTRON_RUN_AS_NODE`) on `out/main/worker.js`, forked by the runtime | `src/main/worker.ts` |

The runtime core imports nothing from Electron. The Electron host gives it the tray, notifications, the
user-bound key store (DPAPI) and the power-save blocker. A second host, `src/main/runtime-node.ts`, runs the same
core under plain Node; tests use it to start, kill and restart a real runtime process without a window.

No WSL, no Docker, no service, no administrator rights. Everything runs as the signed-in user.

## 2. Lifecycle

- **Start.** The desktop reads `<data>/runtime/endpoint.json`. If a runtime answers there, it connects. If not,
  it starts one and waits for a new endpoint. The window shows `STARTING RUNTIME`, `CONNECTING`, `RECOVERING`,
  `READY`.
- **Closing the window** ends the desktop process. The runtime continues. During an overnight mission the
  window asks first, as since 0.2 (hide, cancel the mission, or return).
- **A crash of the window or the desktop process** changes nothing in the runtime.
- **Opening NEXUS again** connects to the running runtime. The window holds no state of its own: everything it
  shows is read from the runtime again.
- **The runtime stops** when the user chooses "Stop NEXUS" (tray, or Runtime diagnostics), which asks first when
  work is active; or by itself after two minutes with no window connected, no run working, nothing on the queue
  and no schedule switched on. A runtime that has a reason to stay shows why in `runtime.status`.
- **One runtime per data directory**: the Electron host takes a single-instance lock on its own profile
  directory (`<data>/runtime-profile`).
- **A runtime of another NEXUS version** (older or newer) that is still running is asked to stop by the window,
  which then starts its own. A runtime that speaks another protocol version is not talked to; the window says so.

## 3. The local protocol

`src/shared/runtime-protocol.ts`, `src/main/modules/runtime/`.

- **Transport**: one Windows named pipe, `\\.\pipe\nexus-runtime-<hash of data dir>-<16 random hex>`. No TCP
  socket is opened anywhere. The pipe is created with `exclusive`, so the runtime notices a name that is taken.
- **Discovery**: the endpoint file holds the pipe name, a 32-byte random token, the runtime's pid, boot id,
  version and protocol. It is written whole (temporary file, rename); the access list is narrowed with
  `icacls` to the user, SYSTEM and administrators on the temporary file, before it gets its name.
  `runtime.status` says whether that succeeded; when it did not, the list inherited from the user's profile
  applies. NEXUS sets no access list on the pipe itself: what protects the pipe is the handshake.
- **Handshake**: mutual, by HMAC-SHA-256 over both sides' nonces with the token as key. The runtime proves
  itself first; the client checks that proof before it sends its own. The token never crosses the pipe. A
  connection that has not completed the handshake within five seconds is closed; before the handshake no frame
  longer than 4 KB is read and nothing but `hello` and `auth` is accepted.
- **Frames**: one JSON object per line, validated with zod on both sides (`ClientFrameSchema`,
  `ServerFrameSchema`), at most 32 MB.
- **Requests**: `{t:'req', id, channel, input}`. The runtime passes them to the same dispatcher the window used
  before 0.7: the channel must be one of the closed contract in `src/shared/ipc.ts` and the input must pass
  that channel's strict schema before a handler runs. There is no channel that takes a command line, a file
  path to read or write, or code.
- **Events**: after the handshake a client receives every push message.
- **Questions to the user** (authorize overnight power control, trust an Arena case, pick a folder) are sent by
  the runtime to the connected desktop as a closed set of `ui.req` frames and shown there as native dialogs.
  With no window connected the Electron host shows them itself; under the Node host they fail. A question that
  nobody can see is never answered yes.
- **Reconnect**: the client reconnects with backoff. While it is disconnected every request fails at once with
  `runtime_unavailable`; nothing is queued and nothing old is shown as current. After a reconnect the window
  reads everything again.
- **Slow readers**: a client with more than 64 MB unsent is dropped. The runtime never waits for a window.

### What the protocol protects against, and what it does not

It protects against another Windows user on the machine, against a process that takes the pipe's name, and
against a process that can reach the pipe but cannot read the user's files.

It does **not** protect against a process running as the same user that reads the endpoint file. Such a process
can call every channel the window can. Windows offers no boundary between processes of one user that NEXUS could
rely on here; the same process could as well drive the window. What stays out of reach even then: provider
credentials (NEXUS never holds them), a channel that executes a command, and raw power control. Power actions
exist only as typed operations of the overnight supervisor, which checks the persisted, signed authorization
and asks the user in a native dialog.

## 4. Database ownership

The runtime is the only process that opens `nexus.db`. The window reads and writes through the protocol. Workers
open no database. WAL mode with `synchronous = NORMAL` as before; the runtime checkpoints on a clean stop and
before the overnight supervisor's power step.

## 5. Worker manager

`src/shared/workers.ts`, `src/main/modules/workers/`, migration 010.

- A worker is a process that runs **one** agent session at a time. The runtime keeps at most
  `maxAgents + 1` workers.
- States: `STARTING → IDLE → ASSIGNED → RUNNING → IDLE … → DRAINING → STOPPING → STOPPED`, `FAILED` from any
  live state, `RECOVERING` for a worker found from an earlier start of the runtime. The transition table is in
  `WORKER_TRANSITIONS`; a transition outside it is refused.
- **Leases.** An assignment is a row in `worker_leases` with an expiry. Two partial unique indexes make "one
  active lease per agent session" and "one active lease per worker" a property of the database, not of the
  code path. The worker's heartbeat (every 2 s) keeps the lease renewed (written at most every 10 s); a lease nobody renews expires and its worker,
  if there still is one, is ended.
- **A worker decides nothing.** The session specification crosses the process boundary as data. Every tool call
  is sent back to the runtime, which runs the policy engine and answers. A worker that cannot reach the runtime
  refuses the tool call. A worker speaks only for the lease it holds; a message naming another lease is
  ignored.
- **A lost worker** (exit, kill, no heartbeat for 20 s, expired lease) is ended with its process tree, its
  lease is revoked or expired, and its session ends as `crashed`. The exit of a process is never read as the
  completion of its work: the orchestrator's existing rules decide what happens to the task from what is in
  the worktree, as for any crashed session.
- **A worker never outlives its runtime**: when the process channel closes it stops its sessions and exits.
  Therefore, after a restart of the runtime, nothing is killed by process id; the stale rows are marked and
  the leases expired.
- **Process trees.** A worker is ended with `taskkill /T /F` on its own pid, held as a child handle, so the
  provider process and the shells it started go with it. NEXUS kills no process it did not start. Children
  that detach themselves from the tree are not tracked in 0.7 (job objects are the 0.8 direction, see
  `WINDOWS_EXECUTION_ISOLATION.md`).
- **Scripted runs.** With the scripted agent runtime (UI tests) sessions run inside the runtime, because its
  simulated account is shared by all sessions; `NEXUS_FAKE_WORKERS=1` puts scripted sessions into workers.
  Real provider sessions always run in workers.

## 6. Global queue and scheduler

`src/shared/control-plane.ts`, `src/main/modules/control-plane/`.

- Work item types: mission, program, Arena campaign, workspace mission, background job, scheduled audit.
  Priorities `P0` to `P3`. States: `QUEUED`, `READY`, `RUNNING`, `PAUSED`, `QUOTA_WAIT`, `BLOCKED`,
  `SCHEDULED`, `FINALIZING`, `COMPLETED`, `FAILED`, `CANCELLED`.
- **Policy.** Capacity is two numbers: agent sessions at once and workloads at once. Free capacity is handed out
  in service order: priority, then the earlier deadline, then the stored position, then age. Running sessions
  are never taken away.
- **Fairness.** A waiting item is served one priority higher for every `agingMinutes` (default 30) it has
  waited, so a steady stream of urgent work delays lower-priority work but cannot keep it out for good. With
  the default a `P3` item is served as `P0` after 90 minutes.
- **Dispatch pause.** The user can pause dispatch (tray, Control Center): what runs keeps running, nothing new
  starts, no more capacity is granted. The setting is stored.
- **Decisions are recorded.** When an item's answer changes (started, granted n, waiting because …), one row
  goes to `scheduler_decisions`. The inspector shows them.
- **Usage.** While Claude is unavailable nothing starts and no more capacity is granted; items whose workload
  waits show `QUOTA_WAIT`, and the reset resumes them. The queue gates sessions only, but a run that is paused
  for the usage limit is paused as a whole, so its own verification and integration steps wait with it. Work of
  another provider does not continue during a Claude wait. Provider capacity is not modelled separately: the
  capacity is one number of sessions.
- The allocation is one pure function, `allocate`.

## 7. Schedules

Owned by the runtime, stored in the database, fired by the scheduler pass whether or not a window exists. An
occurrence is claimed in `schedule_firings` (primary key: schedule, occurrence) in the same transaction that
queues the work and moves the schedule to its next time. After a crash at any point an occurrence has fired
once or not at all, never twice.

## 8. Restart of the runtime

On start, before anything can dispatch: workers and leases of the earlier start are marked stale; runs that were
active are paused with reason `recovery` and never judged; tool approvals nobody waits for are expired. Then,
in the background, without making a window wait, the engines recover (Arena, programs, workspaces), the queue is read
against the workloads, missions are resumed if the user chose `resume`, and the overnight supervisor recovers
its run and checks its Windows failsafe. During this the runtime reports `RECOVERING` with counts; the window
shows them and stays usable.

## 9. Health

Nine components: database, global scheduler, worker manager, providers, Git, usage, IPC, power, schedules. Each
reports `HEALTHY`, `DEGRADED`, `RECOVERING` or `BLOCKED` and a sentence of evidence. The overall level is the
worst component.

## 10. Execution security

See `SECURITY.md` for the trust model, capabilities, the interpreter and package-script policy, the execution
profiles and the security decision log. The principle: NEXUS classifies and decides what an agent asks to
execute, including what an interpreter or a package script would run and who wrote it. That is a policy layer.
**It is not a sandbox.** Code that NEXUS allows to run, runs as the user. OS-level containment is the subject
of `V0_8_PROPOSAL.md`.

## 11. Compatibility

Migration 010 (workers, leases, worker events, schedule firings, scheduler decisions) and 011 (security decisions) are
additive. Databases of 0.1 to 0.6 open as before. The overnight signing key is stored per profile directory; a
key written by 0.6 cannot be read by the 0.7 runtime and is replaced, which ends the power authorization of an
overnight run that was in progress during the upgrade (the safe direction).
