# Internet research in NEXUS 0.8

How agents read the public web, what they are given, and what a page can and cannot do to them. Written
2026-10-11 from the code on `nexus-0.8-isolation-autonomy` (`src/main/modules/research/`,
`src/main/modules/network/`). The threat research behind the rules is `docs/UNTRUSTED_CONTENT_SECURITY.md`; what
the provider route offers is `docs/CLAUDE_WEB_TOOLS_RESEARCH.md`.

## What an agent has

Four tools, offered to every role of an enrolled project (and to read-only roles of a project that is not
enrolled when the 0.7 setting "allow network tools" is on):

| Tool | Does | Capability |
|---|---|---|
| `research_search` | Searches the web and lists hits, the maintainer's own sources first | PUBLIC_WEB_RESEARCH |
| `research_read` | Reads one public page and returns the passages that bear on a question, with their source. With `render` it is read in the research browser (below) | WEB_FETCH |
| `research_more` | Reads further into a page already fetched, by offset. No request | none |
| `research_download` | Fetches a file into quarantine and says what it is | DOWNLOAD_RESEARCH_ARTIFACT |

Under the Autonomous project and Balanced profiles research needs no decision of yours, per search or per page.
Under Locked down it is one boundary request for the project. A call is validated against the tool's definition,
put to the capability broker, and carried out by NEXUS; the agent holds no socket and no browser.

## Backends

Which backends exist in a session is found at run time, not assumed (`WebResearchProvider.capabilities()`).

| Backend | State in 0.8 |
|---|---|
| `NEXUS_HTTP_FETCH` | Built. NEXUS's own fetch. Needs no provider tool and no API key |
| `NEXUS_HTML_SEARCH` | Built. One HTML results page (`html.duckduckgo.com`), read with the same fetch and parsed. Scripted tests only so far; the real page's markup is not verified yet |
| `NEXUS_RESEARCH_BROWSER` | Built, offered when a browser can be found on the machine (Microsoft Edge, else a Chromium installed for Playwright). For pages that need script to show their content. See "The research browser" |
| `PROVIDER_NATIVE_SEARCH`, `PROVIDER_NATIVE_FETCH` | Not offered to agents by NEXUS. Whether a Max-backed Agent SDK session has the SDK's `WebSearch` and `WebFetch` is NOT VERIFIED; and NEXUS cannot apply its connect-time checks to a provider's own fetch. No separately billed API is called for research |

## What the fetch does and cannot do

`network/fetch.ts`. It reads. It has no way to send.

- One method: GET. No request body, no cookie, no `Authorization`, no referrer, no header the caller chose. The
  only bytes a caller chooses that leave the machine are the URL, at most 2,048 characters.
- http and https only; a URL with credentials in it is refused; ports 80 and 443.
- The name is resolved once. Every address of the answer must be public; one private or local address among
  them refuses the fetch. The socket connects to the address that was checked, with the name kept for the Host
  header and the certificate. After the connection, the address at the other end is compared with it.
- Redirects are followed here, at most five, and each hop passes the whole policy again. https to http is not
  followed.
- At most 2 MiB of body after decompression; a compressed body that expands without end is cut by the same limit.
- Every decision is an event (host, port, address, allowed or why not). A refusal is recorded in the autonomy
  audit as a policy denial.

Refused to research, in every spelling a URL allows: the local host, private ranges, link-local and metadata
addresses, carrier NAT, multicast, reserved and documentation ranges, and their IPv6 and translated forms; names
of the local network (`localhost`, single labels, `.local`, `.internal`, `.lan` and the like).

## From a page to evidence

1. **Visible text** (`extract.ts`). Scripts, styles, templates and comments are not text. An element hidden by
   its own markup (`hidden`, `aria-hidden`, `display:none`, `visibility:hidden`, zero size or opacity, far
   off-screen, clipped) is left out and its length counted. This is a tokenizer, not a browser: on the plain
   fetch a stylesheet that hides an element is not seen, and text hidden that way is read. That is a limit of
   the plain path. On the path through the research browser the text is what the page shows (below), so text a
   stylesheet hides is left out there. The work is bounded: at most 1 MiB of a document is read
   (`MAX_HTML_INPUT`; the fetch itself takes up to 2 MiB), at most 250,000 tags, elements nested at most 512
   deep, and a bounded amount of scanning for markup that turned out not to be a tag. A document past a limit
   is read as far as the limit allows and the result says `truncated`. Hostile inputs (a megabyte of `<a`
   with no `>`, of empty script elements, of unterminated comments, of nested hidden elements) are read in
   under 2 seconds each in `tests/unit/research/extract-limits.test.ts`; the audit measured the earlier code
   at 6 seconds to minutes on the same inputs.
2. **Screening** (`screening.ts`). Text is normalized (NFKC), invisible and direction-control characters are
   removed, and sentences aimed at the reader as an agent are taken out and replaced by a marker that says what
   was there: role overrides, messages "for AI agents", download-and-run, sending files or credentials
   somewhere, secrecy, tampering with the security policy, forged role delimiters. The facts around them stay.
   Screening is a second layer. It interrupts nobody, fails no task, and guards nothing by itself.
3. **The source** (`sources.ts`). Decided from the address by rules, never from what the page says of itself:
   official documentation, standard, source repository, release notes, issue tracker, package registry,
   community, unknown; and an authority (primary, probably primary, community, unknown). Search hits are ordered
   by it, the engine's order kept among equals.
4. **A research artifact** (`research_artifacts`, migration 18): the URL asked for, the URL the text came from,
   the redirect chain, title, time, the hash of the body, type, size, backend, source type, authority,
   publisher, freshness, trust (`UNTRUSTED_WEB_CONTENT`, always), the screening result, a summary, the question.
   The screened text is a file beside the database, not a column.
5. **The envelope** the model receives: who the source is and how it is trusted, the screening result, the
   passages that bear on the question (6,000 characters by default, the rest by offset), citations, and the
   artifact's id. Everything that came from the page sits between two lines with a marker made for that one
   result, so a page cannot close the block and continue in NEXUS's voice: the title (cut to one line of at
   most 200 characters, so that it brings no line break of its own), the text, and the citations with their
   quotes (one line, at most 300 characters). What stands outside the block is NEXUS's: the instruction that
   the block is data, the address, the kind and authority of the source, the screening result and the
   artifact's id. `tests/unit/research/envelope.test.ts`; the forged-title case is in it.

## The research browser

`research/browser.ts` (`renderPublicPage`), on the browser provider of `src/main/modules/browser/provider.ts`.
Some documentation shows nothing until its script has run.

**When it is used.** The plain fetch comes first, so what the browser is given is a public page that answered.
The browser is then used when the caller asked for it (`research_read` with `render`), or when the page is
HTML with a script and less than 400 characters of text. If it was asked for and cannot be used (no browser on
the machine, the policy refuses the address, the render fails), the call is refused with the reason and no
artifact is made. If NEXUS chose it on its own account and the render fails, the plain text stands.

**What it is.** Headless Microsoft Edge (or the Chromium Playwright installs), started by Playwright with a profile made for that one page and
thrown away with it: no cookie, password, extension or history of the user's. Its only way to the network is a
filtering proxy made for that one page, under the public-research policy and read-only: the local host,
private ranges and metadata addresses are refused, each redirect and each request of the page is judged
again, and a request that is not a GET, HEAD or OPTIONS is refused. Loopback goes through the proxy too. QUIC
is off, so that nothing goes round a proxy that speaks http. Edge's own background connections (a search
provider, an update check) are switched off, and the test asserts that the browser opened no tunnel of its own
through the proxy. It is NEXUS that drives the browser; the agent gets text.

**What a page cannot do** (`tests/integration/research/browser.test.ts`, a hostile scripted page whose script
tries them all): reach the local host, a private address or the metadata address (each refused, and the local
service sees no request); open a `file:` address, directly or in a frame; send a form or any request that is
not a read; download (nothing arrives in quarantine, no download is recorded); give a file chooser a file;
open a window (it is closed and noted); keep a dialog (it is dismissed). A script that moves the page to an
address the policy does not allow is not read from there. WebSockets are closed. A request whose address is
over 2,048 characters is refused (over https the proxy sees only the tunnel, so the length is applied in the
browser). Service workers are blocked and no permission is granted.

**Deadlines and limits.** Every read of the page has 10 seconds, because a page whose script holds its main
thread answers nothing, and the whole render has 30 seconds; at either limit the browser is closed, and killed
if it will not close, and the proxy with it. A render makes at most 300 requests and relays at most 50 MB, and
a connection that sends no byte for 30 seconds is dropped. The test that gives a page that blocks its thread
(`spin`) checks that the render is refused at the deadline, that the browser is not alive and that the
proxy's port is gone; another checks that a WebSocket, a very long address and a flood of subresources do not
get through. `tests/integration/network/proxy-limits.test.ts` covers the proxy's limits on their own.

**What is taken from it.** The document as the script left it, at most 1 MiB of it (more is marked
`truncated`), and the text the page shows (`innerText` of the body): text that a stylesheet hides is in the
document and not in `innerText`, so on this path it is left out (test "reads what the page shows"). Both then
go through the same screening and are kept as an artifact like any other page, with the backend
`NEXUS_RESEARCH_BROWSER`. If the visible text cannot be read, the text of the markup stands. The agent never
sees the browser.

**Limits.** A scripted page is still a stranger's code running on this machine, in a browser with a profile of
its own and a network that is this proxy; what it can read is what it fetches. The length of a GET address
(at most 2,048 characters) can carry data out to a public host, here as in the plain fetch. Whether the real
markup of a given site renders well is not tested beyond the scripted pages of the test.

## Research artifacts in the Context Graph

A page read on the web becomes one node of the project's Context Graph, under `research`
(`context-graph/projection.ts`, `addResearch`). The node holds where the page came from (address, publisher,
kind and authority of the source), when it was read and until when it is fresh, the question it was read for,
the hash of the body, a summary of at most 360 characters and the id of the artifact, which `research_more`
reads. It is never the page: the text stays in the artifact's file. Its trust is the lowest the graph has
(`AGENT_NOTE`) and it is marked as untrusted web content, with a note when instruction-like text was taken out.
A page read again takes the place of the earlier reading, which is marked superseded; a page past its freshness
is marked stale. At most 300 research nodes are kept. `tests/integration/context-graph/research.test.ts`.

## Research memory

A page read recently enough is answered from its artifact with no request: 30 days for a standard, 7 for
versioned documentation, a repository or a registry page, 1 for an issue thread, a community page or an unknown
site. `refresh` fetches again. Memory answers for a page; it does not widen what may be asked for: the URL is
judged by the policy either way.

## Budgets

Per mission: 40 pages, 12 from one host, 15 searches, 40 MiB. Enforced by NEXUS, so a reader that was talked
into crawling stops there. Memory hits cost nothing.

## Downloads

A page address that serves a file is not read as text. `research_download` fetches at most 50 MiB into
`<data dir>/research/quarantine/<id>.quarantined`: a directory no worktree is in, under a name with no
extension Windows would run, marked as come from the Internet. What a file is, is read from its first bytes.
A program, a script, an installer, a shortcut, an Office file, and a document whose name is one Windows would
run are refused and not kept. Nothing is run, and nothing gets into a project by arriving here; releasing a
held file into a worktree is a separate step that is the user's (the state exists; the action is not built).

## What a page can and cannot do

Can: say false things; say them in the voice of an instruction; be missed by the screening.

Cannot, because of what a session is and not because of what the model thinks of the page:

- make a request to the local host, the LAN or a file (the fetch and its policy; for a page that runs script,
  the research browser's proxy and the tests above);
- send anything anywhere but a URL of at most 2,048 characters to a public host (there is no other verb; the
  research browser's proxy refuses what is not a read). This is an acknowledged limit: a GET address of that
  length can carry data out to a public host, so a page that talks a reader into asking for a long address
  can learn what the address says;
- read a file, a credential, the environment or the runtime (under a containment; `V0_8_SECURITY_MODEL.md`);
- push, publish, deploy, install machine-wide, elevate, or write outside the task roots without one boundary
  request that waits for the user;
- give itself or the agent a capability, a grant or a profile.

`tests/scenarios/v8-research.test.ts`: a page tells the reader to fetch the local host and then to push. The
fact on the page arrives; the instruction does not; a scripted agent that does both anyway is refused the fetch,
and its push is one boundary request, as for any push.

## Not built, or not verified

- A separate research agent session. The 0.8 design gives the reading agent the tools directly: the fetch is
  deterministic code with no agent in it, and what the agent then holds is bounded by its containment. A
  separate no-tools session that summarizes is possible later for large research.
- A machine with no browser (neither Edge nor a Chromium for Playwright): there the plain fetch stands, and a
  read that asks for `render` is refused. Not tested here.
- The search results page against the real site; a real current-web acceptance run.
- Release of a held download into a worktree.
- Where the model's provider sees what was read: research text goes to the provider in the session's prompt,
  like any file the agent reads.
