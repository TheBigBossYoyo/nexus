# Reliability of NEXUS 0.8

What was done to find out whether the 0.8 work holds up when things go wrong and when it is used many times
over; what was found; what was not tried. Written 2026-10-11 on `nexus-0.8-isolation-autonomy`. The numbers of
the final runs are in `V0_8_RELEASE_REPORT.md`.

## Failures injected, and what the system did

Each line is a test that runs against the real launcher, the real job object and, where a browser is
involved, a real headless browser. Nothing here is simulated except the agent.

| Fault | What happens | Test |
|---|---|---|
| The launcher is missing | No command of an enrolled project runs; the tool call is refused with "Nothing is run outside the containment"; no fallback | `scenarios/v8-containment` |
| A profile was not verified at this start, or ISOLATED is asked for without the account | Refused, with the reason | `integration/isolation/containment` |
| A containment that was asked for cannot be made | Recorded as an isolation failure, the user is told once, nothing runs | broker `onFailure`, `core.ts` |
| A command exceeds its time limit | The job is ended; exit 124 | `containment` (both profiles) |
| A command leaves a detached grandchild | It ends with the command | `containment` (both profiles) |
| A command forks past its process limit | Stopped at the limit; the machine is not | `containment` (both profiles) |
| The launcher of a running application is killed from outside | The application and its port are gone with the job; the session reads as ended | `integration/browser/app-faults` |
| An application ends while starting | Reported with what it printed; nothing registered, nothing left | `app-faults` |
| An application never becomes ready | Given up at its time limit and ended; no process left | `app-faults` |
| An application dies while it is used | Seen as ended with its exit code; the tools say so; it can be launched again | `app-faults` |
| The proxy of a session goes away | The browser reaches nothing: there is no direct way | `app-faults` |
| An application names a port it does not hold | Not opened | `app-faults` |
| Two sessions at once | Each browser reaches its own endpoint and no other; stopping one leaves the other | `app-faults` |
| A mission ends, pauses, fails or is cancelled | Everything it started is stopped; its endpoints leave the registry | `app-faults`, `scenarios/v8-app` |
| A page asks for a file, a download, a permission, a dialog | No file is given, nothing is downloaded, nothing is granted, the dialog is dismissed and noted | `browser/provider.ts`; not each tested separately |
| A fetch is redirected to a private address, answers with a mix of public and private addresses, or expands without end | Refused; cut at the limit | `integration/network/fetch-proxy` |
| Two NEXUS instances share the sandbox root (an installed one and a development one, or parallel test processes) | Each has its own session directories and its own copy of the launcher; neither sweeps the other's | found by the test suites running together; fixed |

## Found by using it for real

Four acceptance runs with real Claude sessions under the ISOLATED profile came before the first that passed (run 5).
What they found is in `V0_8_PROGRESS.md` ("What the real acceptance found") and is the most useful reliability
result of this release, because none of it was visible to scripted agents:

- git in any command that was more than git found no repository (the sandbox account could not read it);
- a harmless line git prints after every commit read as a failure, and sessions reported themselves blocked;
- `git diff` died on a hardening setting;
- three ordinary commands were put to the user as boundary requests;
- verifiers failed correct work for lack of evidence that only NEXUS held (a screenshot, a refused push).

Each has a regression test now. The lesson kept: a scripted agent runs the commands the test author thought
of; a real one runs `git log --oneline | head -3; git status --short` and `cat .git`.

## Soak

`tests/stress/isolation-soak.test.ts` (`pnpm stress`), RESTRICTED, headless:

- 400 contained commands in sequence, of which 40 fail by design, 16 run into their time limit and 40 leave a
  detached child: every one accounted for, no process left, no spec file left, no launch refused. 106 seconds.
- 40 launches of an application, each opened in a browser and clicked, 8 ended by a crash of the application,
  8 launched over while running: no listening port, no process, no proxy, no registered endpoint left. 81 seconds.

Not done: a soak of hours; a soak under the ISOLATED profile; a soak of real sessions; memory growth of the
runtime over a long mission with many application launches.

## What was not tried

- Loss of power or a kill of the runtime while an application under test runs. The job dies with the
  launcher, and the launcher dies with the runtime's child; this was reasoned, and tested only for the
  launcher being killed.
- The elevated setup failing halfway (an account made, the firewall rule not). The setup reports each step and
  the isolated profile is not used unless its verification at start holds; the half-made state was not produced.
- The setup started from the window. The account on the test machine was made by the script
  (`scripts/sandbox-setup.mjs`); `isolation.setup` over IPC shares its steps and was not run, because it
  raises a Windows elevation prompt.
- A machine without Microsoft Edge, without Git for Windows, or with a different Git version than 2.53.
- A project whose worktree and repository are on different volumes, or on a network share.
- Disk full in the sandbox root; a sandbox root removed while NEXUS runs.
- Windows versions other than Windows 11 Pro 26200.
- The low-memory condition that stopped one acceptance run from outside (2026-10-11): the run left nothing
  behind, which was looked at; how the runtime itself behaves when Windows is out of memory was not tested.
