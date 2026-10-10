# 0.7.2 parent reconciliation

State on 2026-10-10. The parent release is closed: NEXUS 0.7.1 passed its gates, was merged into `main`
(`dbe38e9`) and tagged `v0.7.1`. Nothing was pushed. Its verdict and evidence are in
docs/V0_7_1_RELEASE_REPORT.md.

The 0.7.2 branch `nexus-0.7.2-director-ui-compiler` was written by Codex on the parent while it was still
PARTIAL (parent commit `59e0502`). The final 0.7.1 was merged into it at `3fcd1e0`.

## The parent gates, as they closed

| Parent gate | How it closed |
| --- | --- |
| Eight-category real comparison campaign | 50 real runs over 0.7.0, 0.7.1 and 0.7.1 with the graph; the quality gate says NON_INFERIOR for both 0.7.1 arms. Missions with the graph: 16.1% fewer turns, 7.5% less input |
| Default graph retrieval value | On by default since 0.7.1, on that evidence |
| Compaction fidelity | One real compacted session: 27 of 28 facts retained, the task continued and passed its hidden evaluation |
| Security-sensitive tool-definition sharing | Investigated; no authority changed |
| Clean final regression | 3,981 of 3,981; end-to-end 29 of 29; orchestrator stress 1,000 seeds; package built |
| Windows teardown failure of the security corpus | The fixtures are built inside the checkout, not in the temp directory an antivirus scans |
| Performance evaluator at its time limit | Profiled and made faster without changing its limits or verdicts; a quadratic parser in the product was fixed |

## What the merge changed in 0.7.2

Conflicts: `src/main/modules/program/engine.ts` (both sides added an override of a reasoning run: the
engineering owner from 0.7.2 and the answer schema from 0.7.1; both are kept) and one test note.

Behaviour 0.7.2 was not written against, and what was done about it:

- The Context Graph is on by default. The Task Compiler reads the graph for its evidence; it now leaves out notes
  written by agents and labels the rest with their trust (review findings 7.1 and 8.1). The planner's graph
  section is kept as 0.7.1 released it (finding 8.2, accepted).
- Prompts are measured. 0.7.2 adds the request and the compiled advice to prompts; a worker's copies are now
  bounded (findings 9.1 and 9.2). Whether the saving measured for 0.7.1 survives the default AUTO depth of 0.7.2
  has not been measured: 0.7.2 makes no claim about it.
- Reasoning runs of the Program engine carry an answer schema the runtime enforces. Unchanged by 0.7.2.

The suite on the merged tree, before any 0.7.2 fix of this session: 182 files, 4,084 of 4,084.

## What stays true

Advisory models cannot authorize execution, change a policy or remove a gate. A model's output, a technical
challenge and a synthesis are proposals with their evidence. The user's request as written is the root of every
specification. None of this was relaxed by the reconciliation.
