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
