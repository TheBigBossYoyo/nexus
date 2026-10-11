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
| `research_read` | Reads one public page and returns the passages that bear on a question, with their source | WEB_FETCH |
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
| `NEXUS_RESEARCH_BROWSER` | Not built. For pages that need script to show their content. The network policy and the proxy for it exist |
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
   off-screen, clipped) is left out and its length counted. This is a tokenizer, not a browser: a stylesheet
   that hides an element is not seen.
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
   artifact's id. The content sits between two lines with a marker made for that one result, so a page cannot
   close the block and continue in NEXUS's voice.

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

- make a request to the local host, the LAN or a file (the fetch and its policy);
- send anything anywhere but a URL of at most 2,048 characters to a public host (there is no other verb);
- read a file, a credential, the environment or the runtime (under a containment; `V0_8_SECURITY_MODEL.md`);
- push, publish, deploy, install machine-wide, elevate, or write outside the task roots without one boundary
  request that waits for the user;
- give itself or the agent a capability, a grant or a profile.

`tests/scenarios/v8-research.test.ts`: a page tells the reader to fetch the local host and then to push. The
fact on the page arrives; the instruction does not; a scripted agent that does both anyway is refused the fetch,
and its push is one boundary request, as for any push.

## Not built, or not verified

- The research browser (script-rendered pages).
- A separate research agent session. The 0.8 design gives the reading agent the tools directly: the fetch is
  deterministic code with no agent in it, and what the agent then holds is bounded by its containment. A
  separate no-tools session that summarizes is possible later for large research.
- Context Graph nodes for artifacts.
- The search results page against the real site; a real current-web acceptance run.
- Release of a held download into a worktree.
- Where the model's provider sees what was read: research text goes to the provider in the session's prompt,
  like any file the agent reads.
