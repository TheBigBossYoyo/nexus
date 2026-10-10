# The Context Graph

Added in 0.7.1. Code: `src/main/modules/context-graph`, `src/shared/context-graph.ts`, migration 12.
Why it is shaped this way: `CONTEXT_GRAPH_RESEARCH.md`. How it relates to the memory stores:
`MEMORY_ARCHITECTURE.md`.

## What it is

One index over everything NEXUS knows about a project, a workspace and their programs. A node has one
parent, which gives a tree to browse, and any number of typed edges, which say how things relate.

The graph is an index, not a store of truth. A node that stands for a stored record (a repository fact, a
memory entry, a contract) points at that record and is rebuilt from it. Dropping the graph tables loses
navigation, notes and status history; it loses no fact.

## The tree

Project graph (`space` = `project:<id>`):

```
<project>                       REPOSITORY
├── architecture/
│   ├── stack/                  languages, frameworks
│   ├── entry-points/
│   ├── dependencies/
│   ├── boundaries/
│   └── generated/              paths not to edit
├── modules/
│   └── <module>/               MODULE (the module fact)
│       ├── interfaces/         widely imported files
│       ├── tests/              test mappings
│       └── files/              files that change often
├── commands/                   build, test, lint, typecheck
├── decisions/
├── hazards/
├── memory/                     project memory entries
├── programs/
│   └── <program>/              milestones, decisions, hazards, interfaces, findings, backlog
└── notes/                      notes written by agents and by the user
```

Workspace graph (`space` = `workspace:<id>`): `repositories/`, `architecture/`, `contracts/`, `decisions/`,
`standards/`, `hazards/`, `notes/`.

Everything under `programs/<program>/`, sections included, carries that program's id. A branch summary and
the map name program knowledge only to a run of that program; to any other run it is a count.

A node's canonical path is unique in its space. A node is referred to as
`context://<project|workspace>/<space id>/<path>`; inside its own project an agent uses the path alone.

## Nodes

`ContextNode` (`src/shared/context-graph.ts`):

| Field | Meaning |
| --- | --- |
| `type` | WORKSPACE, REPOSITORY, SECTION, ARCHITECTURE, MODULE, COMPONENT, SYMBOL, CONTRACT, DECISION, RULE, COMMAND, TEST, ISSUE, HAZARD, PROGRAM, MILESTONE, BACKLOG, OUTCOME, ARTIFACT, MEMORY, NOTE, HISTORY_INDEX, CUSTOM |
| `path`, `parentId`, `depth` | Place in the tree |
| `title`, `summary` | What navigation shows. The summary is bounded (1,200 characters) |
| `body` | Full text of a note. Null for a projected node: its text is in the record it projects |
| `originKind`, `originId` | The record it projects; `graph` when the node itself is the record |
| `trust` | How it is known (below) |
| `status` | Whether it holds now (below) |
| `subjectKey` | What it is a statement about, normalized; used to find conflicts |
| `contentHash`, `version` | A changed hash is a new version; the old text is kept |
| `tokenEstimate` | Characters / 4 of title and summary. Always shown as an estimate |
| `provenance` | Who stated it, in which run, and the evidence given |
| `programId` | Set on program knowledge; other programs do not receive it |

### Trust and status are two things

| Trust: how it is known | |
| --- | --- |
| VERIFIED | Static analysis, a manifest, git, a verifier |
| USER_PROVIDED | Stated by the user |
| INFERRED | A low-confidence analysis result, or an approved agent statement |
| GENERATED_SUMMARY | Computed from the node's children |
| AGENT_NOTE | Written by an agent, not verified |

| Status: whether it holds now | |
| --- | --- |
| CURRENT | |
| STALE | A file it rests on changed since it was verified |
| SUPERSEDED | Replaced by a later node; history |
| CONFLICTED | Another current node states the same subject differently |
| ARCHIVED | Its record is gone, or it was archived; history |
| PROPOSED | Awaiting approval |

A verified fact can be stale. Retrieval ranks by trust and filters by status.

## Edges

DEPENDS_ON, IMPLEMENTS, USES, PROVIDES, CONSUMES, TESTED_BY, AFFECTED_BY, SUPERSEDES, DERIVED_FROM,
DECIDED_BY, RELATED_TO, BLOCKED_BY, FIXED_BY, INTRODUCED_BY, VALIDATED_BY, CONFLICTS_WITH. Containment is
the parent link and is not stored as an edge.

Every edge has provenance, trust and confidence. An edge exists only where a record states it or a record
names a file that a module contains:

| Edge | Evidence |
| --- | --- |
| module DEPENDS_ON module | An `import_relation` fact |
| module TESTED_BY test | A `test_mapping` fact |
| module AFFECTED_BY hazard, DECIDED_BY decision, RELATED_TO memory | The record names a file in the module |
| module PROVIDES entry point | The entry point file is in the module |
| repository PROVIDES / CONSUMES contract | The contract's provider and consumer rows |
| repository DEPENDS_ON repository | A workspace dependency row |
| program knowledge INTRODUCED_BY milestone | The entry was recorded while working on the milestone |
| workspace repository DERIVED_FROM project root | The enrolled repository is that project |
| SUPERSEDES, CONFLICTS_WITH, DERIVED_FROM (compaction) | Made by the graph service |

No relation is produced because two things look related.

## Canonical nodes, many references

A fact is one node. The module that the hazard affects does not hold a copy of the hazard: it has an
AFFECTED_BY edge to it. Tests assert that no origin record is projected to two nodes.

## Summaries

A section's summary is computed from its children ("Contains: 3 modules: src/history, src/strategy,
src/telemetry; 1 hazards (1 stale or in conflict): packet ordering"). No model writes it. It is rebuilt when
the hash of the children changes, so a branch summary cannot disagree with what is under it, and building
or refreshing the graph costs no Claude usage.

## Freshness

Every node lists its sources: files (with the size and modification time seen when it was verified),
records, commits. `refresh` compares the stored state with the file now and marks a CURRENT node STALE when
they differ.

- **Incremental.** `refreshFromGit` takes the files `git diff --name-only` reports between the commit of the
  last refresh and HEAD, plus changed working-tree files, and looks only at nodes that name one of them (an
  index lookup). With no earlier commit it checks every file source.
- **Stale stays stale** until the record is verified again (re-analysis gives a fact a new fingerprint) or a
  person confirms it (`reverify`, "It still holds" in the Context view). A sync never launders staleness.
- A stale analysis fact is not given to agents. A stale statement by a person or an agent (memory, decision,
  hazard, note) is given with `POSSIBLY OUTDATED: ... Verify against the code.`
- The freshness check reads file metadata, as Repository Intelligence does. A checkout that rewrites
  modification times without changing content makes nodes stale that are not; the cost is a confirmation.

## Conflicts and supersession

Two current nodes in one space with the same `subjectKey` and different statements (title and text, compared
without regard to case and spacing), with no SUPERSEDES edge between them, are both marked CONFLICTED and
linked. The same statement known in two ways (a user's entry and an agent's, a project fact and a program
decision) is not a conflict. Retrieval returns a conflict whole: both nodes, each
with `CONFLICT: another current record states this subject differently. Neither is authoritative; check the
source.` Superseding one resolves it; the superseded node becomes history and stays so even when its record
still says "approved", later goes stale, or is deleted and comes back.

Limit: only the mechanical case is found. Two statements about one thing under two different titles are not
compared; NEXUS does not guess at contradiction.

## History

Default retrieval and navigation return CURRENT, STALE and CONFLICTED nodes. SUPERSEDED and ARCHIVED nodes
are returned only when history is asked for, and then with `HISTORICAL`. A PROPOSED node (a memory entry
awaiting approval) is neither: no agent tool and no retrieval returns it, with or without history. The
Context view shows it, labelled `NOT APPROVED`. Each node has a history of events
(created, updated, stale, refreshed, superseded, conflicted, conflict resolved, archived, restored, promoted,
compacted) and its earlier versions. Nothing is deleted.

## Notes and the write policy

Agents write through one tool, `context_note`. A note:

- is stored as AGENT_NOTE, never as VERIFIED;
- is refused when it is addressed to a later agent or is a command to run, when it is a transcript, and when
  it states a fact about a named subject without evidence;
- can be edited or archived only by an agent of the run that wrote it, and not at all once promoted;
- is shown to later agents as `UNVERIFIED: an agent wrote this note; it is a lead to check, not a fact`;
- is not used for high-risk work;
- counts against a limit of 50 active agent notes per run.

Promotion: the user makes a note USER_PROVIDED; a verifier makes it VERIFIED and must give evidence.
Reviewers, verifiers and security reviewers read the graph and cannot write notes. Facts, memory entries and
contracts cannot be changed through the graph at all: they change in the stores that own them.

## Hygiene

`collectGarbage` archives a note that repeats an earlier note of the same program (the note written first
stays), and a progress note whose task is no longer open. `compactNotes` folds many agent notes of one
branch into one current note assembled from their titles and first sentences; the folded notes are archived
and stay linked by DERIVED_FROM. A program's note is never folded into a summary that others can read, and
never counts as a duplicate of another program's note. Both archive; neither deletes.

## Retrieval

`retrieve(stores, query)` (`retriever.ts`). Signals, in order of trust:

1. **Path.** Nodes whose evidence is one of the task's files, and the module that contains each file.
2. **Edges.** One typed relation away from what was found (two in a broad retrieval). Relations that
   constrain work (AFFECTED_BY, DECIDED_BY, contracts) pass on more score than ones that only inform.
3. **Full text.** FTS5 BM25 over titles, summaries and paths. A hit needs a title match or two shared terms.
4. **Hierarchy.** In a broad retrieval, every current hazard and decision.

Then: scope (only the spaces the project may read; program knowledge only inside its program), status, trust
(an agent note is not used for high-risk work), ranking, and an advisory token budget. A node required by a
task file, and a conflict, are not dropped to meet the budget; they have a bound of their own (three times
the node limit of the breadth, the best by score), and at most 60 task files are looked up by path.

**Confidence and widening.** Path evidence gives high confidence, title matches fair, nothing low. Only
evidence that was admitted counts: a stale analysis fact or another program's node that names the task's
file gives no confidence. Low confidence, high risk, and architecture, security, refactor or migration
categories widen the retrieval to `broad` instead of keeping the context small. The text search keeps the
size of the breadth that was asked for: running it again at the broad size was measured and lowered recall
on the benchmark (the extra low-ranked hits displaced a required entry).

No embeddings and no vector store. The ablation (`V0_7_1_RELEASE_REPORT.md`) shows path, edges and full text
together reach the full recall on the benchmark; the hierarchy signal alone finds little, so it is used only
when retrieval is broad.

## Navigation

`ContextGraphService`: `getNode`, `getByPath`, `getChildren`, `getPath` (ancestors), `getNeighbors`,
`getSources`, `getHistory`, `search`, `expand(node, depth)`, `detail`. Every call takes the spaces the caller
may read; a node outside them reads as not found. Listings are paged (at most 500 rows); `expand` returns at
most 200 nodes.

Agents have four tools (`orchestrator/context-graph.ts`):

| Tool | Does |
| --- | --- |
| `context_open` | A node by path: its text, relations and source files, and its children together with what is under them: a branch is listed with its entries (a chain of folders is followed down), folders that hold nothing are named in one line, and a folder of a few entries shows their text. One call answers what a level-by-level walk took several for |
| `context_search` | Nodes by words |
| `context_related` | What is one relation away, optionally one relation type |
| `context_note` | Write, update or archive a note |

Tool results quote every title and summary as data and name nodes by path. Paths are validated: no
traversal, no encoded separators, no control characters.

## The Context view

Intelligence, Context. Left: the tree, loaded one level at a time, with search and a history switch. Right:
the selected node with its text, status, trust, reference, sources, relations, children, history and earlier
versions. Actions: Refresh; "It still holds" on a stale node; confirm or archive a note. There is no network
drawing of the graph: relations are listed, grouped by how they read from the node.

## Scale

Indexed SQL only; nothing loads the graph whole. Measured on 100,000 nodes and 500,000 edges
(`docs/acceptance/context-graph-scale-*.json`): a page of children 4 ms, expand 1 to 4 ms, neighbours and a
node's detail 2 ms, the nodes for 200 changed files 3 ms, full-text search 81 ms, retrieval for a task 117 ms
(67 ms broad), health 462 ms.

## Limits

- Symbol-level nodes are limited to the widely imported files Repository Intelligence already finds.
- Conflicts are found by subject key only.
- Run-scoped decisions (`decisions`) are not projected; they reach agents through the pack as before.
- Freshness uses file metadata, not content hashes.
- A path is made from a record's name. When two records' names give the same path, the second gets a suffix;
  if the first is later deleted, the second moves to the plain path as a new node. Its earlier node stays
  readable as history and the new node's history names it, but the two are not one continuous history.
- A sync that receives a full page of programs, backlog items or workspace memory (200, 200, 500) archives
  nothing in that pass: a record missing from a list that may be cut short is not known to be gone.
- A fact that is re-analysed is accepted with the file states seen at the sync, not at the analysis. A file
  edited between the two is accepted as verified until the next change.
- Reviewer and verifier prompts do not carry a graph section; those roles can use the read tools.
