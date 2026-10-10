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
