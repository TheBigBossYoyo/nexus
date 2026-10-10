# NEXUS 0.7.1 Release Report

Context, memory and token intelligence. Branch `nexus-0.7.1-token-intelligence`, from `main` at `v0.7.0`.
Written 2026-10-07. Every figure below names its source; a figure without a source is not in this report.

## Verdict

**PARTIAL.** Not merged into `main`, not tagged.

Everything that was built is tested and green, and no CRITICAL or HIGH defect is open. One requirement of
the release gate is not met: the representative real campaign that compares 0.7.1 with 0.7.0 across the
eight task categories was not run. One real pair was. The account's weekly usage window stood at about 92%
(it resets on 2026-10-10); eight pairs would have exhausted it, and the specification says not to do that.

What this means in practice:

- With its default settings 0.7.1 gives agents what 0.7.0 gave them, plus failures that used to be cut out
  of long check output. Nothing lossy is on. The quality risk of the defaults is small and argued by
  construction, not by a campaign.
- The Context Graph is built, measured for retrieval and usable by people. It is **off for agents**, because
  the one real pair showed more tokens and no better outcome, and one pair proves nothing either way.
- 0.7.1 does not lower the token use of a mission by default. It makes token use measurable and shows where
  the remaining cost is.

See "Release gate" for each requirement and "Recommendation" for the one step that is missing.

## What 0.7.1 is

| Part | What it does | Document |
| --- | --- | --- |
| Context Graph | One index over repository facts, project memory, program memory and workspace knowledge: a tree to browse, typed relations, provenance, freshness, conflicts, supersession, history. It projects the existing stores and owns no fact | `CONTEXT_GRAPH.md`, `MEMORY_ARCHITECTURE.md` |
| Context Engine V3 | The 0.7.0 pack plus a "Project knowledge" section (a map, the nodes selected for the task with the reason for each, warnings) and four agent tools to read further | `CONTEXT_ENGINE_V3.md` |
| Token Intelligence Engine | Per-request cache events, context breakdowns, prefix registry, cache diagnosis, prompt audit, session efficiency, the decision log | `TOKEN_INTELLIGENCE.md`, `PROMPT_CACHING.md`, `CONTEXT_LIFECYCLE.md` |
| Quality gate | A paired comparison decides whether a technique that changes what a model sees may become a default | `TOKEN_INTELLIGENCE.md` |
| Interface | Context view (tree, search, inspector, relations, sources, freshness, history); Usage sections Cache, Context, Context techniques; an agent's Context tab; Tokens settings | `README.md` |

Migration 12 is additive. A 0.7.0 database upgrades in place.

## What the research changed

The specification was a starting point. Three of its assumptions did not survive measurement or reading the
installed SDK (`@anthropic-ai/claude-agent-sdk` 0.3.288), and the design follows the evidence:

1. **The host cannot place cache breakpoints, choose the cache lifetime, turn on context editing or read the
   API's cache diagnostics.** The Agent SDK assembles the request. What a host can do: keep its own prefix
   text stable, choose the tool list, ask for a context breakdown, and observe every request's usage. So
   0.7.1 measures and diagnoses; it does not re-implement what the runtime does.
2. **"The working directory poisons the cache" was wrong.** Measured: two sessions of one role in different
   worktrees share the prefix with no option set (14,994 tokens read, 1,015 written). The stable-prefix
   option changes nothing and is off.
3. **The graph is an index, not a second memory.** A parallel store of summaries would be a new place for
   stale truth. Nodes project the records that exist; summaries of branches are computed from their
   children by code, never written by a model, so building and refreshing the graph costs no usage and a
   summary cannot disagree with what is under it.

No embeddings and no vector store: on the benchmark, path, typed relations and full-text search together
reach the recall of the whole set of signals (table below).

## Techniques

Deltas are against 0.7.0 behaviour. "By construction" means the technique cannot remove anything 0.7.0 showed.

| Technique | Quality delta | Input tokens | Output tokens | Cache effect | Latency | Default | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Prompt caching | none (the runtime's, unchanged) | 0 | 0 | Measured as it is: a role's prefix is read by later sessions of that role; each role writes about 15,000 tokens once | 0 | on (runtime) | PROVEN for one session per condition, model `haiku` |
| Stable prefix (`excludeDynamicSections`) | NOT VERIFIED | 0 measured | 0 | none measured: 14,826 read and 1,015 written with it, 14,994 and 1,015 without | 0 | off | PROVEN no benefit, one session per condition |
| Tool search / upfront NEXUS tools (`alwaysLoad`) | NOT VERIFIED | 0 measured (15,851 processed either way) | NOT VERIFIED | none measured | NOT VERIFIED (a search turn for a deferred tool was not measured) | off: the runtime's behaviour is left alone | PROVEN for request size, one session |
| Context Graph in agent context | Retrieval: recall up, non-current records shown down (next table). Engineering quality: NOT VERIFIED (one real pair, both passed) | +17.6% cache read, +6.7% cache write in the one real pair | +4.4% in the one real pair | no new cold start in the pair (1 warm, 4 cold in both) | +3.6% wall clock, +6 turns in the pair | **off** | Retrieval: measured, deterministic. Mission effect: n=1 |
| Context Engine V3 (hybrid pack) | as the row above | pack section +400 tokens on the benchmark (715 against 315) | as above | as above | as above | off (follows the graph setting) | as above |
| Tool-result filtering: failures first in check output | Up by construction: the same last 3,000 characters, plus failures that lay before them | up to +3,128 characters per check with an early failure; 0 otherwise | 0 | none (the text is in the first message of a session) | 0 | **on** | PROVEN by property tests; real-mission effect NOT VERIFIED |
| Tool-result filtering: compact passing output | NOT VERIFIED (shows less) | down for long passing runs | 0 | none | 0 | off (opt-in) | tested with scripted sessions only |
| Context editing (clearing old tool results) | NOT AVAILABLE to a host through the Agent SDK; the runtime does it by itself | NOT AVAILABLE | NOT AVAILABLE | NOT AVAILABLE | NOT AVAILABLE | runtime | DOCUMENTED |
| Compaction | NOT VERIFIED: no real session compacted (sessions run 3 to 16 turns) | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED | runtime; NEXUS records each compaction with its sizes | scripted only |
| Session rotation by context pressure | NOT VERIFIED with real sessions | NOT VERIFIED | NOT VERIFIED | would keep a warm cache instead of paying a handoff | NOT VERIFIED | off (0.7.0 turn rule stays) | scripted only |
| Programmatic tool calling | NOT AVAILABLE through the Agent SDK. `context_open` answers with a node, its children, relations and sources in one bounded result instead of several calls | NOT AVAILABLE | NOT AVAILABLE | NOT AVAILABLE | NOT AVAILABLE | n/a | DOCUMENTED |
| Prompt deduplication | none: the audit of the 0.7.0 prompts found no duplicated instruction to remove | 0 | 0 | none | 0 | the auditor reports; it removes nothing | PROVEN by the audit (`V0_7_1_BASELINE.md`) |
| Output hygiene | none: no instruction asks agents for shorter reasoning or output | 0 | 0 | none | 0 | n/a | by inspection |

No model was changed, no effort lowered, no thinking disabled, no reviewer, agent or planning step removed.

## Context Graph retrieval

Deterministic benchmark on a seeded project, program and workspace (`pnpm bench:retrieval`; evidence
`docs/acceptance/retrieval-benchmark-2026-10-07T11-41-34-268Z.json`). "V2" is the 0.7.0 selection; "V3" is
the hybrid pack. Recall: share of the records a task cannot be done well without. "Wrong": records shown as
current that are stale, superseded or another program's. Tokens are estimates (characters / 4) of the
selected knowledge.

| Set | Variant | Recall | Precision | Wrong | Tokens |
| --- | --- | ---: | ---: | ---: | ---: |
| 18 tuning cases | V2 (0.7.0) | 86.5% | 20.3% | 4 | 315 |
| | Graph alone | 100% | 16.8% | 0 | 641 |
| | V3 (hybrid) | 100% | 13.9% | 0 | 715 |
| | Everything (the whole memory) | 94.4% | 2.2% | 0 | 4,263 |
| 7 held-out cases | V2 (0.7.0) | 54.8% | 10.9% | 0 | 370 |
| | Graph alone | 85.7% | 14.7% | 0 | 564 |
| | V3 (hybrid) | 100% | 11.6% | 0 | 715 |
| | Everything | 85.7% | 1.9% | 0 | 4,280 |

The retriever was tuned on the 18 cases; the 7 held-out cases were written afterwards and not tuned on.
"Everything" misses records because it is the project's memory dump and does not reach the workspace.

Signals (18 tuning cases): hierarchy only 39.0%; path only 71.6%; path and relations 77.3%; full text only
98.1%; path, relations and full text 100%.

By task type (tuning set; one case per type unless noted):

| Task type | V2 recall / tokens | Graph recall / tokens | V3 recall / tokens | Context-token change, V3 against V2 | Engineering quality delta |
| --- | --- | --- | --- | --- | --- |
| Localized bug | 100% / 264 | 100% / 460 | 100% / 497 | +233 | NOT VERIFIED |
| Cross-module bug | 67% / 303 | 100% / 461 | 100% / 570 | +267 | NOT VERIFIED |
| Architecture | 40% / 338 | 100% / 1,126 | 100% / 1,113 | +775 | NOT VERIFIED |
| Security | 100% / 323 | 100% / 997 | 100% / 1,104 | +781 | NOT VERIFIED |
| UI | 100% / 293 | 100% / 504 | 100% / 584 | +291 | NOT VERIFIED |
| Database | 67% / 317 | 100% / 1,185 | 100% / 1,186 | +869 | NOT VERIFIED |
| Large refactor | 33% / 310 | 100% / 476 | 100% / 468 | +158 | NOT VERIFIED |
| Program | 100% / 475 | 100% / 482 | 100% / 557 | +82 | NOT VERIFIED |
| Workspace | 50% / 361 | 100% / 472 | 100% / 569 | +208 | NOT VERIFIED |
| Memory recall (6 cases) | 100% / 308 | 100% / 659 | 100% / 764 | +456 | NOT VERIFIED |
| Adversarial (3 cases) | 100% / 280 | 100% / 474 | 100% / 547 | +267 | NOT VERIFIED |

Read this plainly: against the 0.7.0 selection the graph does **not** reduce context tokens. It spends a few
hundred more and finds what 0.7.0 missed. The reduction is against the alternative of giving an agent the
whole memory: 641 tokens for 100% recall against 4,263 for 94.4%, and with 2,000 unrelated memory entries
added, 641 tokens at 98.1% recall against 109,812 for the dump (scenario 22).

One fix proposed in review (running the text search again at the widened size) was implemented, measured
and removed: it lowered tuning recall from 100% to 98.1%.

## Real-world summary

### Before (0.7.0)

From the acceptance evidence of 0.7.0 (`V0_7_1_BASELINE.md`, `pnpm baseline:tokens`):

| Median successful BUILD mission | |
| --- | ---: |
| Sessions | 5 |
| Turns | 33 |
| Uncached input | 12.3k |
| Cache read | 195k |
| Cache written | 75.8k |
| Output | 10.0k |
| Usage-window change per mission | NOT AVAILABLE (not sampled in 0.7.0) |

### After (0.7.1)

One real mission pair, same repository state, task, models, effort, permissions and policy
(`pnpm accept:graph`; `docs/acceptance/context-graph-acceptance-2026-10-07T09-55-26-846Z.json`). The task is
a different one from the 0.7.0 missions, so the two tables are not a before/after of one mission.

| | 0.7.1 defaults (graph off) | 0.7.1 with the graph |
| --- | ---: | ---: |
| Outcome | completed; hidden evaluation passed; review approved; 0 repairs | the same |
| Sessions | 5 | 5 |
| Turns | 39 | 45 |
| Tool calls | 34 | 40 (6 of them `context_open`) |
| Cache read | 293,515 | 345,257 |
| Cache written | 85,065 | 90,761 |
| Output | 16,907 | 17,648 |
| Wall clock | 187 s | 194 s |
| Sessions that read their prefix from cache / wrote it | 1 / 4 | 1 / 4 |
| Usage-window change | NOT VERIFIED (not sampled per mission) | NOT VERIFIED |

With the defaults, 0.7.1 sends agents what 0.7.0 sent, with one difference: a check output whose failure
lies before its last 3,000 characters now shows that failure. **0.7.1 does not lower the token use of a
mission by default, and this report does not claim that it does.** What it adds by default is measurement
(every request, every context breakdown, every cache miss with a cause) and the graph for people (the
Context view).

- **PROGRAM, before/after:** NOT VERIFIED. No real program was run on 0.7.1. Retrieval for program tasks:
  table above; program knowledge reaches only its own program (tests, security review).
- **WORKSPACE, before/after:** NOT VERIFIED with real runs. Retrieval: the workspace case goes from 50% to
  100% recall (the contract and the cross-repository hazard are found through relations).
- **Quality:** equal in the one real pair. Not enough to conclude anything; the gate needs 8 pairs.
- **Cache:** one cold start per role per cache lifetime is the cost that remains (4 of 5 sessions in both
  missions wrote their prefix). The largest lever found is a shared tool list across roles. It is **not
  implemented**: it would show read-only roles tools they may not use, which is a security and prompt
  change that needs its own review and comparison.
- **Context Graph:** average branch reduction NOT AVAILABLE as a single figure; retrieval recall and
  precision as in the tables above.

## Did any optimization make NEXUS worse?

Yes, in the measurements that exist, and each one is off or was removed:

- **The Context Graph in agent context cost tokens in the one real pair** (+17.6% cache read, +6 turns) with
  no difference in outcome. The agent used the tools to walk the tree (root, hazards, decisions, notes) and
  then did the same work. It is off by default until a paired campaign says otherwise.
- **Widening the text search** lowered benchmark recall and was removed.
- **Failure-first output** adds up to 3,128 characters to a prompt when a check failed early in a long
  output. That is the intended trade: the failure was invisible before.
- **The context breakdown** (default `summary`) makes one extra control call to the runtime when a session's
  turn ends; the session waits for it, 8 seconds at most. The delay was not measured on real sessions.
  Setting it to `off` removes the call.

Nothing that is on by default removes text an agent saw in 0.7.0.

## Scenarios

The specification lists 22. Automated with the scripted runtime (`tests/scenarios/v71-token-context.test.ts`,
13 tests) and with the graph and token suites:

| # | Scenario | Evidence |
| --- | --- | --- |
| 1, 2 | Stable project context is reused by two agents | scenario tests; real: `cache-acceptance-*.json` |
| 3 | A timestamp does not poison the cache | unit: role prompts contain nothing volatile; the auditor finds volatile text in a stable block |
| 4 | A huge tool set uses the relevant subset | the runtime's tool search, left on; NOT VERIFIED with a large external tool set |
| 5, 6 | A passing log does not flood context; a hidden failure stays visible | scenario and property tests |
| 7 | A tool result is cleared only after it is stored | unit (`mayLeaveOut`); NEXUS itself clears nothing |
| 8 | Compaction keeps a critical requirement | scripted: the compaction is recorded and the task and criteria live in NEXUS's stores, not in the summary. With a real compaction: NOT VERIFIED |
| 9 | Rotation preserves continuity | scenario tests (handoff, continued session). Real comparison: NOT VERIFIED |
| 10, 11 | Workspace and Program agents get scoped knowledge | benchmark cases; program-scope tests |
| 12, 13 | Reviewer gets evidence; verifier gets TaskEvidence | unchanged from 0.7.0; both roles can read the graph and cannot write notes (scenario test). Their prompts carry no graph section |
| 14 | Cache miss diagnostics | unit and integration tests |
| 15 | The quality gate rejects a harmful optimization | unit tests |
| 16, 17, 18 | Retrieval from the root; progressive expansion; a contract in another branch through a relation | scenario test, benchmark, the real pair (six `context_open` calls from `/` down to a note) |
| 19, 20, 21 | A stale summary is invalidated; a superseded decision is not current; a conflict is shown whole | graph tests, scenario test |
| 22 | A project with a huge memory stays efficient | benchmark with 2,000 extra entries |

## Tests

Measured 2026-10-07 on commit `db9c9dc` (the code of the release; later commits change documents only).
No Claude usage unless a row says so.

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm test` | 166 files, 3,958 of 3,958 passed, 535 s (0.7.0: 158 files, 3,819 tests) |
| `pnpm test:e2e` | 29 of 29 passed, 2 capture-only tests skipped by design, 7.5 min. No stored screenshot changed |
| New in 0.7.1 | token unit tests, graph integration tests, retrieval benchmark, IPC tests for `knowledge.*` and `tokens.*`, 13 scenarios, one end-to-end spec, and 28 regression tests for the review findings |
| `pnpm smoke:cache` (real runtime, `haiku`, 7 one-turn sessions) | all four checks met; `docs/acceptance/cache-acceptance-2026-10-07T09-37-10-105Z.json`. Run before the review fixes; they do not touch what it measures |
| `pnpm accept:graph` (real paired mission) | both missions completed and passed the hidden evaluation; `docs/acceptance/context-graph-acceptance-2026-10-07T09-55-26-846Z.json`. Run before the review fixes |
| `pnpm package` | `release/NEXUS-Setup-0.7.1.exe`, 208,079,443 bytes, SHA-256 `1528a2ae665b44f559db7b2a95309d502100f428e0bd5373af694ef6a4da663b` |
| Migration campaign on the packaged build (`release/win-unpacked/NEXUS.exe`), ten real databases: 0.1, 0.2.0, 0.2.1, three of 0.3, 0.4, 0.5, 0.6 and the 0.7.0 acceptance database | PASS, 9 checks each: launches, schema upgraded to 12 in order, the old file kept as a backup, no table lost or changed a row, every run, program, workspace and campaign opens, the pages render. `docs/acceptance/migration-campaign-2026-10-07T13-30-36-699Z.json` |
| Installer execution | NOT VERIFIED (as in 0.7.0) |

## Stress

Scripted sessions only; no Claude usage. On commit `db9c9dc`.

| Suite | Size | Result |
| --- | --- | --- |
| Control plane runtime | 10,000 seeds | passed |
| Queue (control plane), Arena, overnight (two suites), policy, usage, program, workspace | 5,000 each | passed |
| Context Graph and token accounting (new) | 100,000 nodes, 499,994 edges; 5,000 histories of 24 random steps; 125,000 accounting sessions | passed |
| The ten suites above, together | | 10 files, 1,640 s |
| Orchestrator | 1,000 seeds | passed, 2,782 s. A first run failed one seed (597) on a gap in the test invariant, not in the product; see "Intermittent failures" in `TEST_STATUS.md` |
| Runtime soak (60 minutes) | | not repeated for 0.7.1; the worker and runtime processes changed only by three event types passed through the protocol. 0.7.0: passed |

Invariants the new suite checks after every step of every history: nothing is ever deleted (history only
grows); the tree is a tree (unique paths, the right parent and depth); every edge joins two existing nodes;
a superseded node is never current again; retrieval returns only the project's own nodes, nothing
historical, and nothing stale without a warning; the same graph renders to the same bytes; a second
project in the same database cannot be reached by id, path, search or relation. At the end of a history:
no node is current while a file it rests on differs from what was verified. For accounting: every request
is recorded once and in order, totals equal what the runtime reported, and one role on one provider has
one prefix hash whatever the worktree, session and time. Program scoping and summaries are covered by the
integration tests, not by this suite.
It found one defect during development (a superseded node could become current again through "stale"),
fixed before the reviews; the review then found the same defect by another route (archive and return).

Query times on 100,000 nodes and 499,994 edges (`docs/acceptance/context-graph-scale-*.json`), run alone
and, in brackets, while nine other stress suites shared the machine: a page of children 3.6 ms (4.7);
expand 1.3 to 4.3 ms (2.1 to 5.6); neighbours 1.5 ms (2.0); a node's detail 1.9 ms (2.5); the nodes for 200
changed files 2.5 ms (3.6); full-text search 81 ms (115); retrieval for a task 117 ms (169); health 462 ms
(636).

## Reviews

The specification asks for independent reviewers in eleven areas. Three independent reviews were run, each
read-only and each asked for evidence:

| Review | Areas it covered | Findings | State |
| --- | --- | --- | --- |
| Security | security; scope of program knowledge; prompt injection through graph text | no CRITICAL or HIGH; 1 MEDIUM, 4 LOW | all fixed except one LOW (below); commit `39727d0` |
| Graph and memory correctness | Context Graph architecture, memory correctness, retrieval | 1 HIGH, 5 MEDIUM, 8 LOW, 4 suspected | HIGH and 4 of 5 MEDIUM fixed with tests, 6 LOW fixed; commit `db9c9dc`; open items below |
| Token accounting, SDK use, test quality | token accounting, SDK compatibility, prompt caching claims, quality-gate method, test quality | 2 HIGH, 6 MEDIUM, 5 LOW | HIGH and MEDIUM fixed with tests; commit `db9c9dc`; open items below |

Not reviewed by a separate reviewer: context engineering as its own subject, and UI/UX (covered by an
end-to-end test only).

The HIGH findings, all fixed:

- A superseded node whose record was deleted and came back was presented as current again.
- One enormous line in a check's output passed the prompt budget (the tail kept whole lines).
- Two failure patterns could take seconds on a line built to make them backtrack, on the runtime's thread.

Open, accepted for 0.7.1:

- Facts that Repository Intelligence builds from README text are labelled verified (LOW; existed in 0.7.0).
- Two records whose names give the same path: when the first is deleted the second moves to the plain path
  as a new node; its earlier history stays on the old node (MEDIUM, rare; documented in `CONTEXT_GRAPH.md`).
- A re-analysed fact is accepted with the file state at the sync, not at the analysis (suspected, LOW).
- The crude stemmer can match unrelated words ("api" in "capital") and raise confidence (suspected, LOW).
- The miss cause of a role's first request can be wrong when sessions of a role start concurrently; an
  "expired" cause assumes a five-minute lifetime (LOW; causes are labelled as NEXUS's inference).
- Reading the context breakdown can delay a stop by up to 8 seconds (LOW).

## Closing work, 2026-10-10

The usage window reset (five-hour 3%, weekly 0%; `docs/acceptance/usage-report-2026-10-10T06-41-24-612Z.json`,
no prompt sent). The sections below record what was closed after it, in order.

### Why the graph-backed mission took six more turns

45 turns against 39, 40 tool calls against 34: the difference is exactly the six `context_open` calls of the
evidence file (`/`, `hazards`, `decisions`, `notes`, `notes/general`, the note). The note's whole text was
already in the worker's pack. Retrieval precision was not the problem; reaching things was:

- every session got the four context tools, but only a task's pack got the map and the selection. The
  planner started with tools described as the way "to find where things are" and nothing to start from;
- an open returned one level, without text, and listed branches that hold nothing like the others;
- a pack entry did not say whether its text was whole and named no source file (those took an open).

Changed in `a9212da`, without touching what the retriever selects:

- the planner prompt carries the map and what its request retrieves (single and consensus planning);
- an open returns a branch with what is under it: entries with their summaries, a chain of folders
  followed down, folders that hold nothing named in one line, and the text of the entries of a small folder;
- a selected entry is marked "(shown in full)" or "(excerpt)" and carries its evidence and source files;
- the hint and the tool descriptions say what needs no lookup instead of inviting one.

Measured without usage (`tests/integration/context-graph/navigation-benchmark.test.ts`,
`docs/acceptance/navigation-benchmark-2026-10-10T06-37-05-929Z.json`). The reader is an oracle that never
opens a wrong branch, so these are lower bounds for a tree walk, the same reader before and after:

| Session | Cases | `context_open` calls before | after | Required records whole in the prompt, before / after |
| --- | ---: | ---: | ---: | --- |
| Planner | 18 tuning | 103 (mean 5.7, max 10) | 5 (mean 0.3, max 3) | 0% / 90.7% |
| Planner | 7 held-out | 38 (mean 5.4, max 8) | 3 (mean 0.4, max 1) | 0% / 80.0% |
| Task session, opens only to learn a selected record's files | 18 tuning | 194 | 0 | |
| Task session, the same | 7 held-out | 46 | 0 | |

Cost: about 1,260 estimated tokens of "Project knowledge" in a planner prompt that had none. Retrieval is
unchanged (`docs/acceptance/retrieval-benchmark-2026-10-10T06-37-05-821Z.json`): V3 recall 100% on the
tuning cases and 100% on the held-out cases, no record wrongly shown as current. Whether real agents now
skip the walk is a question for the real campaign below, not for this benchmark.

### Tool definitions: not enabled, security preserved

An independent, read-only security review looked at sharing tool definitions across roles; its decisive
claims were then checked against the code.

| Design | Verdict |
| --- | --- |
| One tool list for every role, enforcement left to the authorizer | NOT SAFE |
| One NEXUS tool set for every role, refusal inside the handler | NOT SAFE as proposed; no saving shown |
| Same tools per role, one canonical representation | NO BENEFIT: read-only roles already get an identical list, and a host controls tool names only, not the definitions' text or order |
| Read-only roles get the writers' list with an SDK-side deny | not on current evidence: the model would still see write tools, and the saving is unproven |

The reason is structural. The authorizer builds its allow-set from the same `toolsForRole` list the model
is shown (`src/main/modules/policies/authorizer.ts:178`), its only role check for Edit, Write and
NotebookEdit is membership of that set (`:373`), and a write inside the worktree is then allowed
(`:210-219`). The SDK is given no other restriction (`tools: spec.tools`, `claude-sdk-runtime.ts:727`).
Widening the list would therefore widen the authorizer: a reviewer or verifier could edit the code it
judges. For the NEXUS tools the gate allows `mcp__nexus__*` unconditionally (`authorizer.ts:365`,
`claude-sdk-runtime.ts:274`), so presence of the handler is the control. And the saving is not shown to
exist: a role-specific system prompt follows the tools in the cached prefix, and loading the NEXUS tools
upfront changed nothing when measured.

**TOOL DEFINITION OPTIMIZATION: NOT ENABLED — SECURITY PRESERVED.** The gate asks that the lever be
evaluated, and it was; adopting it is not required. Not verified: where the runtime places its cache
breakpoints, and whether two read-only roles already share a tools-only prefix (one measurement, no code
change, would say).

## Not verified

- A representative real campaign comparing 0.7.1 with 0.7.0 across bug fix, feature, debugging,
  architecture, security, refactor, Program and Workspace. One real pair was run. The account's weekly
  usage window stood at about 92% (it resets on 2026-10-10), and a pair costs about one to two points, so
  eight pairs were not run. The Arena has no context-variant dimension yet.
- Engineering-quality effect of the Context Graph (needs the campaign above).
- Compaction fidelity and rotation fidelity on real sessions.
- Usage-window change per mission.
- Tool search with a large external tool set; whether a deferred NEXUS tool costs a search turn.
- Cache lifetime in effect. All real cache figures are one session per condition on `haiku`.
- Installer execution (as in 0.7.0).

## Known limitations

- The graph is off for agents by default. People can use it in the Context view.
- Symbol-level nodes are limited to the widely imported files Repository Intelligence already finds.
- Conflicts are found by subject key; two statements about one thing under different titles are not compared.
- Freshness uses file size and modification time, not content.
- A `summary` context breakdown is the runtime's estimate (it over-stated a real request by about half).
  `full` is counted by the runtime and makes token-count calls.
- Cache miss causes are NEXUS's inference; the API's own diagnostics do not reach a host of the Agent SDK.
- Reviewer and verifier prompts carry no graph section.

## Release gate

| Requirement | State | Evidence |
| --- | --- | --- |
| All 0.7 functionality green | met | full suite, end-to-end, stress, migration campaign |
| Context Graph exists | met | `CONTEXT_GRAPH.md` |
| Existing memories unified, not duplicated | met | nodes project the stores; a test asserts no record has two nodes |
| Tree navigation | met | Context view, `context_open` |
| Typed relations | met | 16 edge types, each with evidence |
| Provenance | met | on every node and edge |
| Freshness and invalidation | met | file state, incremental refresh from the git diff |
| History and supersession | met | versions, events; a superseded node stays superseded |
| Progressive disclosure | met | map, selected nodes, tools; seen in the real pair |
| Coarse-to-fine retrieval | met | benchmark |
| Exact evidence stays retrievable | met | a node names its source files; `context_open` returns the record's full text |
| Generated summaries cannot override verified truth | met | summaries are computed from children, carry their own trust level and rank below verified nodes |
| Context Engine V3 consumes the graph | met | off by default |
| Token Intelligence Engine | met | `TOKEN_INTELLIGENCE.md` |
| Request composition measurable | met | breakdowns add up to the runtime's total; a `summary` breakdown is an estimate |
| Stable prompt architecture | met | role prompts are constants; a test keeps them free of volatile text |
| Caching where supported | met, as the runtime does it | measured; NEXUS adds no breakpoint because a host cannot |
| Diagnostics | met, as local inference | the API's diagnostics are NOT AVAILABLE to a host |
| Tool definitions optimized | **not done** | the lever found (one tool list for all roles) changes the security posture and was left for its own review |
| Tool search evaluated | met | measured: no effect on request size; left to the runtime |
| Lossless artifact externalization | met | raw outputs stay stored; prompts carry excerpts and references |
| Tool-result management | met for check output; the runtime's own clearing is NOT AVAILABLE to a host | |
| Session efficiency | met | decision recorded per session; pressure rotation off |
| Compaction evaluated | partly | recorded when it happens; no real session compacted, so fidelity is NOT VERIFIED |
| Context editing evaluated | met | evaluated as NOT AVAILABLE through the Agent SDK |
| Prompt deduplication | met | audited; nothing to remove |
| Usage integration | met | Usage sections Cache, Context, Context techniques |
| Non-regression Arena | **not met** | one real pair instead of a campaign over eight categories; the Arena has no context-variant dimension |
| Retrieval recall benchmarks | met | 18 tuning and 7 held-out cases |
| No model downgrade for tokens | met | routing unchanged |
| No security regression | met | security review: no CRITICAL or HIGH; findings fixed |
| Full tests | met | 3,958 of 3,958 |
| Control Plane stress | met | 10,000 and 5,000 seeds |
| Context and token stress | met | 100,000 nodes, 5,000 histories |
| End-to-end | met | 29 of 29 |
| Build, package | met | installer built; ten old databases open in the packaged build |
| No unresolved CRITICAL or HIGH | met | three HIGH found by review, all fixed with tests |
| **Quality does not regress** | not shown by a campaign | by construction for the defaults; one real pair equal |

Two requirements are not met and one is met in part. By the rule of the specification that makes the
release PARTIAL.

## Recommendation

1. **To reach PASS:** after the usage window resets (2026-10-10), run the paired comparison on eight tasks,
   one per category (`pnpm accept:graph` runs one pair; it needs a task list). Feed the outcomes to
   `evaluateGate`. Two things can come out, and both are a result: the graph stays off for agents and 0.7.1
   ships as it is, or the graph is shown non-inferior and may be turned on by default.
2. Until then the branch can be used as it is: the defaults are those of 0.7.0 plus failure-first output.
   Merging without the campaign is a decision for the owner of the repository, not one this report makes.
3. The largest saving found is not in 0.7.1: one prefix per role costs about 15,000 written tokens for each
   of four or five roles in every mission. Sharing a tool list across roles would remove most of it. It
   needs a security review first, because read-only roles would then see tools they may not use.
4. Give the Arena a context-variant dimension, so that this comparison is a campaign like any other.

Nothing of 0.8 was started.
