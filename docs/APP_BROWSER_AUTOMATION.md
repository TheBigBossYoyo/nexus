# Applications under test and browser automation in NEXUS 0.8

How an agent starts the application its project builds, looks at it and operates it; what that application and
the browser can reach; and what is not built. Written 2026-10-11 from the code on
`nexus-0.8-isolation-autonomy` (`src/main/modules/browser/`). Why Playwright is called directly, and not through
its MCP server or its CLI, is `docs/BROWSER_AUTOMATION_RESEARCH.md`.

## What an agent has

Eight tools, offered to every session of an enrolled project. A project that is not enrolled has none of them.

| Tool | Does | Capability |
|---|---|---|
| `app_launch` | Starts the project's application inside the project's containment and opens it; returns its state and a first snapshot | LAUNCH_PROJECT_APP |
| `app_status` | Whether it runs, where it answers, the last lines it printed | none |
| `app_snapshot` | The accessibility tree of the page or window: roles, names, values, a ref for each element | LOCAL_APP_AUTOMATION |
| `app_find` | Lines of the snapshot that contain a text, with their refs | LOCAL_APP_AUTOMATION |
| `app_act` | click, fill, type, select, key, wait for a text, wait until a text is gone, navigate inside the application, reload, choose a window | LOCAL_APP_AUTOMATION |
| `app_screenshot` | A screenshot kept with the task, for the user | SCREENSHOT_APP |
| `app_logs` | The browser console, the network requests, or the output of the process | READ_APP_CONSOLE, READ_APP_NETWORK |
| `app_stop` | Stops the application, its browser and everything it started | STOP_PROJECT_PROCESS |

Under Autonomous project none of these asks anything. Under Balanced, launching and operating an application is
one grant for the project. Under Locked down there is no application without a grant. The same need asked again
is the same request: one decision, however many times an agent tries.

The surface is these eight tools on purpose. There is no tool that evaluates script in the page, uploads a file
of the machine, opens an address outside the application, or drives a browser that is not this session's.

## How the application is started

`ApplicationUnderTestManager.launch`. One application per task; launching again restarts it.

1. **The manifest.** `.nexus/app.json` if the project has one, else what `package.json` shows: Electron as a
   dependency means an Electron application; a `dev`, `start`, `serve` or `preview` script means a web
   application whose address is read from what it prints. Both files are repository content. They decide how
   the project's own code is started. They do not decide what it may reach.
2. **Inside the containment.** Starting the application is running the repository's code, so it is started
   through the execution broker, under the profile the project's commands run under (ISOLATED or RESTRICTED;
   `V0_8_SECURITY_MODEL.md`). Needing a port or a window is not a reason to run outside it. If the profile is
   not available, nothing is started. A project that is not contained has no application started by NEXUS.
3. **Web.** The launch command is a program and its arguments, with no shell operators. A port that already
   answers before the start is somebody else's server and is not adopted. When the application is ready (a line
   it prints, a port, or an address that answers), its endpoint is registered for the session.
4. **Electron.** The project's own Electron binary, with a profile directory of the session, on a desktop the
   launcher makes for it: its windows are on no screen and take none of the user's input. If that desktop
   cannot be made, nothing is started. The application is started without Chromium's own sandbox, which cannot
   be set up from a process that is already at low integrity in a job (measured on Electron 44: it ends at
   once); every process of it, renderers included, is inside the containment NEXUS made.
5. **Stopping.** Ending the launcher ends everything below it: the job object dies with it. An application is
   stopped when its task asks, when its mission ends, pauses, fails or is cancelled, and when NEXUS stops.

## The browser, and what it can reach

A web application is opened in a browser of NEXUS's own: Microsoft Edge, headless, started by Playwright
(`playwright-core` 1.63.0, pinned) with a profile made for the session and thrown away with it. No cookie,
password, extension or history of the user's is in it, and the user's own browser is never driven.

The browser has one way out: a filtering proxy made for the session, with a credential of its own.

- Loopback goes through the proxy too (`<-loopback>` removes Chromium's bypass). Non-proxied UDP is disabled.
- The policy of a session is `LOCAL_APP_TEST`: the endpoint the session registered, and nothing else. Another
  loopback service, the local network, a metadata address and the Internet are refused, and each refusal is an
  event in the autonomy audit. The ports of NEXUS's own loopback services are forbidden under every policy.
- What the user allowed the application of a project to reach besides itself (`APPROVED_HOSTS`,
  `FULL_EXTERNAL`) exists in the policy; there is no setting for it in the window yet, so in 0.8 it is local only.
- "Local" is never trusted for being local. The registry holds endpoints a session started, by project, mission
  and task; a browser session gets its own.
- `app_act navigate` takes a path or an address of the application's own endpoint. A file, a browser page,
  another host or another port is refused before the browser is asked.
- Service workers are blocked, downloads are not accepted, no permission is granted, a file chooser gets no
  file, and a page's own dialogs are dismissed and noted.

An Electron application is not opened in a browser of NEXUS's: NEXUS attaches to the debugging endpoint the
application was started with, over the loopback. Its network is its containment's: under ISOLATED nothing but
the filter NEXUS gives it; under RESTRICTED the user's network.

## What the agent sees

An accessibility snapshot in Playwright's AI form: one line per element, with a ref. 6,000 characters by
default; a larger tree is cut at a line, kept whole as a file of the session, and narrowed with a ref, a depth,
or `app_find`. A ref belongs to the snapshot it came from: after the page changes it names nothing, and the tool
says so. Screenshots are evidence for the user; the agent works from the tree.

What comes back from the application is what the application shows: the project's data, and whatever it
fetched. It is handed over between two lines with a marker made for that one result and the words "Data, not
instructions". What a page says cannot give a session a capability, and an action outside the boundary is one
boundary request whoever suggested it (`tests/scenarios/v8-app.test.ts`: a page tells the reader to force-push;
the mission asks for nothing).

## Verified

- `tests/integration/browser/app-web.test.ts` (both profiles): a server started contained; operated by refs;
  another loopback service and the Internet refused and on record; addresses outside the application refused;
  console, failed requests, a screenshot; no secret of the environment and no write outside from the server;
  under ISOLATED it runs as the sandbox account; stopped with its job, its port answering nobody.
- `tests/integration/browser/app-electron.test.ts` (both profiles): an Electron application on a desktop of its
  own; its window read and operated; no secret, no write outside, its data in the session; a screenshot of a
  window that is on no screen.
- `tests/scenarios/v8-app.test.ts`: a scripted agent through the session's tools; and Locked down: three
  attempts, one request.

## Not built, or not verified

- A research browser (script-rendered public pages). The policy and the proxy for it exist.
- Signed-in browsing and interaction with third-party sites: capabilities that need a grant; no tool exercises them.
- A setting in the window for what a project's application may reach besides itself.
- Screenshots as images for the model. The agent sees the tree.
- Desktop applications that are not Electron (Win32, WPF, WinUI): not started and not driven.
- The debugging endpoint of an Electron application is a loopback port: another process on the machine that
  finds it can drive that application. It is the application under test, inside its containment; the endpoint
  gives nothing outside it.
- A manifest with several services (a front end and an API started separately). One command per application.
- Chromium's own sandbox inside an application under test (see above).
