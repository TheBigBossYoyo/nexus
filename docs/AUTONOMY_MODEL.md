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

The broker reads no model output to decide. The action text on a request is NEXUS's own summary of the tool
call, redacted and shortened (`actionSummary`), not something the agent wrote for you to read. It still holds
what the call was asked to do (the command, the address), which an agent chose, so it is cleaned of the
characters that reorder or hide text (bidirectional overrides and isolates, control characters) before it is
stored or shown (`cleanAgentText`), and the window says when the text shown was shortened or had values hidden
(`actionTruncated`). Where another session reads it in NEXUS's own records (the task's record of a boundary
request or of your answer), it is introduced as the text of the command that was attempted, on a line of its
own as a JSON string, and is data, never an instruction (`quotedAction`; `tests/unit/autonomy/resume.test.ts`).

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

- **One per need, and for a boundary capability one per action.** The key is project, mission, capability and
  normalized resource. For a capability that no profile includes (a push, a publication, a deployment) a
  different action is a different question: a push to another remote, or a different command, is put to you
  as a request of its own, and the same action tried again is the same request, counted. For a capability a
  profile merely withholds (installing dependencies under Balanced) the need stays one question for the
  project whatever the command, because its answer covers them all. A request carries a SHA-256 of the exact
  call it was raised for (`actionHashOf`, migration 019); a database index makes a second pending request
  impossible for the same key and the same hash. At most 12 distinct requests for one capability are put to
  you in one mission (`MAX_BOUNDARY_REQUESTS_PER_CAPABILITY`); after that the call is denied with a sentence
  that says so, and no further question is asked.
- **The agent is not blocked.** The tool call is refused with the request's id and the instruction to go on with
  what does not depend on it. A task that has nothing else to do reports a blocker that names the request.
- **Your answers:** allow once; allow for this mission; always allow for this project; deny. Only the scopes the
  capability has are offered. A grant for a named resource covers that resource: a path and what lies under it,
  a host and its ports and no subdomain, one remote.
- **"Always allow for this project"** also answers every other pending request of the project that it covers,
  and is confirmed by a native dialog the runtime shows itself. The dialog shows the action you were shown and
  says what the grant covers: when the resource is "any", it says that the grant covers EVERY such action in
  the project, to any place, now and in every later mission, and not only the one shown. Enrolling a project
  is confirmed the same way. With no way to show the dialog, a project-wide grant and a widening enrollment
  are refused, and the request stays pending (`autonomy-handlers.test.ts`).
- **Deny** holds for the mission, for that capability and resource and for any action: the agent does not get
  to ask again in other words. Another mission may ask again.
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
| Three tasks that each try the same `git push origin HEAD` three times | 0 | 1 (counted nine times) |
| A worker that searches the web, reads a page twice and goes on | 0 | 0 |
| A hostile page that tells the reader to fetch the local host and to push | 0 | 1, for the push the agent then tried, as for any push |
| Research under Locked down, four reads | 0 | 1 |

## Corrections after the real acceptance and the independent review (2026-10-11)

- **Allow once** is for the action you were shown, and it is bound to a hash of that action, not to the text
  you read (which may be shortened or redacted). For a shell tool the hash is of the command, character for
  character; for another tool, of its input with the keys in a fixed order. What only accompanies the call
  (the agent's own description of it, a time limit, a flag to run it in the background) is not part of it, so
  the same command tried again after you allowed it once is the same action however the agent words it the
  second time, and two commands that differ by one character are two actions. Another action that needs the
  same capability (a push to another remote, a request to another host) is a new question, not a use of that
  grant. A grant whose request is missing, or was made before the hash existed, covers nothing.
  `tests/unit/autonomy/broker.test.ts`. Allow for the mission and for the project are by capability and
  resource, as their names say.
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
  blocker that names the request, the mission pauses, and one decision of yours is waiting. When you answer,
  NEXUS starts the work again itself (next section).

Measured with real sessions (Claude, the ISOLATED profile; `docs/acceptance/v08-acceptance-*.json`): a mission
that fixes a bug, runs the tests, reads a page of public documentation and starts, clicks and screenshots the
project's application: 0 tool approvals, 0 boundary requests, 0 dialogs. The same project with one deliberate
`git push`: 1 boundary request, nothing on the remote.

## When you answer: the work that waited goes on

`BoundaryResumer.decided` (`autonomy/resume.ts`) runs after the answer is stored, whether it was an allow or a
deny. It restarts the tasks of the mission that waited for the request: the task that asked (or, if that was a
repair attempt, the task it repairs), and any blocked or failed task whose reported reason names the request's
id. A task that only mentions the capability by its label is not thereby waiting. A mission that was paused only
because of this is resumed. Nothing is replayed: the task runs again from the worktree as it is, in a fresh
session, and whatever it asks for is decided again by the broker against the grant as it stands then.

- What is checked first: the mission exists and has not ended; the project is still enrolled; for an allow,
  that the grant was not taken back in the meantime; and, for a paused mission, that it was paused for
  intervention and not by your own hand, by a quota or for recovery, and that no other top-level task of it
  still needs attention. A check that does not hold leaves everything as it is and says why.
- At most 3 restarts of one task by boundary decisions. The fourth is left to you, and the outcome says so.
- What the task finds on its own record is an artifact (`boundary-decision`): that you allowed (once, for the
  mission or for the project) or denied, and the action, quoted as data. For a deny the task is told that this
  part will not be done in this mission, not to reach it another way, to finish what does not depend on it,
  and to say plainly in its result that the user declined it. The broker answers the same request with a
  refusal for the rest of the mission and asks nothing new.
- The inbox shows, under each decided request, what NEXUS did (tasks started again, mission resumed, or the
  reason nothing was). The line is read from the autonomy audit (`followUp`).

Tested in `tests/unit/autonomy/resume.test.ts`, `tests/scenarios/v8-resume.test.ts` (allow for the mission,
deny, a mission that waits for something else and stays paused, a grant taken back) and the last test of
`tests/e2e/v8.spec.ts`.

### A push you allowed

Pushing is outside every profile, so it waits for you. Once you allow it, it has to run where it can work: as
you, with your network and your way of signing in to the remote. No containment of NEXUS has those, and the
first real mission that was resumed after a grant showed it: the grant was honoured, the task was started
again, and the push then ran as the sandbox account and failed. So an allowed push is the one command that
runs outside the containment, and it is held to the rule of git as the user: the agent's text is parsed and
NEXUS writes what runs.

- What qualifies is a line of plain git with a push in it (`git push origin HEAD`, or
  `git add -A && git commit -m "x" && git push origin HEAD`): every git on the line is one git as the user
  accepts, and each push has options from a short list (`-u`, `--set-upstream`, `--force-with-lease`, `-q`,
  `-v`, `--porcelain`; not `--force`, `--delete`, `--mirror`, `--all`, `--tags`, `--receive-pack`,
  `--no-verify`), at most a remote and one refspec. The remote is a name your repository's configuration knows,
  never an address or a path on the line. The line is cut where a push stands: each push runs as you, and the
  git around it runs as git as the user does, inside the containment.
- The script names the Git directory and the repository NEXUS recorded, an empty hooks directory (a `pre-push`
  hook is a program of the repository), and says `HEAD` as the worktree's own branch. It lies in NEXUS's data,
  where no contained code writes. Your own git configuration applies: it holds the remote and the sign-in.
- A push in any other form (piped into another program, joined to a command that is not git, with another
  option) can never run, so it is refused at once with what to write instead, and no question is put to you
  for it. (The second real run under RESTRICTED met this: the agent retried the allowed push inside a longer
  line, and it failed.)
- Git LFS objects are not uploaded by it (no hooks run).

`tests/unit/policies/git-user.test.ts` ("a push the user allowed"), `tests/integration/git/user-git-script.test.ts`
(a real push to a local remote with a hostile hook, a forged `HEAD` and a planted configuration), and the
"resume" mission of `scripts/v08-acceptance.mjs`.

## While you are away

A mission runs in the runtime, not in a window. A closed window, a locked screen or a night changes nothing
about what NEXUS may do in an enrolled project: the authority is the stored enrollment and the stored grants,
and no window is consulted or can widen it. `unattendedPolicy(profile)` states it, and Settings, Autonomy
shows it under "While you are away". It has four lists.

- *Goes on:* what the profile allows, exactly as when you are there.
- *Waits:* what needs a grant and has none. It becomes one stored boundary request; the task that met it
  stops, work that does not depend on it goes on, nothing is retried against a refusal and nothing waits on a
  dialog. When you answer, whenever that is, the work that waited is started again.
- *Never happens:* the NEVER capabilities, attended or not.
- *Needs you present:* enrolling a project or widening its profile; allowing something for a whole project; the
  one-time setup of the sandbox account (a Windows administrator prompt). Each is confirmed natively by the
  runtime, so unattended, none of them happens. Allowing for the mission needs no confirmation.

`tests/integration/persistence/unattended.test.ts`.

## What this does not do

- It does not make a model resist an instruction it reads. It makes the instruction worth nothing: what a
  session can do is fixed before it reads anything.
- It does not decide for you what a grant is worth. "Always allow push to origin for this project" means every
  later mission may push there.
- It does not yet name the remote or the host in every request. A push, a request for the external network, a
  publication and an uncontained execution still carry the resource "any", because the command classifier
  does not give a remote or a host for them. So "always allow" on such a request covers every such action in
  the project, not the one shown; the confirmation says so, and a once-grant is the narrow answer for these
  (it is bound to the exact command).
- Grants survive unenrolling a project (they are yours) and are not read while it is not enrolled.
- The window is trusted. A program running as you at medium integrity that can drive the window can answer a
  request. Contained project code cannot: it has no way to the window or the pipe (`V0_8_SECURITY_MODEL.md`).
