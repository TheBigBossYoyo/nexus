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
