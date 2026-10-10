# Context Graph research (NEXUS 0.7.1)

Researched 2026-10-07. Part 1 maps what NEXUS 0.7.0 already has. Part 2 surveys the techniques. Part 3 is the
design decision and where it departs from the specification. Status labels are those of
`TOKEN_OPTIMIZATION_RESEARCH.md` (PROVEN, DOCUMENTED, EXPERIMENTAL, INFERRED, NOT AVAILABLE).

## Part 1. What exists in 0.7.0

### The stores

| Store | Table | Scope | Written by | Trust model | Staleness | Supersession | Search |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Repository Intelligence | `repository_facts` (+FTS5) | project | static analysis, manifests, git; also agent, verifier, user | `source` + `confidence` | `fingerprint` over supporting files' size and mtime; `stale` flag | re-analysis overwrites analysis-owned facts only | path and term ranking in `intelligence/select.ts` |
| Project Memory | `memory` (+FTS5) | global, project, run | agents propose; user or verifier-pass approves | `status` proposed / approved / rejected, `evidence` | none | none | BM25 (`memory_fts`), then a term filter in `context-engine.ts` |
| Program Memory | `program_memory` | program | milestone verifier, engine, user; validated (`validateMemory`) | `source.kind`, `evidence`; instruction-shaped text refused | none | `status` active / superseded | term overlap weighted by kind (`program/memory.ts`) |
| Workspace Memory | `workspace_memory` | workspace | verification, user, engine | `source.kind`, `evidence` | none | none | by repositories named |
| Decisions | `decisions`, `program_decisions`, `workspace_decisions` | run, program, workspace | agents, engines | none | none | none | by task graph position |
| Contracts | `workspace_contracts` (+versions, consumers) | workspace | discovery, user | versioned | version rows | versions | by provider / consumer |
| Artifacts | `artifacts`, `agent_output`, `tool_events`, `reviews`, `verification_results` | run | NEXUS | authoritative records | n/a | n/a | by run / task |
| Context Packs | `context_packs`, `context_pack_entries` | run | context engine | every entry has a reason | n/a | n/a | by run / task / agent |

### How they relate today

They do not. Each store is read by its own engine:

- The **Context Engine V2** (`context-engine.ts`) reads `repository_facts` and `memory` only. A task in a
  Program mission does not see Program Memory through the pack; the Program engine writes it into the
  mission brief text. A task in a Workspace mission does not see Workspace Memory or contracts through the
  pack; the Workspace engine writes them into the task description.
- Four relevance functions, three tokenizers and three stop-word lists do the same job (baseline D7).
- Staleness exists only for facts. Supersession exists only for Program Memory. A decision can contradict a
  fact and nothing notices.
- A fact names files, but nothing links a module fact to the test-mapping fact, the decision or the
  contract about the same code. The relationships are implicit in subject strings (`a -> b`).
- There is no hierarchy. The Intelligence view lists facts by kind; the Memory view lists entries by date.

What is already right and must be kept:

- Every store has provenance, and the write paths are guarded (agents propose, evidence required,
  instruction-shaped text refused, user-owned knowledge never overwritten by analysis).
- Facts are verified against files and go stale when the files change.
- The pack records why each entry was included or excluded.
- The pack is already small and selective (at most 8 facts, a handful of memory entries).

### Consequence

The gap is not that agents receive too much project knowledge. It is that (a) the knowledge is split across
stores that cannot see each other, (b) relationships are not represented, so related knowledge in another
store or another branch is not found, (c) freshness, supersession and conflict are handled in one store
each, and (d) an agent cannot navigate: whatever the pack did not select, the agent must rediscover with
Grep and Read, at about 9k processed input tokens per extra turn (baseline section 3).

## Part 2. Techniques

Each entry: mechanism; token effect; quality effect; cache; memory; security; SDK support; difficulty;
lossless?; Arena needed?; recommendation.

### G1. Just-in-time retrieval and progressive disclosure

- **Mechanism.** Keep lightweight identifiers in context and load detail through tools; let the agent
  discover context layer by layer (Anthropic, "Effective context engineering"). DOCUMENTED.
- **Token effect.** Smaller starting context; cost moves to tool calls the agent chooses to make.
- **Quality.** Helps when the pre-selected context would have been wrong or diluted; hurts when the agent
  fails to fetch something it needed. The source recommends a **hybrid**: some context up front, the rest on
  demand.
- **Recommendation.** Hybrid. The pack keeps its selected facts; the graph adds a compact map and tools.

### G2. Hierarchical summaries (RAPTOR-style trees)

- **Mechanism.** Cluster leaves and summarise recursively; retrieve at the level of abstraction the query
  needs (Sarthi et al., RAPTOR, 2024). Summaries are generated by a model.
- **Token effect.** Good coarse-to-fine retrieval; building and refreshing the tree costs model calls.
- **Quality.** Model-written summaries are lossy and go stale; in a code base they can assert things the
  code no longer does.
- **Recommendation.** Adopt the shape, not the generator. NEXUS builds branch summaries **deterministically**
  from the verified children (counts, names, statements), so a summary costs no Claude usage, cannot
  hallucinate, and is rebuilt exactly when a child changes. A model-written summary may be stored only as
  GENERATED_SUMMARY and is never preferred over its sources. INFERRED that this is sufficient; the
  retrieval benchmark tests it.

### G3. Knowledge graphs with community summaries (GraphRAG)

- **Mechanism.** Extract entities and relations with a model, detect communities, summarise each (Edge et
  al., "From Local to Global", 2024).
- **Token effect.** Indexing is expensive (many model calls over the whole corpus); global questions get
  cheaper.
- **Quality.** Strong for "what are the themes" questions over prose; relations are model-extracted and can
  be wrong.
- **Recommendation.** Not for NEXUS. Code relations are available exactly from static analysis (imports,
  test mappings, manifests, contract providers and consumers). The specification already says not to
  manufacture plausible relations. Use typed edges from verified evidence only.

### G4. Temporal knowledge graphs (Zep / Graphiti)

- **Mechanism.** Facts carry validity intervals; a new fact invalidates the old one instead of deleting it;
  retrieval defaults to what is currently valid (Rasmussen et al., Zep, 2025).
- **Quality.** Directly addresses "stale fact presented as current" and "superseded decision".
- **Recommendation.** Adopt the idea in a simple form: every node has a status (CURRENT, STALE, SUPERSEDED,
  CONFLICTED, ARCHIVED), a version history, and SUPERSEDES edges. Default retrieval returns CURRENT only.

### G5. Agent-editable memory (MemGPT / Letta, the Claude memory tool)

- **Mechanism.** The agent reads and writes its own memory with tools: core memory in context, archival
  memory searched on demand (Packer et al., MemGPT, 2023); a `/memories` directory with file commands
  (Claude memory tool, DOCUMENTED).
- **Quality.** Lets long work survive context resets. The risk is unreviewed text becoming durable
  instruction (memory poisoning).
- **SDK support.** The API memory tool is NOT AVAILABLE through the Agent SDK. NEXUS tools can offer the
  same operations.
- **Recommendation.** Offer notes as a scoped, lowest-trust node type: an agent may write AGENT_NOTE nodes
  under its own task, program or project; it may never edit a VERIFIED or USER_PROVIDED node; promotion
  needs evidence and the existing approval path. Notes are rendered as quoted data, never as instructions.

### G6. Lexical, structural and semantic retrieval

- **Mechanism.** BM25 for exact terms and identifiers; structure (paths, symbols, edges) for code;
  embeddings for paraphrase. Anthropic's Contextual Retrieval measured embeddings + BM25 better than either,
  and recommends skipping retrieval entirely below ~200k tokens of knowledge. DOCUMENTED.
- **NEXUS's situation.** Queries are task descriptions that name files, modules, commands and symbols.
  SQLite FTS5 is already present. A vector index would need an embedding model (a new dependency, a
  download or an API call) and an index to keep fresh.
- **Recommendation.** Structure first, then FTS5 BM25, combined. No embeddings in 0.7.1. The ablation
  benchmark (hierarchy only, FTS only, graph + FTS, graph + FTS + file relations) decides what stays; a
  semantic arm is added only if a recall gap remains that lexical and structural signals cannot close.

### G7. Repository maps (Aider) and code graphs (RepoGraph, CodexGraph)

- **Mechanism.** A compact map of files and their most-referenced symbols, ranked by graph centrality and
  sized to a token budget (Aider); line-level or symbol-level dependency graphs queried by the agent
  (RepoGraph, CodexGraph, 2024).
- **Quality.** Reported to raise localisation accuracy on repository-level tasks: the agent starts where
  the change is.
- **Recommendation.** Repository Intelligence already extracts modules, entry points, import relations,
  interfaces and test mappings. The graph turns those facts into nodes and edges and renders the map. Symbol
  nodes are limited to exported interfaces the analyser already finds; a full symbol index is out of scope.

### G8. Freshness by content dependency

- **Mechanism.** A derived record stores the hash of what it was derived from; a change in the source marks
  the record stale (build systems; NEXUS's own fact fingerprints).
- **Recommendation.** Generalise the fact fingerprint: every node lists its sources with the hash observed;
  `git diff --name-only` between the last refreshed commit and HEAD gives the changed files; only nodes with
  a changed source are touched, and staleness propagates to the summaries above them.

### G9. Conflict detection

- **Mechanism options.** Model-judged contradiction (costs usage, can be wrong) or key-based (two CURRENT
  records that claim the same subject with different content).
- **Recommendation.** Key-based only. A node has a `subjectKey`; two current nodes in one scope with the
  same key and different content, and no SUPERSEDES edge between them, are CONFLICTED and are shown as such.
  NEXUS does not guess that two differently named statements contradict each other. This catches the
  mechanical case and says so; the semantic case stays NOT DETECTED and is documented as a limit.

## Part 3. Decision

### One index over the existing stores, not a fifth store

The specification asks for a canonical `ContextNode` with content. Copying every fact and memory into node
rows would create exactly the duplicated source of truth it also forbids. So:

- The existing tables remain the **sources of truth** for their records. Nothing is migrated out of them.
- `context_nodes` is a **projection and an index**: one node per knowledge item, holding its place in the
  hierarchy, its title, a bounded summary, status, trust, hashes and a pointer (`originKind`, `originId`) to
  the record it projects. Projection is idempotent and incremental; a node is rebuilt from its record.
- Structure that no store had lives only in the graph: the hierarchy (workspace, repository, architecture,
  modules, commands, decisions, hazards, programs, history), typed edges, sources, versions, status.
- Knowledge that has no home in an old store (agent notes, branch summaries, user-written nodes) is
  graph-native: `originKind = 'graph'`, and the node row is the record.

Deleting the graph tables loses navigation and history of status changes, never a fact.

### Tree for navigation, graph for truth

Each node has exactly one parent (its canonical place) and a canonical path, so the tree is unambiguous and
indexable. Everything else is an edge. A contract is one node under `contracts/`; the provider module and
each consumer module reach it by PROVIDES / CONSUMES edges. "Views" from several branches are edges, not
copies.

### Trust and status are separate axes

| Trust (how it is known) | Status (whether it holds now) |
| --- | --- |
| VERIFIED: static analysis, manifest, git, verifier | CURRENT |
| USER_PROVIDED | STALE: a source changed |
| INFERRED | SUPERSEDED: replaced, kept as history |
| AGENT_NOTE | CONFLICTED: disagrees with another current node |
| GENERATED_SUMMARY: derived from children | ARCHIVED: removed from active retrieval |
| | PROPOSED: awaiting approval |

The specification's single list (VERIFIED ... STALE, CONFLICTED) mixes the two; a VERIFIED fact can be
STALE. Retrieval ranks by trust and filters by status.

### Deterministic summaries

Branch summaries are computed from children. No model call writes knowledge into the graph in 0.7.1. This
is the main departure from tree-of-summaries systems and is what makes the graph free to maintain.

### Hybrid packs, and what "token saving" means here

The pack keeps V2's selection and gains: the compact map of the task's branch, the nodes reached by typed
edges from the task's files (tests, decisions, contracts, hazards, in whatever store they live), and four
tools to go further. The pack may grow by a few hundred tokens. The saving this design can produce is in
**turns**: each exploration turn avoided is about 9k processed input tokens. That saving can only be
measured with real runs; until one exists it is INFERRED, and the graph's packs become the default on the
strength of retrieval recall and precision (which are measured deterministically), not on a token claim.

### What is deliberately not built

| Not built | Why |
| --- | --- |
| Vector store / embeddings | No evidence of a recall gap that structure + BM25 leave; adds a model dependency |
| Model-extracted relations | Verified relations are available from analysis |
| Model-written summaries | Deterministic ones cost nothing and cannot drift from sources |
| Semantic contradiction detection | Would be a guess; key-based conflicts only |
| Full symbol index | Exported interfaces only, from the existing analyser |
| Markdown mirror of the graph | The database is the store; export can come later |

### Risks

| Risk | Mitigation |
| --- | --- |
| The graph adds tokens and no agent uses the tools | Measured per session (tool calls on context tools, turns); the map is bounded; the setting falls back to V2 packs |
| Projection drifts from the stores | Projection is a pure function of the records, re-run on every change and at refresh; a consistency test compares both |
| An agent note poisons later agents | Lowest trust, quoted as data, refused if instruction-shaped, never returned for high-risk tasks unless promoted |
| Wrong retrieval (same symbol name in two modules, similar paths) | Path and scope outrank text; adversarial retrieval tests; low confidence widens the selection instead of guessing |
| Large graphs | Indexed SQL, bounded traversal, pagination; tested at 100k nodes and 500k edges |
