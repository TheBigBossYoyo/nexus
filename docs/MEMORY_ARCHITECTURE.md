# Memory architecture

How NEXUS's knowledge stores fit together after 0.7.1. The stores are unchanged; what is new is one index
over them (`CONTEXT_GRAPH.md`).

## The layers

```
        agent context (a context pack, tool results)
                         ▲
              Context Engine V3 (selection)
                         ▲
   ┌─────────────────────┴──────────────────────┐
   │              Context Graph                 │   index: tree, edges, status, trust,
   │   nodes · edges · sources · versions       │   freshness, history, notes
   └───▲────────▲──────────▲─────────▲──────────┘
       │        │          │         │  projection (idempotent, incremental)
 repository   project   program   workspace memory,
   facts      memory    memory    contracts, repositories
       ▲        ▲          ▲         ▲
   analysis   agents,   milestone   verification,
   manifests  user      verifier    user
       ▲
   the repository itself (always the final authority)
```

## Sources of truth

| Knowledge | Source of truth | In the graph as |
| --- | --- | --- |
| Languages, frameworks, modules, commands, imports, interfaces, test mappings, hot files | `repository_facts` (Repository Intelligence) | Projected nodes and edges |
| Hazards and decisions recorded as facts | `repository_facts` | Projected nodes, linked from the modules whose files they name |
| Project memory | `memory` | Projected nodes under `memory/`; proposed entries are PROPOSED and not retrieved |
| Program goal, milestones, memory, open backlog | `programs`, `program_milestones`, `program_memory`, `backlog_items` | Projected nodes under `programs/<program>/` |
| Workspace repositories, dependencies, contracts, memory | the `workspace_*` tables | Projected nodes and edges in the workspace graph |
| Notes by agents and the user | the graph | Graph-native nodes under `notes/` |
| Tree structure, relations between stores, status, history | the graph | |
| Run decisions, messages, reviews, check output, tool events | their own tables | Not in the graph; reached through packs and TaskEvidence |
| Code | the repository | Named as sources; never copied |

Nothing was migrated. A database of 0.7.0 gains empty graph tables; the graph is built the first time a
mission starts or the user presses Refresh in the Context view.

## What each store still does

- **Repository Intelligence** analyses the repository and verifies its own facts. The graph adds freshness
  between analyses: a fact whose file changed is stale in the graph at once, and a V3 pack does not show it.
- **Project memory** keeps its propose and approve flow. The graph adds supersession and conflict, which the
  memory table does not have: a superseded entry is no longer shown as project memory, and two approved
  entries that state one subject differently are shown with a conflict warning.
- **Program memory** keeps its validation (`validateMemory`) and its `superseded` status, which the graph
  follows. The graph makes program knowledge reachable by a task's files and words, and keeps it out of
  other programs.
- **Workspace memory and contracts** keep their engine. The graph links a project to its workspaces, so a
  task in one repository reaches the contracts it provides or consumes.

## Trust across stores

| Store and state | Graph trust | Graph status |
| --- | --- | --- |
| Fact from manifest, static analysis, git, verifier; confidence medium or high | VERIFIED | CURRENT, or STALE when the store says stale |
| Fact with low confidence | INFERRED | |
| Fact from the user | USER_PROVIDED | |
| Fact from an agent | AGENT_NOTE | |
| Memory approved, source user | USER_PROVIDED | CURRENT |
| Memory approved, other source | INFERRED | CURRENT |
| Memory proposed | AGENT_NOTE | PROPOSED |
| Memory rejected | not projected | |
| Program memory from the milestone verifier | VERIFIED | CURRENT or SUPERSEDED |
| Program memory from the user / the engine | USER_PROVIDED / INFERRED | |
| Workspace memory from verification / user / engine | VERIFIED / USER_PROVIDED / INFERRED | CURRENT |
| Contract, enrolled repository | VERIFIED | CURRENT |

An agent cannot raise trust. Speculation enters as an agent note or a proposed memory entry and becomes more
only through the user, a verifier with evidence, or the approval flow of the store that owns it.

## The Claude memory tool

The API's `memory_20250818` tool is not available through the Agent SDK, and Claude Code's own file memory is
disabled for NEXUS agents (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), because agents work in throwaway worktrees
and unreviewed memory files would be lost or would bypass review.

The same operations exist as NEXUS tools over the graph:

| Memory tool command | NEXUS |
| --- | --- |
| `view` a directory | `context_open` a branch |
| `view` a file | `context_open` a node |
| search (not in the memory tool) | `context_search`, `context_related` |
| `create` | `context_note` write |
| `str_replace`, `insert` | `context_note` update (the old text is kept as a version) |
| `delete` | `context_note` archive (nothing is deleted) |
| `rename` | `context_note` update with a new title |

Differences that are deliberate: an agent writes only notes, only in its project, and cannot touch verified
knowledge; a note is refused when it reads as an instruction; and the API's automatic "always view your
memory directory first" instruction is not added, because the pack already carries the map and the relevant
nodes.

## Hygiene

| Problem | What happens | Where |
| --- | --- | --- |
| Duplicate notes | Archived, the first one kept | `collectGarbage` |
| Progress notes of finished tasks | Archived | `collectGarbage` |
| Many notes in one branch | Folded into one note; originals archived and linked | `compactNotes` |
| Superseded knowledge | Out of retrieval; kept as history | `supersede`, program memory status |
| Stale knowledge | Not given as fact; flagged or withheld | freshness |
| Empty branches | Archived at sync | projection |
| Records that no longer exist | Node archived, restored if the record returns | projection |

## What is not unified

- Run decisions and run-scoped or global memory stay with the V2 path.
- The three older relevance functions still exist for their own callers (the V2 selection, the Program
  engine's mission brief, the fact ranking). V3 adds the graph's retrieval beside them; it does not replace
  them, because replacing them changes what agents receive and needs evidence first.
