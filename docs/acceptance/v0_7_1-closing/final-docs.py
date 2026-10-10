"""The pages that state the release status of 0.7.1. Run from the repository root."""
import io
import sys


def patch(p, pairs):
    s = io.open(p, encoding='utf-8', newline='').read()
    for a, b in pairs:
        if s.count(a) != 1:
            sys.exit('%s: %d of %r' % (p, s.count(a), a[:70]))
        s = s.replace(a, b)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)


patch('README.md', [(
    "| 0.7.1 | none (branch `nexus-0.7.1-token-intelligence`) | 2026-10-07 | Not released | Context Graph and token intelligence. Tests, stress and packaging are green; the release gate is PARTIAL because the real comparison campaign against 0.7.0 was not run. Report: `docs/V0_7_1_RELEASE_REPORT.md` |",
    "| 0.7.1 | `v0.7.1` | 2026-10-10 | Recommended | Context Graph and token intelligence. A real campaign of fifty runs over eight task categories found it non-inferior to 0.7.0 with no case worse; with the Context Graph, on by default, missions used 16% fewer turns. It also fixes a defect that blocked real programs in 0.7.0. Report: `docs/V0_7_1_RELEASE_REPORT.md` |",
)])

patch('docs/TEST_STATUS.md', [
    (
        "Factual status as of 2026-10-07, version 0.7.1, branch `nexus-0.7.1-token-intelligence` (not merged, not tagged:\nthe release gate is PARTIAL). Details and evidence: `docs/V0_7_1_RELEASE_REPORT.md`. The released version is\n0.7.0 (`v0.7.0`). The sections of earlier versions below are their records, unchanged.",
        "Factual status as of 2026-10-10, version 0.7.1 (`v0.7.1`, release gate PASS). Details and evidence:\n`docs/V0_7_1_RELEASE_REPORT.md`. The sections of earlier versions below are their records, unchanged.",
    ),
    (
        "## 0.7.1: automated (no Claude usage)\n",
        "## 0.7.1: final source, 2026-10-10\n\nMeasured on commit `82671c8` (later commits change documents only). No Claude usage except where a row says so.\n\n| Check | Result |\n|---|---|\n| `pnpm typecheck`, `pnpm lint` | pass |\n| `pnpm test`, run alone | 169 files, 3,981 of 3,981 passed |\n| `pnpm test:e2e` | 29 of 29 passed, 2 capture-only tests skipped by design |\n| Orchestrator stress, 1,000 seeds (three processes side by side) | passed |\n| Workspace and Arena stress, 5,000 seeds each | passed |\n| The other eight stress suites at release sizes | passed, on `00dcddf`; the changes since do not reach them |\n| `pnpm package` | `release/NEXUS-Setup-0.7.1.exe`, 208,109,581 bytes, SHA-256 `c86e9318...12d64f93` |\n| Navigation benchmark (`context_open` calls an oracle walker needs) | planner 103 to 5 over 18 tuning cases, 38 to 3 over 7 held-out cases |\n| Retrieval benchmark | unchanged: hybrid pack 100% and 100% recall, no non-current record shown as current |\n| Real campaign against the 0.7.0 sources (real Claude, 50 runs, 8 task categories) | no case worse; quality gate NON_INFERIOR with the Context Graph off and on; with it on, six mission categories used 16.1% fewer turns and 7.5% less input |\n| Real compaction fidelity (real Claude, one session, deliberate trigger) | compaction occurred; 27 of 28 facts kept, 15 of 15 that lived only in the conversation; the task continued correctly. Automatic trigger NOT VERIFIED |\n| Tool-definition sharing across roles | reviewed for security and NOT ENABLED |\n| Migration campaign, runtime soak | not repeated (no schema change since 2026-10-07) |\n| Installer execution | NOT VERIFIED |\n\nTwo tests failed on time limits in the full run on `00dcddf`, and each led to a defect older than this release:\nthe workspace schema parser took 4.8 s on a hostile contract (now one pass, a few milliseconds), and the Arena\nperformance evaluator took 108 s of its 120 s limit (now about 40 s, same verdicts).\n\n## 0.7.1: automated, as measured on 2026-10-07 (no Claude usage)\n",
    ),
    (
        "## 0.7.1: manual and with real providers\n",
        "## 0.7.1: manual and with real providers, as measured on 2026-10-07\n\nSuperseded where the section \"0.7.1: final source\" above says otherwise: the campaign and the compaction\ncheck were run on 2026-10-10.\n",
    ),
])

patch('docs/V0_7_1_PROGRESS.md', [(
    "Branch `nexus-0.7.1-token-intelligence`, from `main` at `v0.7.0`. Not merged, not tagged.",
    "Branch `nexus-0.7.1-token-intelligence`, from `main` at `v0.7.0`. Closed on 2026-10-10: release gate PASS,\nmerged into `main` and tagged `v0.7.1` (not pushed). What closed it is in `V0_7_1_RELEASE_REPORT.md`, section\n\"Closing work, 2026-10-10\": the real campaign against 0.7.0, compaction on a real session, the security review\nof tool-definition sharing, and the Context Graph on by default. The rest of this page is the state of\n2026-10-07.",
)])
print('ok')
