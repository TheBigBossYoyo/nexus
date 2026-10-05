# NEXUS 0.8 Proposal: Isolation and Reliability

**Design and proposal only.** Nothing here is implemented, scheduled or promised. It is a plan for the owner to accept,
change or reject. Date: 2026-10-05. It builds on the research in `docs/WINDOWS_EXECUTION_ISOLATION.md`; the claims
marked NOT VERIFIED there are open here too.

## What 0.7 leaves behind

This section refers to `docs/V0_7_RELEASE_REPORT.md` and `docs/ONE_DOT_ZERO_READINESS.md` by name and does not quote
them, because the 0.7 report is to be rewritten. Read the current versions of both for the state of 0.7. As they exist
today they leave, among other things:

- a 0.7 that is not released and a persistent runtime that is not a process of its own (the control plane lives in the
  Electron main process);
- no worker processes, heartbeats or leases (the 0.7 worker manager is not built), so a session is a child of the main
  process and a crash of the main process takes the sessions with it, or leaves their children behind;
- the readiness report's condition on agent confinement (a restricted token or job object, or an explicit accepted
  risk), its condition on the open MEDIUM security findings, on the reliability campaign, on real evidence over time
  and on performance and soak tests;
- no OS sandbox: `docs/SECURITY.md` states that agents and everything they launch run as the user, and that the command
  classifier is a heuristic. The open HIGH finding is that a script an agent writes can run `shutdown`.

0.7 implements no containment. Its static inspection is not a sandbox.

## Goals

1. Process-tree ownership. Every process an agent session starts is owned by NEXUS, and is gone when the session ends,
   is cancelled, or NEXUS exits or crashes.
2. A measured reduction of what an agent's processes can do outside their task: shutdown, writes outside the
   worktree, registry writes, unrestricted network. Each reduction is stated with what it does not cover.
3. NEXUS stays correct when things fail: killed processes, full disks, locked files, a revoked login, a machine sleep,
   corrupted state. Failures are injected, not waited for.
4. Evidence over days: a soak test that runs real orchestrated work for long periods with resource and leak
   measurement.
5. Repository safety that holds against a repository built to attack NEXUS.
6. Documentation that says what is and is not contained, in the house style, with no sandbox claim that a test does
   not back.

## Non-goals

- A sandbox claim. 0.8 does not call any layer a sandbox unless the hostile-repository campaign (Phase 5) passes and
  the claim is limited to what it covered.
- Linux or macOS. NEXUS is a Windows product.
- Virtual machines as the worker model (Windows Sandbox, Hyper-V, WSL2). The research gives reasons.
- Protection against a malicious user, or against code that runs as administrator.
- Replacing the model providers' own safeguards, or the user's approval flow.
- Finishing 0.7's runtime as its own process, unless the owner decides it is a prerequisite (see open questions).
- A 1.0 release candidate.

## Threat model

Assets: the user's repositories and files outside the task, the machine's availability (power, resources), the user's
credentials and the agent's login, NEXUS's own database and state, other tasks' worktrees, the Arena evaluator.

Adversaries, in order of how likely they are:

| Adversary | Capability assumed | Examples |
|---|---|---|
| A. A mistaken agent | Runs commands it should not, with no hostile intent | `git clean` in the wrong directory, a runaway test that forks, a shutdown typed by habit |
| B. A prompt-injected agent | Hostile instructions from a file, web page or tool output steer a legitimate agent | An instruction in a README to run a script that rewrites a `.git` pointer or reads `~/.ssh` |
| C. A hostile repository | The repository itself contains hooks, configuration, install scripts, test code, symlinks or junctions, that run when NEXUS or the agent touches it | `core.fsmonitor`, `.claude/settings.json` hooks, `postinstall`, a `.git` file that points elsewhere, a path that escapes through a junction |
| D. A local process of the same user that tampers with NEXUS's state | Out of scope for containment; noted for the boundary work only | |

Assumptions: Windows 11, the user is a standard user or an administrator running NEXUS not elevated; the agent's
processes run as the user today. Not assumed: kernel exploits, a compromised model provider, physical access.

What the proposal does not claim to stop: reading the user's files (no layer except AppContainer or a dedicated user
covers reads), network exfiltration without a network layer, an agent that persuades the user to approve an action.

## Scope candidates, ranked

| Candidate | Value | Cost | Dependency | Recommended |
|---|---|---|---|---|
| Process-tree containment (job object, kill on close) | High; closes the leak left by `taskkill /T`; supports every later layer | Low to medium | A launcher (native helper) | Yes, Phase 1 |
| Windows-native worker containment (job plus token) | Medium to high; closes the shutdown finding | Medium | Phase 1 | Yes, Phase 2 |
| Filesystem capability enforcement | High for adversaries B and C; high compatibility risk | High | Phase 2 | Yes, as an opt-in layer, Phase 3 |
| Restricted tokens / AppContainer investigation | Informs the decision for 1.0 | Medium for a spike | Phase 1 launcher | Yes, as time-boxed spikes, Phase 3 |
| Network controls | High for exfiltration; cannot be done at user level without another identity | High; needs administrator once | A decision on a dedicated account | Research only; implement only if the owner accepts the admin step |
| Hostile repository execution | High; the campaign is what makes any claim testable | Medium | Phases 1 to 3 | Yes, Phase 5 |
| Fault injection | High for reliability | Medium | None for the framework | Yes, Phase 4 |
| Long soak testing | High; named in the readiness report | Low to build, high in elapsed time | Phase 4 | Yes, Phase 6 |
| Stronger repository safety | High; the open MEDIUM findings (forced ref moves, `.claude/settings.json` hooks, bare `git` resolution, evaluator readable at evaluation) | Low to medium | None | Yes, Phase 0 |

## Phased plan

Each phase has acceptance gates that are measurable. A gate is met only by a recorded run on the commit in question;
a gate without evidence is NOT VERIFIED in the release report.

### Phase 0: close the known open findings (repository safety)

Scope: the open MEDIUM findings listed in `docs/SECURITY.md` (ref moves outside `nexus/`, text rendered into prompts
without a fence, repository `.claude/settings.json` hooks, overnight default approvals, the Arena evaluator readable
during evaluation, bare `git` resolved by the search path). Add a regression test for each that fails without the fix.

Exit criteria:
- every listed finding has a named test that fails on the previous commit and passes on the new one;
- `docs/SECURITY.md` lists zero open MEDIUM findings from that review, or states per finding why it stays open;
- the 0.6 hardening tests still pass.

### Phase 1: process-tree containment

Scope: a launcher that starts every agent session (and every NEXUS-run project command) inside a job object with
kill-on-close, no breakaway, an active-process limit and a memory limit; replaces `taskkill /T` as the primary kill;
reports job accounting. Delivery vehicle chosen in a decision record: native helper, or a wrapper passed to the Agent
SDK, or koffi (see open questions).

Exit criteria:
- A test spawns a tree including a detached process and a grandchild whose parent has exited, kills NEXUS's main
  process abruptly (not gracefully), and finds zero processes of the tree after 5 seconds, in 100 of 100 repetitions.
- The same test with the current `taskkill /T` path is recorded as the baseline, so the improvement is a measured
  difference and not an assertion.
- A fork-bomb-shaped test (a process that starts children without end) stops at the configured process limit and does
  not raise the machine's process count by more than the limit; NEXUS's UI stays responsive (a main-process event
  loop lag below a stated bound, set from a measurement before the phase starts).
- Claude and Codex real sessions complete a representative task inside the job with no behavior change (same pass
  result on the existing acceptance scenarios; breakaway use by the tools measured, so the open NOT VERIFIED item is
  closed).
- Start-up cost of a session is measured before and after; the regression is stated, with a limit agreed in advance.

### Phase 2: token hardening for worker processes

Scope: processes started with a token that has `SeShutdownPrivilege`, `SeRemoteShutdownPrivilege` and other
unneeded privileges removed; `JOB_OBJECT_UILIMIT_EXITWINDOWS` and UI-handle restriction on the job. No restricting SIDs
yet.

Exit criteria:
- On a disposable machine, `shutdown /s /t 3600`, a direct `InitiateSystemShutdownEx` call and a script that
  calls either, run from inside a worker, fail in 20 of 20 attempts, and `shutdown /a` from inside a worker cannot
  cancel an overnight shutdown armed by NEXUS (the NOT VERIFIED items in the research document become verified or
  corrected).
- Overnight mode's armed shutdown still works from NEXUS's own process, unchanged.
- Git, Node, pnpm, Python, PowerShell, bash, `claude.exe` and `codex exec` pass the compatibility matrix (Phase 3's
  matrix, first column).

### Phase 3: filesystem capability enforcement and spikes

Scope:
- Filesystem capability: a per-run write root. First choice, a write-restricted token with a per-run synthetic SID and
  ACEs on the worktree, the temp directory and an enumerated list of cache directories. It is opt-in per project
  until the matrix passes. A write outside the grant fails at the operating system.
- Time-boxed spikes, each ending in a written decision: (a) AppContainer / LPAC against the matrix; (b) Low integrity
  against the matrix; (c) a dedicated local user with firewall rules for network control, measuring what an
  administrator-once setup would cost the user.
- The compatibility matrix: `git` (clone, worktree add, commit, merge), `node`, `pnpm install` and `pnpm test`,
  `python` and `pytest`, PowerShell, Git for Windows `bash`, `claude.exe` with network and a login, `codex exec`.

Exit criteria:
- The matrix is recorded per mechanism with pass or fail per cell, with the failing commands and errors.
- With the write-restricted layer on, a write attempted from inside a worker to the user's home directory, to the
  user's original repository and to another task's worktree fails in 100 percent of a test set of at least 50 distinct
  paths and methods (file API, `cmd /c`, PowerShell, Python, Node, Git), and the ACE list added by NEXUS is
  enumerated in the report so the writable surface is known.
- NEXUS removes every ACE it added when a run ends, and after a simulated crash removes leftovers at next start
  (checked by comparing ACLs before and after across 100 runs).
- Each spike ends in "adopt", "defer" or "reject" with the evidence; a spike that is not finished is reported as not
  finished.

### Phase 4: fault injection

Scope: a harness that injects failures at defined points of the orchestrator, the control plane, the worker launcher
and the git layer: kill a session process; kill the launcher; kill NEXUS during a merge, a commit, a migration and a
queue write; fill the disk; lock a file; revoke the login mid-session; sleep and resume the machine; corrupt a state
file; drop and delay the model API. Deterministic and seeded, in the style of the existing seeded stresses.

Exit criteria:
- At least 20 distinct injected fault points, each with an expected state and recovery, listed in a document.
- 5,000 or more seeded histories per engine with injected faults, the orchestrator included, with zero invariant
  violations (no lost task, no double merge, no worktree pointing at another repository, no orphan process, no
  unrecorded failure).
- A mutation check as in the 0.7 control-plane stress: a deliberately broken recovery rule is caught by the harness.

### Phase 5: hostile repository campaign

Scope: a corpus of repositories built to attack NEXUS and its agents: hooks, `core.fsmonitor`, `core.pager`,
`.gitattributes` filters, submodules with `ext::` URLs, a `.git` file that points elsewhere, symlinks and junctions
that leave the worktree, long and reserved Windows names, `postinstall` scripts, `.claude/settings.json` hooks,
test code that attempts shutdown, registry writes and network connections. Run under each layer enabled so far.

Exit criteria:
- Each corpus entry has a stated expected outcome per layer (blocked, contained, not stopped), recorded before the
  run; the run result is compared with it.
- No entry executes code in NEXUS's own process context or writes to the user's repository; any that does is a fixed
  defect with a test before the phase ends.
- The report lists every entry that is not stopped, and says why, so the "not stopped" list is as visible as the
  "stopped" list.

### Phase 6: soak and reliability evidence

Scope: real or recorded-replay orchestrated work for at least 72 hours of wall time on one machine, with periodic
sampling of memory, handles, process count, database size, and disk use; at least one forced usage limit and one
machine sleep; the installer run on a clean machine.

Exit criteria:
- Memory, handle count and process count of the NEXUS processes show no monotonic growth beyond a bound stated before
  the run, over the final 48 hours.
- Zero orphan processes after the run (the job accounting from Phase 1 is the measure).
- Every injected fault point of Phase 4 that applies has fired at least once during the soak with recovery recorded.
- The report states the machine, the duration, the workload and every anomaly, and names what was not measured.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| A tool needs breakaway or its own job (Codex's own sandbox, MSYS2, pnpm) | Containment breaks the tool | Phase 1 measures it first; nested jobs on Windows 8 and later; per-provider opt-out stated, not hidden |
| Write-restricted tokens break caches and give a false sense of safety | Tasks fail, or users disable the layer; the ACE list becomes the attack surface | Opt-in until the matrix passes; enumerate and clean up ACEs; state what it does not cover |
| Native helper flagged or quarantined by antivirus (as Electron binaries have been on this machine) | The launcher does not run | Test with the installed antivirus early; sign the binary; fall back to the job-only path, stated |
| Nested sandbox interaction with `codex exec` | Codex fails to start commands | Matrix before enabling any token layer for Codex; keep job-only for Codex if needed |
| The shutdown test shuts a machine down | Data loss on the test machine | Long delays plus abort, a disposable machine first |
| Administrator-once setup for network control is unacceptable to users | The network threat stays open | State it as open; do not claim a network control that needs admin without the user's decision |
| Scope: the phases are many | 0.8 is not finished | Phases 0 to 2 are the core; later phases are cut by the owner, and what is cut is listed in the 0.8 report as NOT IMPLEMENTED |
| Soak elapsed time | Delays the release | Start the soak harness during Phase 4 on a spare machine |
| ACL and token code is security-critical and error-prone | A bug is a vulnerability | Independent review of the helper; tests that fail without each control; fuzzed inputs for paths |

## Open questions

1. Is the persistent runtime as its own process (not built in 0.7) a prerequisite for 0.8, or does 0.8 contain the
   existing in-process sessions? A launcher fits either, but the worker-manager design (leases, heartbeats) interacts
   with the job lifetime.
2. Native helper executable, wrapper passed to the Agent SDK, or koffi? Does the SDK accept an executable override
   or a custom spawn? (NOT VERIFIED.)
3. Does the owner accept an administrator-once step for a dedicated account and firewall rules, for the network
   threat, or is user-level-only a requirement?
4. Which Windows builds are supported (Windows 11 only)? Does Windows 10 matter for the child-process policy and nested jobs?
5. How should the Codex provider be treated given its own Windows sandbox: contain from outside, rely on its own, or
   both?
6. Should containment be on by default, opt-in per project, or per mode (overnight on, interactive off)?
7. How much compatibility breakage is acceptable before a layer is considered failed (a pass-rate threshold on the
   matrix)?
8. Where does the soak run (a spare machine, or the development machine, given the memory note that heavy suites run one
   at a time)?
9. What does the product say to the user about what is and is not contained, in the settings, in the approval dialogs
   and in `SECURITY.md`?
10. How are the NOT VERIFIED items of `docs/WINDOWS_EXECUTION_ISOLATION.md` assigned to phases (the shutdown tests to
    Phase 2, tool behavior in jobs to Phase 1, the rest to Phase 3)?

## Out of 0.8, left for later

Per-host network allow-lists, virtual-machine workers, WDAC/AppLocker policy, a second provider's own sandbox
integration beyond the compatibility matrix, and the 1.0 conditions that do not concern isolation (the Arena
comparison, accessibility items). They stay in `docs/ONE_DOT_ZERO_READINESS.md`.
