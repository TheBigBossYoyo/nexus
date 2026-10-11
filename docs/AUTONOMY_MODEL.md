# Autonomy in NEXUS 0.8

How NEXUS decides what it may do without asking. Written 2026-10-11 from the code on
`nexus-0.8-isolation-autonomy`. The types are in `src/shared/autonomy.ts`; the decisions are made by
`src/main/modules/autonomy/broker.ts`.

## The idea

Before 0.8 NEXUS asked about actions: this command, this file, this fetch. Unattended, nobody answered, and the
action was refused; a repair session of the 0.7.2 campaign failed because it could not delete a scratch
directory it had made itself.

0.8 asks about a boundary, once. You enroll a project with a profile. What the profile covers runs without a
question, any number of times. What it does not cover becomes one boundary request, however often and by however
many agents it is met, and waits for you in one place while the rest of the work goes on.

A project that is not enrolled is unchanged: it asks as 0.7 did.

## Profiles

| Profile | Pre-authorized in the project |
|---|---|
| **Autonomous project** | Read the project; edit the task worktree; temporary files; local Git; tests, builds, linters, formatters; project commands and scripts inside the containment; installing project dependencies from the approved registries; starting the development server and the application; operating and inspecting the application under test (browser, screenshots, console, network); researching and fetching the public web; downloading research files into quarantine; reaching the registered local endpoints of the project |
| **Balanced** | The same, without: installing dependencies and reaching the registries, downloads, starting the server or the application and operating it |
| **Locked down** | Read, edit the worktree, temporary files, local Git, tests, builds, linters, formatters, project commands. No network of any kind, no application, no browser |

A capability a profile withholds can still be granted for the project, once: under Balanced the first
`pnpm install` asks, and with "always allow for this project" no later one does.

## Capabilities

Every capability has one of three kinds.

- **PROFILE**: a profile can pre-authorize it, for resources inside the project's boundary (a path in the task
  roots, a public host, a registered local endpoint).
- **BOUNDARY**: no profile includes it. It needs a grant. These are: reading secret files of the project;
  reading or writing outside the project and the task roots; pushing to a remote; changing remotes or shared Git
  configuration; rewriting or moving branches other than the task's; publishing a package; deploying; changing
  something on a third-party service; sending a message; using a credential or an account; browsing while
  signed in; unrestricted network or a named external host for project code; machine-wide installs; Windows
  configuration; elevation; running project code outside the containment; paid provider credits; a purchase.
- **NEVER**: no grant exists. Reading provider credentials; reaching NEXUS's runtime, database or keys; using
  your own browser profile; changing the security policy, a profile or a grant; disabling security software;
  power. Power stays with the Overnight authorization, which is separate and unchanged.

Some boundary capabilities cannot be allowed for good: a purchase, an elevation and paid credits can only be
allowed once; a deployment, a publication, a message and uncontained execution once or for a mission.

## Who decides

An agent never asks you. A worker, a planner, a Director and the Task Compiler ask the **capability broker**,
which answers from data you set and from rules that hold whatever that data says:

1. A NEVER capability is refused. An attempt on credentials or on NEXUS's own data is recorded as such.
2. The role must be one that can hold the capability at all (`role-contract.ts`). A verifier never writes and
   never asks to push; a Director and the Task Compiler can research and nothing else.
3. The project must be enrolled.
4. A PROFILE capability whose resource is inside the boundary and which the profile includes: **authorized**.
5. A grant that covers the need and is still in force: **authorized** (a ONCE grant is used up by it).
6. The same need was denied earlier in this mission: **denied**, with no new question.
7. Otherwise one boundary request exists for the need, new or already there: **boundary grant required**.

The broker reads no model output. The action text on a request is NEXUS's own redacted summary of the tool
call, not something the agent wrote for you to read.

### From a command to a capability

The command classifier of 0.7 still reads every shell command. In an enrolled project each of its findings is
read as a capability (`tool-capabilities.ts`):

- A finding that names a boundary (a push, a publication, a path outside the worktree, the registry, an
  elevation) is that boundary capability, whatever contains the process.
- A finding that only says "this cannot be inspected" (an encoded command, a script an agent wrote, a computed
  command name, inline code, a recursive delete in the worktree) is ordinary project execution **when the
  session is contained**, because the containment and not the inspection is the boundary. When the session is
  not contained it is the capability "run project code outside the containment", a question for you.
- What the policy forbade outright in 0.7 stays forbidden.

The whole 0.7 adversarial corpus is run through an enrolled authorizer in `tests/unit/autonomy/
enrolled-authorizer.test.ts`: no decision is ever "ask", nothing the policy refused is allowed, nothing it
allowed is lost.

## Boundary requests

A request records the project, the mission and task that first met it, the capability, the resource (a path, a
host, a remote), what was about to be done, why NEXUS asks, how many times it was met, and its answer.

- **One per need.** The key is project, mission, capability and normalized resource. A database index makes a
  second pending request for the same key impossible.
- **The agent is not blocked.** The tool call is refused with the request's id and the instruction to go on with
  what does not depend on it. A task that has nothing else to do reports a blocker that names the request.
- **Your answers:** allow once; allow for this mission; always allow for this project; deny. Only the scopes the
  capability has are offered. A grant for a named resource covers that resource: a path and what lies under it,
  a host and its ports and no subdomain, one remote.
- **"Always allow for this project"** also answers every other pending request of the project that it covers,
  and is confirmed by a native dialog the runtime shows itself. Enrolling a project is confirmed the same way.
- **Deny** holds for the mission. Another mission may ask again.
- A mission that ends takes its unanswered requests with it (they are kept, marked expired).
- **One notification** when a request is created ("1 boundary decision required"). The same need met again
  changes its count and tells nobody. No dialog opens by itself.

## What is recorded, quietly

Every decision of the broker is a row of the autonomy audit (`autonomy_audit`): when, which project, mission,
task and agent, the capability, the outcome, what authorized it (the profile's name or a grant's id), the
action, the resource, the reason. Severities: normal autonomous action, policy denial, injection detected,
boundary request, isolation failure, escape attempt, credential access attempt. Only a boundary request, an
isolation failure, an escape attempt and a credential access attempt are worth a notification. The log is
bounded; ordinary actions are pruned before denials.

Settings, Autonomy shows, per project: the profile and what it does and does not allow, the grants with their
scope and whether they are in force (and a way to take each back), the pending requests, and recent denials.

## The interruption count

The measure of this design is how often you are interrupted. `AutonomyService.missionMetrics(runId)` gives the
number of boundary requests of a mission; tool approvals are counted from the approvals table as before.

Tested, with the real orchestrator and scripted agents (`tests/scenarios/v8-autonomy.test.ts`,
`v8-research.test.ts`, `v8-containment.test.ts`):

| Mission | Approvals | Boundary requests |
|---|---|---|
| Three tasks, ten ordinary commands each (install, test, build, inline code, recursive deletes, commits, a hard reset) | 0 | 0 |
| The same in a project that is not enrolled | asks, as 0.7 did | 0 |
| Three tasks that each try `git push` three times | 0 | 1 (counted nine times) |
| A worker that searches the web, reads a page twice and goes on | 0 | 0 |
| A hostile page that tells the reader to fetch the local host and to push | 0 | 1, for the push the agent then tried, as for any push |
| Research under Locked down, four reads | 0 | 1 |

## Corrections after the real acceptance and the independent review (2026-10-11)

- **Allow once** is for the action you were shown. Another action that needs the same capability (a push to
  another remote, a request to another host) is a new question, not a use of that grant. Allow for the mission
  and for the project are by capability and resource, as their names say.
- **Only the isolated profile** makes a command NEXUS cannot read into (inline code, an encoded command, a
  script it has no record of) run without a question. Under RESTRICTED that is one boundary request: "run
  project code outside the isolated profile". Writes held to the task's directories and the allowlisted
  environment count under both.
- **What NEXUS did for a task is on the task's record.** A boundary request, a launch of the application and a
  screenshot are artifacts of the task (and of the task it repairs). A reviewer or a verifier finds them
  there; before this, real verifier sessions failed tasks for lack of evidence only NEXUS held.
- **Fewer false boundaries.** Reading the worktree's own `.git` entry, the text `echo` and `printf` print, and
  the text a .NET call writes are not places outside the project.
- **A mission stops at a boundary it cannot go around.** With nothing else to do, the session reports a
  blocker that names the request, the mission pauses, and one decision of yours is waiting. A grant given
  later does not resume the task by itself in 0.8: you resume the mission.

Measured with real sessions (Claude, the ISOLATED profile; `docs/acceptance/v08-acceptance-*.json`): a mission
that fixes a bug, runs the tests, reads a page of public documentation and starts, clicks and screenshots the
project's application: 0 tool approvals, 0 boundary requests, 0 dialogs. The same project with one deliberate
`git push`: 1 boundary request, nothing on the remote.

## What this does not do

- It does not make a model resist an instruction it reads. It makes the instruction worth nothing: what a
  session can do is fixed before it reads anything.
- It does not decide for you what a grant is worth. "Always allow push to origin for this project" means every
  later mission may push there.
- Grants survive unenrolling a project (they are yours) and are not read while it is not enrolled.
- The window is trusted. A program running as you at medium integrity that can drive the window can answer a
  request. Contained project code cannot: it has no way to the window or the pipe (`V0_8_SECURITY_MODEL.md`).
