# Browser and App Automation for Coding Agents: Research

Research and recommendation for NEXUS 0.8. Date: 2026-10-11. Nothing in this document is implemented. No source code
was changed, nothing was installed and nothing was downloaded. Statements are marked by origin: **MEASURED** (run on
this machine, scripts in `test-results/browser-research/`), **DOCS** (read on the sources at the end on 2026-10-11),
**ESTIMATED** (derived from documentation, not run). Claims that could not be confirmed are marked **NOT VERIFIED**.

## The question

NEXUS 0.8 gives its coding agents (Claude through the Claude Agent SDK, and Codex) tools to launch the web or Electron
app they are building, inspect it, click, type and fill, read console and network, take screenshots, and browse the
public web for research in an isolated ephemeral profile. NEXUS exposes its own small tool surface (`app_launch`,
`app_stop`, `app_reload`, `browser_navigate`, `browser_snapshot`, `browser_find`, `browser_click`, `browser_type`,
`browser_fill`, `browser_select`, `browser_key`, `browser_screenshot`, `browser_console`, `browser_network`,
`browser_wait`, `browser_trace`: 16 tools) behind a `BrowserAutomationProvider` interface. The question is the backend:

- **PLAYWRIGHT_DIRECT**: the `playwright` library called in a trusted NEXUS process.
- **PLAYWRIGHT_CLI**: `@playwright/cli` (`playwright-cli`), Microsoft's command line for coding agents.
- **PLAYWRIGHT_MCP**: `@playwright/mcp`.

## What was found

### Versions seen (npm registry, 2026-10-11)

| Package | `latest` | Published | Notes |
|---|---|---|---|
| `playwright` | 1.64.0 | not recorded | `next` is 1.65.0-alpha-2026-10-11 |
| `@playwright/mcp` | 0.0.83 | 2026-08-27 (dist-tag time) | `next` 0.0.79-alpha; last publish of any version 2026-09-28 |
| `@playwright/cli` | 0.1.22 | 2026-08-27 (dist-tag time) | `next` 0.1.18-alpha; last publish of any version 2026-09-28 |

Both are 0.x packages that publish often. Installed in this repository: `@playwright/test` and `playwright` /
`playwright-core` **1.63.0** (`package.json` pins `"@playwright/test": "1.63.0"`), one minor behind `latest`.
`@playwright/mcp` and `@playwright/cli` are not installed (MEASURED: `node_modules/@playwright` holds only `test`).

### Playwright CLI (DOCS: github.com/microsoft/playwright-cli)

- A command line for Playwright actions aimed at coding agents. Node 18+. Apache-2.0. Install
  `npm install -g @playwright/cli@latest`; `playwright-cli install --skills` installs agent skill files. The README
  shows only `@latest`; a pin is an exact version in the install (`@playwright/cli@0.1.22`). The repository showed no
  releases on the page that was read.
- Positioning, quoted: "This package provides CLI interface into Playwright. If you are using **coding agents**,
  that is the best fit." and "Modern coding agents increasingly favor CLI-based workflows exposed as SKILLs over MCP",
  because CLI calls are more token-efficient. MCP "remains relevant for specialized agentic loops" that need
  persistent state and continuous browser context.
- Commands: open, goto, close, type, click, dblclick, fill, drag, hover, select, upload, check, uncheck, snapshot,
  find, eval, dialog-accept/dismiss, resize, go-back/forward, reload, press/keydown/keyup, mouse*, screenshot, pdf,
  tab-*, state-save/load, cookie-*, localstorage-*, sessionstorage-*, emulation setters, route/route-list/unroute,
  console, requests, request, run-code, tracing-start/stop, recording and video commands, show, generate-locator,
  highlight, webmcp-list/call. Attach with `--extension` or `--cdp`.
- Sessions: the profile lives in memory by default (cookies persist across calls in a session, lost when the browser
  closes). `--persistent` writes it to disk; `--profile=<path>` picks the directory. Named sessions `-s=<name>` or
  `PLAYWRIGHT_CLI_SESSION`. Headless sessions close after an hour idle (`--idle-timeout`). `list`, `close-all`,
  `kill-all`, `delete-data`.
- Snapshots: after each command a snapshot is written as a YAML file under `.playwright-cli/` with a timestamped
  name and the command prints its path; `snapshot --filename`, `--depth`, `--boxes`, and `find` (search the snapshot
  for text or a regex) limit what is read. `outputDir` and `outputMode` (`file` or `stdout`) are configurable; the page
  contradicts itself on the default, so this is **NOT VERIFIED**.
- Each command is a process start of Node plus a hop to a background browser server. A hosting agent needs a shell
  tool to use it.

### Playwright MCP (DOCS: github.com/microsoft/playwright-mcp README)

- 72 tools in the current README. Default (no `--caps`): 24 core tools plus `browser_tabs` = **25**. Core:
  `browser_click`, `browser_close`, `browser_console_messages`, `browser_drag`, `browser_drop`,
  `browser_emulate_media`, `browser_evaluate`, `browser_file_upload`, `browser_fill_form`, `browser_find`,
  `browser_handle_dialog`, `browser_hover`, `browser_navigate`, `browser_navigate_back`, `browser_network_request`,
  `browser_network_requests`, `browser_press_key`, `browser_resize`, `browser_run_code_unsafe`,
  `browser_select_option`, `browser_snapshot`, `browser_take_screenshot`, `browser_type`, `browser_wait_for`.
  Opt-in groups: config (1), network (4), storage (17), devtools (13: tracing, video, recording, highlight), vision
  (6, coordinate based), pdf (1), testing (5). The README lists `vision`, `pdf`, `devtools` in the `--caps` table and
  names the others in section headers; the two lists were not reconciled by the page (**NOT VERIFIED** which values the
  current binary accepts).
- Flags: `--isolated` (profile in memory), `--user-data-dir` (default: a temporary directory), `--extension`
  (attach to a running Edge or Chrome), `--allowed-origins` / `--blocked-origins` (semicolon separated; blocked is
  checked first), `--snapshot-mode full|none`, `--output-dir`, `--secrets`, `--init-script`, `--proxy-server`,
  `--storage-state`, `--headless`, `--config`, `--allow-unrestricted-file-access` (file access is otherwise limited to
  workspace roots).
- Security statements, quoted: "Playwright MCP is not a security boundary." The origin options "do not serve as a
  security boundary and do not affect redirects." `--secrets` is "a convenience and not a security feature."
- `browser_snapshot` returns the snapshot in the response; a `filename` parameter saves it to a file instead.
- Pin: `npx @playwright/mcp@0.0.83` (exact version in the command), never `@latest`. The README shows only `@latest`.
- The `browser_run_code_unsafe` and `browser_evaluate` tools run arbitrary code in the page or server context; they
  are in the default set.

### Playwright Electron support (DOCS: playwright.dev/docs/api/class-electron; MEASURED)

- "Playwright has **experimental** support for Electron automation", Electron v21+, through `_electron.launch`
  (`args`, `executablePath`, `env`, `cwd`, `recordVideo`, `tracesDir`, `timeout` 30 s). If launch times out, the
  `nodeCliInspect` fuse (`EnableNodeCliInspectArguments`) must not be disabled. Native dialogs are not intercepted:
  stub them with `electronApplication.evaluate`. The repository's own E2E suite relies on exactly this.
- MEASURED against the built NEXUS 0.7.2 app (Electron 44.5.1, Playwright 1.63.0), launched with the options of
  `tests/e2e/helpers.ts` (`NEXUS_WINDOW_OFFSCREEN=1`, `NEXUS_FAKE_RUNTIME=1`, isolated `NEXUS_DATA_DIR` under
  `test-results/browser-research/electron-data`): `electron.launch` 470 ms; `app-shell` visible 884 ms after the launch
  call; `firstWindow()`, `page.ariaSnapshot({mode:'ai'})` (2,949 chars, about 737 tokens, 20 ms), `page.screenshot()`
  (16,250 bytes PNG, 186 ms), `app.evaluate` in the main process (read `process.versions.electron`) all worked. The
  window was at x/y -26214 (off-screen), visible but not focused. The runtime process was stopped with
  `runtime.stop` as `closeApp` does. Console events and tracing on Electron pages were not exercised
  (**NOT VERIFIED**).
- Attach alternative: start the app with `--remote-debugging-port=<port>` (bound to 127.0.0.1) and
  `chromium.connectOverCDP`. Playwright says this is "significantly lower fidelity than the Playwright protocol
  connection", only Chromium-based browsers, and externally launched browsers need Playwright's own arguments. It
  requires the target app to be started with the flag, which exposes a debugging port to every local process.

### Snapshots (DOCS, types of 1.63.0; MEASURED)

- `locator.ariaSnapshot({ mode: 'ai' | 'default', depth, boxes, timeout })` and `page.ariaSnapshot(...)` exist in
  1.63.0 (`playwright-core/types/types.d.ts`). The AI mode "includes element references `[ref=e2]`", does not wait for
  a match, and includes `<iframe>` content. `boxes: true` appends `[box=x,y,w,h]`. The playwright.dev
  aria-snapshots page does not yet document `mode`, `depth` or refs; the types do.
- Refs resolve with `page.locator('aria-ref=<ref>')`. MEASURED ref form in 1.63.0: `[ref=f2e8]` (a snapshot
  generation prefix, not plain `e8`), so a ref is only valid for the page state it came from; a click through the ref
  took 25.6 ms.
- `page._snapshotForAI` is the older private name of this feature; it was not used or checked.

### Network, tracing, capture (DOCS)

- `context.route` runs "before the network stack has processed the request", is called "once, for the original
  request" and the browser follows redirects itself (Chromium and Firefox follow without calling the handler again).
  With a service worker, requests become invisible to routes unless `serviceWorkers: 'block'`. WebSockets can be
  inspected through `page.on('websocket')` and mocked through `routeWebSocket`, but a route is not a connect-time
  policy. MEASURED: one route handler call for one navigation (no redirect exercised).
- `proxy: { server, bypass }` is set per browser or per context; HTTP and SOCKS are supported.
- `launchPersistentContext(userDataDir)` returns the only context and closing it closes the browser; do not point it
  at the user's real Chrome `User Data`. An empty path makes a temporary directory.
- Chromium headless: `headless: true` uses the headless shell; `channel: 'chromium'` selects new headless.
- Tracing (`context.tracing`), HAR (`recordHar`), video (`recordVideo`), `acceptDownloads`, `permissions`,
  `page.on('filechooser')`, `page.on('console')`, `page.on('request'|'response')` are part of the Playwright API; their
  behavior was not run here (**NOT VERIFIED** except console, which collected without error).

### Chrome network access state (DOCS, secondary sources)

Chrome 142 (28 October 2025) shipped the Local Network Access permission prompt: a public site reaching a local or
loopback address needs user consent. From Chrome 145 the setting was split into `loopback-network` and
`local-network`. Policy `LocalNetworkAccessAllowedForUrls` exists. The search found no Google primary page, so the
exact state in the Chromium bundled with Playwright 1.63 (153) is **NOT VERIFIED**, and the prompt cannot be answered
by an agent in headless automation. It is a defense for the user's browsing, not a policy NEXUS can rely on: it only
covers requests made by a public page to a private address, not the first navigation, not requests from a page that
is itself on a private address, and it is permission-based.

### Windows native apps (brief)

Win32/WPF/WinForms apps expose Microsoft UI Automation (UIA). Candidate drivers are WinAppDriver (Appium, aging),
`FlaUI`, `pywinauto`, or the `System.Windows.Automation` / UIA COM APIs from a helper process. Sandboxing and
synchronization are far weaker than for a browser. Document it as **experimental and out of scope for 0.8**; none
of it was evaluated here (**NOT VERIFIED**).

## Measured numbers (this machine, Windows 11, Node 24.14.0)

Playwright 1.63.0 wants Chromium revision 1243. The cache in `%LOCALAPPDATA%\ms-playwright` holds revisions 1217,
1223, 1228 and 1234 only. Nothing was downloaded; the web measurements used the installed headless shell 1234 through
`executablePath`. Numbers are from one run (medians of five where noted); the fixture is a local page on 127.0.0.1.

| Measurement | Value | Origin |
|---|---|---|
| Chromium headless shell launch | 80 to 283 ms (two runs) | MEASURED |
| New context + page + close | 46 ms | MEASURED |
| `ariaSnapshot` small page (ai mode) | 332 chars (about 83 tokens), median 2.1 ms | MEASURED |
| `ariaSnapshot` 500-row table, ai mode | 143,307 chars (about 35,800 tokens), median 101 ms | MEASURED |
| Same page, default mode | 109,853 chars (about 27,500 tokens) | MEASURED |
| Same page, `depth: 2` | 132 chars | MEASURED |
| Screenshot PNG / JPEG q60, small page | 8,588 / 9,677 bytes, 31 / 27 ms | MEASURED |
| Screenshot PNG / JPEG q60, large page | 37,521 / 41,889 bytes, 23 / 19 ms | MEASURED |
| click (by selector) | median 30 ms | MEASURED |
| fill | median 3.7 ms | MEASURED |
| NEXUS app via `_electron.launch` | 470 ms; shell ready 884 ms; snapshot 2,949 chars | MEASURED |
| Direct tool schema, 16 NEXUS tools | about 2,000 to 3,000 tokens | ESTIMATED (about 150 tokens each) |
| MCP tool schemas, default 25 tools | about 5,000 to 8,000 tokens | ESTIMATED (200 to 300 each) |
| MCP tool schemas, all 72 tools | about 14,000 to 22,000 tokens | ESTIMATED |
| CLI | no tool schemas; a skill text and a `--help` of about 1,000 to 3,000 tokens, plus one shell-tool schema | ESTIMATED |

Screenshots are small as bytes but cost image tokens on the model side, which depend on dimensions and not bytes
(not measured). The large-table result is the point: an unbounded full snapshot of a big page is 36k tokens and no
backend avoids it unless the caller limits the read. Snapshot time is dominated by page size, not by the backend.
MCP and CLI were not run, so their latency and reliability numbers are not measured.

## Comparison

| Aspect | PLAYWRIGHT_DIRECT | PLAYWRIGHT_CLI | PLAYWRIGHT_MCP |
|---|---|---|---|
| Token cost, tool definitions | About 2 to 3k with NEXUS's 16 tools (ESTIMATED), fixed by NEXUS | None for tools; skill text; the agent needs a shell tool (ESTIMATED) | 5 to 8k default, up to about 20k with every capability (ESTIMATED) |
| Token cost, results | NEXUS decides: caps, depth, filters, files | Snapshots to files; `find` and `--depth` limit reads | Snapshot in the response by default; `filename` saves it; `--snapshot-mode none` |
| Latency | Fastest: in-process calls (MEASURED: ms) | One process start per command, plus a hop to the background server (not measured) | One hop over stdio or HTTP (not measured) |
| Agent reliability | NEXUS controls waits, ref lifetime, errors; one behavior for Claude and Codex | Depends on the agent running shell commands correctly | Good for typed tools; ref staleness handled by the server |
| Tool-selection accuracy | Best: 16 purpose-named tools | Moderate: the agent composes shell strings | Falls with tool count; 25 default is more than needed |
| Electron | `_electron.launch` (experimental, MEASURED working) or CDP attach | Not documented for `_electron`; `--cdp` attach only | Browsers and `--extension`; no `_electron` found in the README (NOT VERIFIED) |
| Web apps | Full | Full | Full |
| Snapshot quality | Same engine everywhere: `ariaSnapshot` ai mode with refs | Same engine, saved as YAML | Same engine |
| Maintainability | Pin one `playwright` version already in the repo; semver 1.x; NEXUS owns the glue | 0.1.x, changes monthly; command surface can change | 0.0.x, changes monthly; tool names and counts change (README now 72) |
| Who holds the browser | A NEXUS-owned process; NEXUS holds context and handles | A background server per session started by the agent's shell | A server process the agent client launches |
| Filesystem and profile | NEXUS chooses: ephemeral temp dir under the data directory, download dir, no real profile | `--persistent`/`--profile` accept any path, set by the agent's command line | `--user-data-dir` any path; file access limited to workspace roots unless a flag lifts it; `browser_run_code_unsafe` is in the default set |
| Policy enforcement | NEXUS code, below the agent: proxy, routes, context options are not agent-reachable | Agent can pass flags and run `eval`/`run-code` | "Not a security boundary"; origin flags do not affect redirects (quoted) |
| Version pin | Exact version in `package.json` (1.63.0 today), browser revision derived from it | Exact `@playwright/cli@0.1.22`; skills files follow it | Exact `@playwright/mcp@0.0.83` in the launch command |

## Recommendation

**PLAYWRIGHT_DIRECT is the backend; PLAYWRIGHT_MCP and PLAYWRIGHT_CLI are absent from 0.8.** An MCP adapter can later
implement the same `BrowserAutomationProvider` interface if a reason appears.

Reasons, from the evidence:

1. NEXUS needs to decide what a snapshot costs. The large-table measurement shows a plausible page is 36k tokens.
   Only an owner of the tool surface can enforce depth, node caps, "snapshot saved to an artifact, reference in the
   prompt", and diffs against the previous snapshot. MCP returns the whole snapshot unless the agent asks otherwise;
   the CLI relies on the agent's discipline.
2. The security boundary must sit below the agent. Microsoft says MCP is not a security boundary and that origin flags
   do not affect redirects. With CLI and MCP the agent (or a prompt injection in a page) can reach `run-code`,
   `eval`, `browser_run_code_unsafe`, `--profile`, `--user-data-dir`, routing and download directories. With direct
   use none of those exist unless NEXUS builds them.
3. Electron: only the library gives `_electron.launch`; the measured launch works against NEXUS itself.
4. One code path serves Claude and Codex through the same 16 tools, with the same errors and the same limits, and
   no extra process contract to pin: `playwright` is already pinned in `package.json`.
5. Cost: owning the glue is a few hundred lines; the MCP and CLI 0.x packages change their tool and command surface
   every few weeks, so using them means tracking an unstable contract anyway.

Costs accepted: NEXUS maintains the ref lifecycle, waiting, and error messages; it will not get Microsoft's skill
text and tool descriptions for free; and the experimental label on `_electron` is a risk to pin around (below).

Pinning and process rules:

- Keep `playwright` / `@playwright/test` at one exact version (no `^`); upgrade as a deliberate change and re-run the
  Electron smoke test. Install the matching browser with `playwright install chromium` as an explicit user or setup
  step; do not download at agent time. Run the browser from a NEXUS-owned helper process that is not the Electron main
  process, so a browser crash cannot take the main process down. Put it in a job object when Windows isolation
  (`docs/WINDOWS_EXECUTION_ISOLATION.md`) is implemented.
- Never use `chromium-1243`'s absence as a silent fallback to another revision, as this study had to: detect the
  mismatch and report it.

## Recommended Electron approach

Use `_electron.launch` for the app under test, not CDP attach:

- NEXUS launches the target Electron app from its worktree with an explicit `executablePath` and `args`, a clean
  `env` (NEXUS builds it from an allowlist, not `process.env`), `cwd` set to the worktree, a per-session
  `--user-data-dir` under the NEXUS data directory, and `tracesDir` / `recordVideo.dir` set to the session artifacts.
- Window placement follows the NEXUS rule already used in tests: the target is started off-screen and unfocused
  unless the user asked to see it (here the app's own `NEXUS_WINDOW_OFFSCREEN`-style switch is the app's business;
  for third-party apps NEXUS must set window position through `app.evaluate` after launch, since a window may flash;
  **NOT VERIFIED** for apps that show a window before `evaluate` can run).
- Main-process `evaluate` is not exposed to the agent as a tool. NEXUS uses it only internally (stubbing native
  dialogs, reading the window list, closing cleanly). The agent's reach is the page.
- If the app disables the `nodeCliInspect` fuse (production builds often do), launch fails; the tool reports this
  cause and suggests a dev build. CDP attach is the documented fallback only when a project has its own debug flag; it
  is lower fidelity and opens a port to every local process, so it is bound to 127.0.0.1 with a random port and
  closed with the session.
- Shutdown copies `closeApp`: ask the app to stop, wait on its process tree, then `taskkill /T /F`. Apps that start
  helper processes that hold the output pipes need the `closeWindowOnly` pattern from `tests/e2e/helpers.ts`.

## Recommended network enforcement

Three layers, because no single mechanism covers everything:

| Mechanism | HTTP(S) | Redirects | WebSocket | WebRTC | DNS prefetch | Service workers | DNS rebinding |
|---|---|---|---|---|---|---|---|
| `context.route` | Yes, at request start | Handler called once for the original request; Chromium follows redirects without calling it again | Not covered as connections (`routeWebSocket` mocks) | No | No | Invisible to routes unless `serviceWorkers: 'block'` | No: sees names, not connect-time IPs |
| `--proxy-server` to a local filtering proxy | Yes, every request including redirect hops | Yes: each hop is a new request through the proxy | Yes, through `CONNECT`/upgrade if the proxy handles it | Only with `--force-webrtc-ip-handling-policy` and UDP disabled; a proxy does not see UDP | Hostnames sent to the proxy, not resolved locally | Yes, requests still go through the proxy | Yes if the proxy resolves and connects itself and checks the connected IP |
| `--host-resolver-rules` | Name based only | Name based only | Name based | No | Applies | Applies | No: it maps names, it does not check results |

Recommendation:

1. **A NEXUS-owned filtering proxy is the enforcement point.** Launch Chromium with `--proxy-server=http://127.0.0.1:<port>`
   (via the Playwright `proxy` option), `--proxy-bypass-list=<-loopback>` removed so loopback traffic is also sent
   through the proxy, `--disable-features=...` for DNS prefetch and preconnect, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`,
   `serviceWorkers: 'block'`, `permissions: []`, `acceptDownloads` off or to a NEXUS download directory. The proxy
   resolves the hostname itself, rejects the request unless every resolved address is allowed, and connects to the
   resolved address it checked (not by name again). That closes DNS rebinding and TOCTOU between check and connect,
   and re-checks every redirect hop because each hop is a new request. It also covers WebSocket upgrades and
   `CONNECT` tunnels. Chromium's HTTPS: the proxy sees only the `CONNECT host:port`, so the policy there is host and
   resolved-address based, which is enough for the allowlists below; no TLS interception.
2. **`context.route` is the second layer**, for readable errors and early abort (the agent sees "blocked: private
   address" rather than a Chromium error) and to block types such as `file:` navigation. It is not trusted for policy.
3. **Browser-level**: separate ephemeral profile directory per session; no persistent context; `ignoreHTTPSErrors`
   false; downloads disabled for PUBLIC_RESEARCH; file chooser handler fails closed; no extension; no `--remote-debugging-port`
   for the research browser.

PUBLIC_RESEARCH session: proxy allows only addresses that are globally routable. Deny loopback (127/8, ::1),
private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16 including cloud metadata 169.254.169.254,
fe80::/10), CGNAT (100.64/10), multicast, reserved and IPv4-mapped IPv6 forms of those. Deny schemes other than
http, https, ws and wss; deny `file:`, `chrome:`, `devtools:`, `view-source:`, `blob:` navigations from outside.
Deny numeric host forms (decimal, hex, octal) unless normalized to a checked address. Deny ports other than 80 and
443 by default. Check each redirect hop (the proxy sees each). The proxy also owns the byte and request-count caps.

LOCAL_APP_TEST session: proxy allows only origins registered by NEXUS for this session (the port of the dev server it
started, as `http://127.0.0.1:<port>`; a separate, explicitly registered list for APIs the app needs). Everything else
is denied, including other loopback ports and all external hosts, unless the user listed them. Because the allowed
destination is itself loopback, the check is on the (scheme, host, port) tuple and the connected address, and the
registry is written by NEXUS, never by the agent. The registered origin is also what `app_launch` returns.

Limits that remain: a page can still try WebRTC (UDP is not seen by the proxy; mitigated by the Chromium policy flag,
**NOT VERIFIED** on Chromium 153); the proxy cannot stop a page from sending data to an allowed public host. A
LOCAL_APP_TEST app is the user's own code and may do what it likes inside the process it runs in; the browser policy
covers the browser, not the app server.

## Snapshot and token-budget recommendations

- Default `browser_snapshot` is ai mode with a node cap and a depth limit (the measured 500-row table: 143k chars at
  full depth, 132 chars at depth 2). Over the cap, the tool returns the top levels plus "N more nodes under
  [ref]" and the agent expands one ref with a targeted read.
- `browser_find(text|role|name)` returns a short list of matching lines with refs; use it before any full snapshot.
- Full snapshots and screenshots are written as artifacts in the session directory; the tool result carries the path,
  size, a hash and the first N lines. The agent reads further parts by path (the same pattern the CLI uses with
  `.playwright-cli/`).
- After actions, return only a diff against the previous snapshot or the changed subtree, and the new page title and
  URL. Refs carry a generation prefix (`f2e8`), so a stale ref must fail with a clear error and a hint to re-snapshot.
- Console and network tools return counts with a filter (errors first, last N, by URL substring), not whole logs.
- Screenshots: JPEG, bounded dimensions, only when asked or when a snapshot cannot answer; treat image tokens as
  costly. Never attach screenshots automatically after every action.
- Keep the 16 tool descriptions short; measure the schema size in the first implementation and keep it under about
  3,000 tokens.
- Page content is untrusted input. Tool results are wrapped and marked as data; instructions found in a page are not
  followed (links to `docs/SECURITY.md`'s treatment of untrusted content).

## NOT VERIFIED

- Behavior and latency of `@playwright/mcp` and `@playwright/cli` on this machine (not installed, not run). All their
  token numbers are estimates.
- Whether `@playwright/cli` or `@playwright/mcp` accepts Electron apps beyond `--cdp`.
- The accepted `--caps` values of the current MCP binary; the CLI's default `outputMode`.
- Tracing, HAR, video, downloads, permissions, file-chooser blocking, and `routeWebSocket` behavior (API documented,
  not run). Console capture and `page.route` were run on a fixture only.
- A redirect chain through `context.route` (the documented behavior is not measured here).
- Console events and tracing against the Electron app; `_electron` against third-party apps with the
  `nodeCliInspect` fuse off; off-screen placement of third-party apps.
- Chromium revision 1243 (required by Playwright 1.63.0) is not installed; the measurements used revision 1234 through
  `executablePath`. Results on 1243 and on Playwright 1.64.0 may differ.
- The exact current Chrome Local Network Access behavior in Chromium 153 under automation; Chrome's primary
  documentation was not retrieved.
- `--force-webrtc-ip-handling-policy` and the `--disable-features` names for DNS prefetch on the bundled Chromium.
- Windows UI Automation drivers.
- Image token cost of screenshots.
- The publish date of Playwright 1.64.0 and the release notes between 1.63 and 1.64.

## Sources (read 2026-10-11)

- https://github.com/microsoft/playwright-cli (README: positioning, commands, sessions, snapshots)
- https://github.com/microsoft/playwright-mcp and https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md (tools, flags, security statements)
- https://registry.npmjs.org/@playwright/mcp , https://registry.npmjs.org/@playwright/cli , https://registry.npmjs.org/playwright (versions and dist-tags)
- https://playwright.dev/docs/api/class-electron (experimental, v21+, launch options, fuse, dialogs)
- https://playwright.dev/docs/aria-snapshots (YAML snapshots; no `mode` documented there)
- https://playwright.dev/docs/api/class-locator (aria snapshot options; also in the installed `playwright-core/types/types.d.ts` 1.63.0)
- https://playwright.dev/docs/network (route, redirects, service workers, WebSocket, proxy)
- https://playwright.dev/docs/api/class-browsertype (launchPersistentContext, connectOverCDP, proxy, headless)
- https://blog.openreplay.com/chrome-local-network-access-lna-permission/ and https://www.dynamsoft.com/web-twain/docs/faq/chromium-142-local-network-access-issue.md (secondary; Chrome 142 LNA prompt, Chrome 145 split)
- Local: `tests/e2e/helpers.ts`, `playwright.config.ts`, `node_modules/playwright-core/{package.json,browsers.json,types/types.d.ts}`,
  `test-results/browser-research/{measure.mjs,electron.mjs,results.json,electron-results.json}`
