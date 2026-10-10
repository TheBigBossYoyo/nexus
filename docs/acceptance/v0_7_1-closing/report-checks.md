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
