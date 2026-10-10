# NEXUS 0.7.1 Release Report

Context, memory and token intelligence. Branch `nexus-0.7.1-token-intelligence`, from `main` at `v0.7.0`.
Written 2026-10-07, closed 2026-10-10. Every figure below names its source; a figure without a source is not in this report.

## Verdict

**PASS.** Written 2026-10-10. The sections of 2026-10-07 below are kept as they were written, with a note
where the closing work changed their conclusion; "Closing work, 2026-10-10" holds what was done since.

The report of 2026-10-07 was PARTIAL for one missing requirement, with two more open: the real campaign
against 0.7.0 had one pair instead of eight categories, compaction fidelity had never been seen on a real
session, and the tool-definition lever had not been evaluated for security. All three are closed:

- **The campaign was run**: fifty real runs over the eight task categories, 0.7.1 against the sources of
  0.7.0. No case is worse on 0.7.1. The quality gate finds 0.7.1 non-inferior, with the Context Graph off
  and with it on.
- **The release now lowers cost by default.** With the Context Graph on, missions used 16% fewer turns, 7.5%
  less input and 14% less output than on 0.7.0 over the six mission categories, at equal quality. It is on
  for agents by default. On 2026-10-07 it cost six extra turns in its one real run; that was a walk of the
  tree, which is gone (one context tool call in sixteen runs).
- **Compaction was observed on a real session**: 27 of 28 facts kept, all 15 that existed only in the
  conversation, and the task continued correctly. The automatic trigger was not exercised.
- **Tool definitions were evaluated and are not shared across roles**: the authorizer's allow-set is the tool
  list, so sharing it would give reviewers real write access. Security preserved.

What the campaign also did, and what a reader should know before relying on this release:

- It found defects that are not about tokens and fixed them: a real program was blocked in every version,
  0.7.0 included, on a correct judgment written in the wrong form; the quality gate could call a variant
  inferior that was worse on no case; the security tests alarmed the user's antivirus on every run.
- Its figures are from one to six runs per cell. The quality result is a gate verdict over eight paired
  cases with no case worse. The cost figures are what these runs measured, with a consistent direction in
  four of six mission categories; they are not a proven effect size.
- A mission can still end paused on a review task its planner added, with the work verified (the security
  task, in every arm, as on 0.7.0), and an agent that writes through the shell asks for an approval an
  unattended run cannot give. Neither is new and neither is fixed here.

See "Release gate" for each requirement.

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

> **2026-10-10.** Three rows changed. "Context Graph in agent context" and "Context Engine V3" are **on** by default: the real campaign found them non-inferior in quality and cheaper (see "The real quality campaign"). "Compaction" was verified on one real session for the deliberate trigger (see "Real compaction fidelity"). The rows below are the state of 2026-10-07.

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

> **2026-10-10.** This section is the state of 2026-10-07: one real pair, in which the graph cost six extra turns. Its conclusions are superseded by "Why the graph-backed mission took six more turns" and "The real quality campaign" below: the walk is gone, fifty real runs were made against the 0.7.0 sources, and the release lowers cost by default.

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

> **2026-10-10.** The first item no longer holds. The graph cost tokens while reaching knowledge took a walk of the tree; with the walk gone it used fewer turns and tokens than 0.7.0 over the six mission categories, at equal quality, and it is on by default.

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

### The real quality campaign: 0.7.0 against 0.7.1, eight task categories

Fifty real runs on the Claude subscription, 2026-10-10, each one a whole mission, program or workspace
mission from the request to the result. Evidence: one file per run in `docs/acceptance/campaign`; the gate's
answer in `docs/acceptance/campaign-gate.json`; tables by `node scripts/campaign-report.mjs`.

**Arms.** `070`: the sources of the tag `v0.7.0`, in their own checkout. `071`: the 0.7.1 sources with the
Context Graph off for agents. `071-graph`: the 0.7.1 sources with it on. One file
(`tests/manual/campaign/run.smoke.ts`) drives all three and refuses to run an arm on the wrong sources. It
measures through its own wrapper around the runtime and through tables both versions write, so the arms are
measured by one instrument.

**Held identical.** The starting repository of each task; the request; the models (the default role policy,
unchanged between the versions: `claude-opus-5-5` for planning, review and verification, `claude-sonnet-5-5`
for workers); the preset; one agent at a time; the permissions; the time budget; the hidden evaluation. No
approval request is ever granted: a run that asks is refused, as an unattended run would be, and the refusal
is counted.

**Tasks.** One per category, each a small repository with a request, knowledge NEXUS holds about it (approved
project memory, stored the same way by both versions), a hidden evaluation that is never in the repository,
and a reference solution. Without any model, a test proves for every task that its own tests pass as given,
that the hidden evaluation fails as given, and that it passes with the reference solution
(`tests/integration/campaign/tasks.test.ts`).

| # | Category | Task |
| --- | --- | --- |
| 1 | localized bugfix | laps out of order after the 16-bit packet counter wraps |
| 2 | cross-module bug | cart and invoice totals differ by a cent; both must follow one money rule |
| 3 | normal feature | a CSV export that follows the project's export conventions |
| 4 | refactor | one validation module for three handlers, behaviour and messages unchanged |
| 5 | architecture task | an exporter registry in place of a switch, with its decision record |
| 6 | security-sensitive task | a static file resolver that lets requests leave the served directory |
| 7 | Program-style task | a key-value store library in two milestones, through the Program engine |
| 8 | Workspace / cross-repository task | an optional field added to a contract in two repositories, through the Workspace engine |

**Stopping.** One run per cell first. A cell whose arms disagreed, or whose result looked like chance, was
repeated. The localized bug was the one mission where an arm failed (one graph run of four against none of
three): the rule was then fixed before any further run, six runs in every arm and no more, whatever came out.
It came out 5 of 6 in every arm.

#### Quality

Counts over the runs of each cell. "Completed" is the mission's own acceptance (its verifiers passed and
nothing was left blocked); "hidden" is the hidden evaluation on the result.

| Task | Arm | Runs | Completed | Hidden evaluation passed | First-pass verification | Reviewer findings (critical / high / other) | Repairs | Regressions | Approvals refused / pauses |
| --- | --- | ---: | --- | --- | --- | --- | ---: | ---: | --- |
| localized-bug | 070 | 6 | 5/6 | 5/6 | 2/6 | 0 / 0 / 0 | 0 | 0 | 7 / 1 |
| localized-bug | 071 | 6 | 5/6 | 5/6 | 4/6 | 0 / 0 / 0 | 0 | 0 | 5 / 1 |
| localized-bug | 071-graph | 6 | 5/6 | 5/6 | 4/6 | 0 / 0 / 1 | 0 | 0 | 6 / 1 |
| cross-module-bug | 070 | 2 | 2/2 | 2/2 | 1/2 | 0 / 0 / 0 | 0 | 0 | 3 / 0 |
| cross-module-bug | 071 | 2 | 2/2 | 2/2 | 1/2 | 0 / 0 / 0 | 0 | 0 | 4 / 0 |
| cross-module-bug | 071-graph | 2 | 2/2 | 2/2 | 2/2 | 0 / 0 / 0 | 0 | 0 | 4 / 0 |
| feature | 070 | 1 | 1/1 | 1/1 | 1/1 | 0 / 0 / 1 | 0 | 0 | 0 / 0 |
| feature | 071 | 1 | 1/1 | 1/1 | 1/1 | 0 / 0 / 1 | 0 | 0 | 0 / 0 |
| feature | 071-graph | 1 | 1/1 | 1/1 | 1/1 | 0 / 0 / 1 | 0 | 0 | 0 / 0 |
| refactor | 070 | 2 | 2/2 | 2/2 | 2/2 | 0 / 0 / 1 | 0 | 0 | 2 / 0 |
| refactor | 071 | 2 | 2/2 | 2/2 | 2/2 | 0 / 0 / 0 | 0 | 0 | 3 / 0 |
| refactor | 071-graph | 2 | 2/2 | 2/2 | 2/2 | 0 / 0 / 0 | 0 | 0 | 2 / 0 |
| architecture | 070 | 1 | 1/1 | 1/1 | 0/1 | 0 / 0 / 2 | 0 | 0 | 1 / 0 |
| architecture | 071 | 1 | 1/1 | 1/1 | 1/1 | 0 / 0 / 1 | 0 | 0 | 0 / 0 |
| architecture | 071-graph | 1 | 1/1 | 1/1 | 1/1 | 0 / 0 / 0 | 0 | 0 | 1 / 0 |
| security | 070 | 1 | 0/1 | 1/1 | 1/1 | 0 / 0 / 0 | 0 | 0 | 0 / 1 |
| security | 071 | 1 | 0/1 | 1/1 | 1/1 | 0 / 0 / 0 | 0 | 0 | 1 / 1 |
| security | 071-graph | 1 | 0/1 | 1/1 | 1/1 | 0 / 0 / 0 | 0 | 0 | 0 / 1 |
| program | 070 | 3 | 0/3 | 0/3 | 2/3 | 0 / 0 / 0 | 0 | 0 | 0 / 0 |
| program | 071 | 1 | 1/1 | 1/1 | 1/1 | 0 / 0 / 0 | 0 | 0 | 2 / 0 |
| program | 071-graph | 1 | 1/1 | 1/1 | 0/1 | 0 / 0 / 1 | 0 | 0 | 1 / 0 |
| workspace | 070 | 2 | 1/2 | 1/2 | 1/2 | 0 / 0 / 0 | 0 | 0 | 2 / 1 |
| workspace | 071 | 2 | 1/2 | 1/2 | 1/2 | 0 / 0 / 0 | 0 | 0 | 1 / 1 |
| workspace | 071-graph | 2 | 2/2 | 2/2 | 2/2 | 0 / 0 / 0 | 0 | 0 | 2 / 0 |

What the table does not show by itself:

- **No case is worse on 0.7.1.** There is no task where 0.7.0 passed its hidden evaluation and a 0.7.1 arm
  did not.
- **Security, all three arms:** the fix passed its verification and the hidden evaluation (9 of 9). The
  mission still paused, in every arm alike, because the planner added a security-review task that ended
  blocked. This is 0.7.0 behaviour, unchanged.
- **Workspace:** each blocked run failed at the consumer's contract-copy step after a refused approval.
- **Program on 0.7.0: 0 of 3.** One run was blocked at the plan (a milestone with more than eight acceptance
  criteria), two at the verification of the first milestone: the verifier wrote its judgment as a report in
  prose instead of the JSON object the engine reads. The prompts and the parser are the same in 0.7.1, where
  the first six runs failed the same way (`docs/acceptance/campaign-before-reasoning-fix`). This is a defect
  of the released 0.7.0 against the current model, found by this campaign. It is fixed in 0.7.1 (`5d58c46`:
  a read-only run a program reads names the shape of its answer and the runtime enforces it; saying what was
  wrong on a retry, `a8a2e24`, had not been enough). After the fix both 0.7.1 arms completed the program:
  two milestones planned, built, verified and accepted, hidden evaluation 8 of 8. So 0.7.1 is better here
  because of a bug fix, not because of context or tokens.
- **First-pass verification** differs between arms mostly through one thing: 47 approval requests were
  refused over the campaign. Of the 27 whose command was recorded, 17 were a worker or a debugger writing a
  file through the shell (`cat >> file <<EOF`) instead of the edit tool, and most of the others an agent
  restoring the old version of a file to show its new test failing before the fix. A refused write leaves
  the task undone, its verification fails, and a repair task finishes it. This happens in every arm; it is
  why a mission sometimes takes 8 sessions instead of 5. It is a finding about the product (an agent that
  writes through the shell asks for an approval an unattended run cannot give), not about context.
- **Reviewer findings:** none critical or high in any run of any arm.

#### Efficiency

Mean of the runs of each cell. Tokens are what the runtime reported. Compactions: none in any run (the
0.7.0 adapter cannot report one). Session rotations: none.

| Task | Arm | Runs | Sessions | Turns | Tool calls recorded | Context-tool calls | Uncached input | Cache written | Cache read | Output | Rotations | Compactions | Wall time |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| localized-bug | 070 | 6 | 6.5 | 48.3 | 41.8 | 0.0 | 20k | 58k | 461k | 20k | 0.0 | 0.0 | 221 s |
| localized-bug | 071 | 6 | 6.5 | 47.8 | 41.3 | 0.0 | 20k | 46k | 463k | 20k | 0.0 | 0.0 | 224 s |
| localized-bug | 071-graph | 6 | 5.5 | 43.0 | 37.5 | 0.0 | 16k | 53k | 422k | 18k | 0.0 | 0.0 | 186 s |
| cross-module-bug | 070 | 2 | 6.0 | 56.5 | 50.5 | 0.0 | 22k | 59k | 419k | 26k | 0.0 | 0.0 | 240 s |
| cross-module-bug | 071 | 2 | 6.0 | 50.5 | 44.5 | 0.0 | 22k | 57k | 415k | 25k | 0.0 | 0.0 | 237 s |
| cross-module-bug | 071-graph | 2 | 5.5 | 47.5 | 42.0 | 0.0 | 20k | 60k | 463k | 23k | 0.0 | 0.0 | 219 s |
| feature | 070 | 1 | 5.0 | 36.0 | 31.0 | 0.0 | 14k | 31k | 284k | 16k | 0.0 | 0.0 | 161 s |
| feature | 071 | 1 | 5.0 | 43.0 | 38.0 | 0.0 | 15k | 36k | 329k | 17k | 0.0 | 0.0 | 169 s |
| feature | 071-graph | 1 | 5.0 | 42.0 | 37.0 | 0.0 | 15k | 35k | 330k | 16k | 0.0 | 0.0 | 157 s |
| refactor | 070 | 2 | 8.0 | 70.0 | 62.0 | 0.0 | 27k | 72k | 504k | 25k | 0.0 | 0.0 | 237 s |
| refactor | 071 | 2 | 8.0 | 76.0 | 68.0 | 0.0 | 26k | 72k | 555k | 26k | 0.0 | 0.0 | 256 s |
| refactor | 071-graph | 2 | 5.0 | 40.5 | 35.5 | 0.0 | 18k | 47k | 332k | 18k | 0.0 | 0.0 | 178 s |
| architecture | 070 | 1 | 10.0 | 72.0 | 62.0 | 0.0 | 30k | 73k | 580k | 32k | 0.0 | 0.0 | 323 s |
| architecture | 071 | 1 | 8.0 | 62.0 | 54.0 | 0.0 | 26k | 65k | 519k | 28k | 0.0 | 0.0 | 285 s |
| architecture | 071-graph | 1 | 8.0 | 55.0 | 47.0 | 0.0 | 26k | 63k | 478k | 24k | 0.0 | 0.0 | 241 s |
| security | 070 | 1 | 5.0 | 39.0 | 34.0 | 0.0 | 17k | 46k | 452k | 28k | 0.0 | 0.0 | 309 s |
| security | 071 | 1 | 5.0 | 42.0 | 36.0 | 0.0 | 16k | 59k | 466k | 31k | 0.0 | 0.0 | 373 s |
| security | 071-graph | 1 | 5.0 | 42.0 | 37.0 | 0.0 | 18k | 64k | 470k | 29k | 0.0 | 0.0 | 302 s |
| program | 070 | 3 | 6.7 | 30.7 | 24.0 | 0.0 | 21k | 36k | 269k | 16k | 0.0 | 0.0 | 164 s |
| program | 071 | 1 | 16.0 | 105.0 | 87.0 | 0.0 | 56k | 157k | 821k | 51k | 0.0 | 0.0 | 504 s |
| program | 071-graph | 1 | 18.0 | 98.0 | 78.0 | 0.0 | 71k | 182k | 901k | 52k | 0.0 | 0.0 | 532 s |
| workspace | 070 | 2 | 15.5 | 125.5 | 110.0 | 0.0 | 41k | 101k | 882k | 44k | 0.0 | 0.0 | 450 s |
| workspace | 071 | 2 | 14.0 | 109.5 | 95.5 | 0.0 | 37k | 81k | 702k | 38k | 0.0 | 0.0 | 385 s |
| workspace | 071-graph | 2 | 13.0 | 110.5 | 97.5 | 0.5 | 41k | 97k | 819k | 40k | 0.0 | 0.0 | 434 s |

**Totals over the six mission categories (sum of cell means; tasks every arm has run: localized-bug, cross-module-bug, feature, refactor, architecture, security)**

| Arm | Runs | Completed | Hidden evaluation passed | Turns | Uncached input | Cache written | Cache read | Output | Wall time | Against 0.7.0: turns / all input / output / wall |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 070 | 13 | 11/13 | 12/13 | 322 | 130k | 339k | 2701k | 148k | 1491 s | baseline |
| 071 | 13 | 11/13 | 12/13 | 321 | 126k | 335k | 2747k | 147k | 1544 s | -0.2% / +1.2% / -0.5% / +3.5% |
| 071-graph | 13 | 11/13 | 12/13 | 270 | 113k | 321k | 2496k | 126k | 1282 s | -16.1% / -7.5% / -14.4% / -14.0% |

**Totals over Program and Workspace (sum of cell means; tasks every arm has run: program, workspace)**

| Arm | Runs | Completed | Hidden evaluation passed | Turns | Uncached input | Cache written | Cache read | Output | Wall time | Against 0.7.0: turns / all input / output / wall |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 070 | 5 | 1/5 | 1/5 | 156 | 62k | 137k | 1151k | 60k | 614 s | baseline |
| 071 | 3 | 2/3 | 2/3 | 215 | 93k | 238k | 1524k | 89k | 889 s | +37.4% / +37.4% / +48.0% / +44.9% |
| 071-graph | 3 | 3/3 | 3/3 | 209 | 112k | 279k | 1720k | 93k | 965 s | +33.5% / +56.3% / +54.2% / +57.3% |

Read plainly:

- **0.7.1 with the graph off is 0.7.0** within the noise of these runs: turns -0.2%, all input +1.2%, wall
  clock +3.5% over the six mission categories. It saves nothing, as the earlier report said.
- **0.7.1 with the graph on used less** over the six mission categories: turns -16.1%, all input -7.5%,
  output -14.4%, wall clock -14.0%. The direction holds in four of the six categories (localized bug,
  cross-module bug, refactor, architecture) and not in two (feature, security), which have one run each.
  With one to six runs per cell this is a measured difference of this campaign, not a proven effect size.
- **The walk is gone.** One context tool call in all 16 graph runs (a workspace verifier opening the
  contract), against six in the single graph run of 2026-10-07.
- Program and Workspace totals compare unlike things: a run that is blocked early has done less work than
  one that finished. They are shown for completeness, not as a cost comparison.
- Usage: the weekly window went from 1% to 8% over the fifty runs and everything else done that day.

#### The gate

Every run is a trial; runs of one task in one arm are repetitions of one case; each 0.7.1 arm is compared
with 0.7.0 over the eight cases (`tests/integration/campaign/gate.test.ts`).

| Comparison | Verdict | Pass rate | Regressions | Improvements |
| --- | --- | --- | --- | --- |
| 0.7.0 → 0.7.1, graph off | NON_INFERIOR | 67% → 79% | none | program |
| 0.7.0 → 0.7.1, graph on | NON_INFERIOR | 67% → 85% | none | program, workspace |

Judged by the hidden evaluation alone the rates are 79% → 92% and 79% → 98%, with the same verdicts.

The gate itself had a defect, and the campaign found it. For the first comparison it answered INFERIOR while
listing no regression and one improvement: one case going from failing to passing among seven equal ones
gives a lower bound of -8.1 points on the spread of that improvement alone. A variant that is worse on no
case cannot be inferior. The bound is now asked only when some case is worse (`quality-gate.ts`, with a test
that the same spread with one case worse is still refused). Both readings are recorded here; the verdicts in
the table are the corrected gate's.

**Consequence.** The Context Graph is non-inferior in quality and is the only variant that lowers cost. It is
on for agents by default from this release (`AUTO_DEFAULTS.contextGraph`); `off` remains a setting.

### Real compaction fidelity

One real worker session (`claude-sonnet-5-5`, the worker's tools and the real authorizer of a worktree),
six turns, compacted once on purpose (`pnpm accept:compaction`;
`docs/acceptance/compaction-fidelity-2026-10-10T10-03-39-334Z.json`).

| | |
| --- | --- |
| Did a compaction occur | yes |
| Mechanism | the runtime's own compaction of a streaming session, started by sending `/compact` (trigger `manual`) |
| History before and after | 21,822 tokens to 2,422, in 8.0 s (the runtime's figures) |
| Observable context before and after | 21,167 tokens to 18,020 (the context breakdown at the next turn; the system prompt and tools are not compacted) |
| Facts established before the compaction | 28 of 28, restated with no tool call |
| Retained after it, restated with no tool call | 27 of 28 |
| Of those that existed only in the conversation | 15 of 15 retained |
| Lost | one: the list of test files no longer named `window.test.js`, a file that was in the repository before the session and is still on disk |
| Task quality afterwards | the session continued the task; hidden evaluation 2 of 2; every test passed; the file of the open bug it was told not to touch is unchanged |

The facts were the objective, three acceptance criteria, four numeric values (two of them written in no
file), four paths, two decisions, two open bugs with what must not be done about them, two security
constraints, five files changed, three tests and two Context Graph references. The continuation needed what
only the brief had said: a retry schedule from the interval, the multiplier and the maximum (the hidden
evaluation checks the six delays), and a log line that carries twelve characters of a hash and never the key.

What this does not show: the automatic trigger at a full context window was not exercised (it needs a
session of 100,000 tokens or more); this is one session on one model; and in a mission NEXUS does not rely
on the summary at all for the task, its criteria, decisions, commits and findings, which live in its stores.

### Other defects the campaign and the user's reports found, fixed in 0.7.1

| Defect | Since | Fix |
| --- | --- | --- |
| A program was blocked on a correct milestone judgment written as prose | 0.4 (with the current model) | `5d58c46`: the runtime enforces the shape of a reasoning answer; `a8a2e24`: a retry says what was wrong |
| The quality gate called a variant inferior that was worse on no case | 0.7.1 | `0d15c07` |
| The security corpus wrote attack-shaped text files into the system temp directory; an antivirus flagged them on every test run, alerted the user and locked them, which was the EPERM at the corpus's teardown | 0.7.0 | `514a7ea`: the fixtures are built inside the checkout |
| Every GitService left an empty `nexus-no-hooks-` directory in the temp directory: one per start of the runtime, more than ten thousand on a developer's machine | 0.7.0 | `514a7ea`: one per process, removed at exit |

Observed and not changed in 0.7.1: an agent that writes a file through the shell, or restores an old version
of a file to show a test failing, asks for an approval an unattended run cannot give (47 refusals in the
campaign, in every arm). A mission whose planner adds a review task of its own can end paused on that task
although the work is verified (the security task, in every arm).

### Checks on the final source

Measured 2026-10-10 on commit `82671c8`, the code of the release; later commits change documents only. No
Claude usage. The "Tests" and "Stress" sections above are the measurements of 2026-10-07 on `db9c9dc`.

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm test`, run alone | 169 files, 3,981 of 3,981 passed (2026-10-07: 166 files, 3,958) |
| `pnpm test:e2e` | 29 of 29 passed, 2 capture-only tests skipped by design, 14.7 min beside the stress run (8.0 min alone, on `00dcddf`) |
| `pnpm package` | `release/NEXUS-Setup-0.7.1.exe`, 208,109,581 bytes, SHA-256 `c86e9318ca49fa518eafc27f3c16f8a04f2f331a1a6fc473e891204b12d64f93` |
| Orchestrator stress, 1,000 seeds | passed, as three processes side by side (seeds 1 to 334, 335 to 668, 669 to 1,000): 2,481 s, 2,500 s and 2,493 s |
| Workspace and Arena stress, 5,000 seeds each | passed, 208 s |
| The other eight stress suites (control plane runtime at 10,000 seeds; queue, overnight twice, policy, usage, program at 5,000; Context Graph at 100,000 nodes and 5,000 histories) | passed, with workspace and Arena, 10 files in 1,825 s, on `00dcddf` |
| Migration campaign on the packaged build | not repeated: no migration and no stored shape changed since 2026-10-07 (schema 12) |
| Runtime soak | not repeated for 0.7.1 |
| Installer execution | NOT VERIFIED (as in 0.7.0) |

Between `00dcddf` and `82671c8` three things changed, all found by the full test run on `00dcddf`, where two
tests failed on time limits: the workspace schema parser (below), the Arena performance evaluator, and their
tests. The checks those changes can touch were run again on `82671c8`: the full suite, the end-to-end suite,
the package, the orchestrator stress, and the workspace and Arena stress. The other eight stress suites do
not reach that code and stand as run on `00dcddf`.

Two defects those failures led to, both older than this release:

| Defect | Since | Fix |
| --- | --- | --- |
| A database schema contract was read by a pattern that looked from every statement head to the end of the text when no statement ended: 30,000 unterminated `create table` statements took 4.8 s of the runtime's thread. Its test had a bound of 5 s and had been passing just under it | 0.5 | `12c5a30`: one forward pass with the same rule, a few milliseconds, bounded by the test at 500 ms; the old pattern and the new pass give the same statements on 20,005 fixed and random inputs |
| The Arena performance evaluator took 108 s of its 120 s limit on the unoptimized fixture, so any other load ended in a timeout instead of a verdict | 0.6 | `d5d41c5` (case version 4): a run that is already long is not timed again, and "far too slow" is judged at half the size first; about 40 s, with the ratio limit, the rounds and the verdicts unchanged |

One mistake of this close-out, for the record: for a few minutes two check queues were started at the same
moment and one removed the other's log directory, so a package build was skipped and an end-to-end run
started against an older build. Both were stopped and discarded; the figures above are from the runs made
after it.

## Not verified

- The automatic compaction trigger at a full context window, and compaction on more than one session or
  model. The deliberate trigger was verified on one real session.
- Rotation fidelity on real sessions (pressure rotation stays off).
- The size of the Context Graph's saving beyond this campaign: one to six runs per cell, small repositories,
  one machine, two models. The direction is measured; the magnitude on large repositories is not.
- Whether two read-only roles already share a tools-only cached prefix, and where the runtime places its
  cache breakpoints.
- Tool search with a large external tool set; whether a deferred NEXUS tool costs a search turn.
- Cache lifetime in effect. The cache figures of 2026-10-07 are one session per condition on `haiku`.
- A real program or workspace mission on a repository of realistic size. The campaign's are small.
- Installer execution (as in 0.7.0).

## Known limitations

- Symbol-level nodes are limited to the widely imported files Repository Intelligence already finds.
- Conflicts are found by subject key; two statements about one thing under different titles are not compared.
- Freshness uses file size and modification time, not content.
- A `summary` context breakdown is the runtime's estimate (it over-stated a real request by about half).
  `full` is counted by the runtime and makes token-count calls.
- Cache miss causes are NEXUS's inference; the API's own diagnostics do not reach a host of the Agent SDK.
- Reviewer and verifier prompts carry no graph section; they have the tools. The planner and a task's agents
  get the map and the selection.
- An unattended run refuses every approval request. An agent that writes a file through the shell instead of
  the edit tool therefore loses that write, and a repair task does the work again.
- A mission whose planner adds a review task of its own can end paused on it with the work verified.

## Release gate

State on 2026-10-10. A row that changed since 2026-10-07 says so.

| Requirement | State | Evidence |
| --- | --- | --- |
| All 0.7 functionality green | met | full suite, end-to-end, stress on the final source (see "Checks on the final source"); migration campaign of 2026-10-07 (no schema change since) |
| Context Graph exists | met | `CONTEXT_GRAPH.md` |
| Existing memories unified, not duplicated | met | nodes project the stores; a test asserts no record has two nodes |
| Tree navigation | met | Context view, `context_open` |
| Typed relations | met | 16 edge types, each with evidence |
| Provenance | met | on every node and edge |
| Freshness and invalidation | met | file state, incremental refresh from the git diff |
| History and supersession | met | versions, events; a superseded node stays superseded |
| Progressive disclosure | met | map, selected nodes, tools; an open returns a branch with what is under it |
| Coarse-to-fine retrieval | met | retrieval benchmark; navigation benchmark |
| Exact evidence stays retrievable | met | a selected entry names its source files; `context_open` returns the record's full text |
| Generated summaries cannot override verified truth | met | summaries are computed from children, carry their own trust level and rank below verified nodes |
| Context Engine V3 consumes the graph | met, **on by default (changed)** | the campaign and the gate |
| Token Intelligence Engine | met | `TOKEN_INTELLIGENCE.md` |
| Request composition measurable | met | breakdowns add up to the runtime's total; a `summary` breakdown is an estimate |
| Stable prompt architecture | met | role prompts are constants; a test keeps them free of volatile text |
| Caching where supported | met, as the runtime does it | measured; NEXUS adds no breakpoint because a host cannot |
| Diagnostics | met, as local inference | the API's diagnostics are NOT AVAILABLE to a host |
| Tool definitions optimized | **evaluated: NOT ENABLED, SECURITY PRESERVED (changed)** | independent security review, verified against the code; the requirement is that the lever be evaluated, and adopting it would give read-only roles write access |
| Tool search evaluated | met | measured: no effect on request size; left to the runtime |
| Lossless artifact externalization | met | raw outputs stay stored; prompts carry excerpts and references |
| Tool-result management | met for check output; the runtime's own clearing is NOT AVAILABLE to a host | |
| Session efficiency | met | decision recorded per session; pressure rotation off |
| Compaction evaluated | **met for the deliberate trigger (changed)**; automatic trigger NOT VERIFIED | one real session: 27 of 28 facts kept, the task continued correctly |
| Context editing evaluated | met | evaluated as NOT AVAILABLE through the Agent SDK |
| Prompt deduplication | met | audited; nothing to remove |
| Usage integration | met | Usage sections Cache, Context, Context techniques |
| Non-regression Arena | **met by the real campaign (changed)** | fifty real runs over eight categories against the 0.7.0 sources, through the quality gate. The Arena itself still has no context-variant dimension: the campaign has its own runner |
| Retrieval recall benchmarks | met | 18 tuning and 7 held-out cases, unchanged by the closing work |
| No model downgrade for tokens | met | routing unchanged; the campaign's arms ran the same models |
| No security regression | met | security review of 2026-10-07; tool-definition review of 2026-10-10; the security corpus passes |
| Full tests | met | see "Checks on the final source" |
| Control Plane stress | met | see "Checks on the final source" |
| Context and token stress | met | see "Checks on the final source" |
| End-to-end | met | see "Checks on the final source" |
| Build, package | met | see "Checks on the final source" |
| No unresolved CRITICAL or HIGH | met | none open; the campaign's reviewers reported none in any run |
| **Quality does not regress** | **shown by the campaign (changed)** | no case worse on 0.7.1; gate verdict NON_INFERIOR with the graph off and with it on |
| **Lower context, token and usage cost without reducing engineering performance** | **met with the Context Graph, now the default (changed)** | six mission categories: turns -16.1%, input -7.5%, output -14.4%, wall clock -14.0%, at equal quality. Measured on this campaign; the magnitude elsewhere is NOT VERIFIED |

Every requirement is met. Two are met in a stated, limited sense: compaction for the deliberate trigger
only, and tool definitions by evaluation, not adoption.

## Recommendation

1. Merge into `main` and tag `v0.7.1`. Not pushed.
2. Give the Arena a context-variant dimension, so that the next comparison of this kind is a campaign like
   any other and does not need its own runner.
3. Take up the two product findings of the campaign: an agent that writes through the shell loses its write
   in an unattended run, and a mission can end paused on a review task its planner added.
4. Measure the Context Graph on a repository of realistic size before saying anything about how much it
   saves there.
5. One measurement, no code: whether two read-only roles already share a tools-only cached prefix.

Nothing of 0.8 was started.
