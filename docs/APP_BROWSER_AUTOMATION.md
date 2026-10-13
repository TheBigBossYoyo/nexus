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
   answers before the start is somebody else's server and is not adopted. When the application is ready (a
   line it prints, a port, or an address that answers), its endpoint is registered for the session. Every field
   of the manifest is the repository's text, so what NEXUS does with it is limited:
   - `ready.pattern` is literal text, matched in any case, where `*` stands for any text. It is not a regular
     expression (a repository's pattern with nested repetition froze the runtime in the audit), it may hold
     printable ASCII only, and the matching looks for the segments in order and cannot backtrack
     (`readyLineMatches`). A local address in the matching line names the endpoint.
   - `ready.url` must be an http or https address on `127.0.0.1`, `localhost` or `[::1]`, without credentials.
     NEXUS sends the readiness request itself, so the repository does not get to choose the host, and it sends
     nothing to the port until the port is shown to be the application's own.
   - An address the application prints is taken for the application's own only when Windows says that every
     listener on that port, on any address, IPv4 or IPv6, belongs to a process the launcher started, and at
     least one of them is on an address that serves the registered host (`portOwner`). A foreign listener on
     the same port on another address makes it foreign: the application could otherwise share a port number
     with a service of the user's and have that service registered. A port registered to another session, or
     one of NEXUS's own, is refused. If Windows cannot say, the application is not opened.
   - What the application prints is kept in lines of at most 4,000 characters, 2,000 lines, and a line without
     a newline is cut at 8,192 characters and the rest dropped until the next newline, so an application that
     prints without end does not grow the runtime's memory.
4. **Electron.** The project's own Electron binary, with a profile directory of the session, on a desktop the
   launcher makes for it (as for every contained command, under both profiles): its windows are on no screen
   and take none of the user's input. If that desktop
   cannot be made, nothing is started. `electron.args` of the manifest is an allowlist, not a list of what is
   refused: plain positional arguments, and a few switches that are harmless (`--lang`, `--window-size`,
   `--window-position`, `--force-device-scale-factor`, `--force-color-profile`, `--high-dpi-support`,
   `--disable-gpu`, `--disable-software-rasterizer`, `--mute-audio`, `--hide-scrollbars`, `--start-maximized`,
   `--start-fullscreen`, `--disable-renderer-backgrounding`, `--force-prefers-reduced-motion`,
   `--disable-background-timer-throttling`), each with an optional value of letters, digits and `. , _ -`.
   Chromium has far too many switches that write files or load code, and takes `/switch` as well; anything
   else is refused and the application is not started (`electronArgProblem`). The application is started without Chromium's own sandbox, which cannot
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
application was started with, over the loopback. Its network is its containment's: under ISOLATED no
connection of its own but to the loopback, where the filter NEXUS gives it listens (and so to every other
service listening on the loopback), and names that Windows looks up for it, which are answered and can be seen
outside (`V0_8_SECURITY_MODEL.md`, "Network"); under RESTRICTED the user's network.

## What the agent sees

An accessibility snapshot in Playwright's AI form: one line per element, with a ref. 6,000 characters by
default; a larger tree is cut at a line, kept whole as a file of the session, and narrowed with a ref, a depth,
or `app_find`. A ref belongs to the snapshot it came from: after the page changes it names nothing, and the tool
says so. Screenshots are evidence for the user; the agent works from the tree. A screenshot over 8 MiB
(`MAX_SCREENSHOT_BYTES`) is deleted and the tool says so; the agent is told to take it again without
`full_page` or to use the snapshot.

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
- `tests/unit/browser/manifest.test.ts`: the hostile `ready.pattern` that froze the runtime returns at once
  against hostile output; `*` stands for any text, in order; the field takes printable ASCII only; a manifest
  handed to the manager without validation is refused before anything is started or requested.
- `tests/integration/browser/port-owner.test.ts`: a foreign listener on `127.0.0.1` with the application on
  `[::1]` on the same port is refused; the application alone on `127.0.0.1` is its own, and only for a host
  that address serves; a port nobody listens on is none.
- `tests/unit/process/spawn-long.test.ts`: 50 MB without a newline stays bounded and the next normal line still
  arrives; ordinary lines, also one split across chunks, are unchanged.

## Not built, or not verified

- Signed-in browsing and interaction with third-party sites: capabilities that need a grant; no tool exercises them.
- A setting in the window for what a project's application may reach besides itself.
- Screenshots as images for the model. The agent sees the tree.
- Desktop applications that are not Electron (Win32, WPF, WinUI): not started and not driven.
- The manifest's Electron arguments are limited to the allowlist above; an application whose manifest names
  anything else (including every switch NEXUS sets itself: debugging endpoint, profile directory, proxy, engine
  containment) is not started. An application that needs another switch cannot be driven by NEXUS until the
  list is extended.
- The debugging endpoint of an Electron application is a loopback port: another process on the machine that
  finds it can drive that application. It is the application under test, inside its containment; the endpoint
  gives nothing outside it.
- A manifest with several services (a front end and an API started separately). One command per application.
- Chromium's own sandbox inside an application under test (see above).
