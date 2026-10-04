# Speculative Execution (0.3)

For a bounded task, NEXUS can have several independent agents implement the same thing from the same
commit, compare the results with objective checks, and send only the best one on to review and
verification. This costs one extra implementing session per extra candidate. It is off unless you choose
it or the policy is allowed to.

Code: `src/main/modules/orchestrator/speculation.ts` (the stage), `src/main/modules/strategy/tournament.ts`
(the ranking, pure), `src/main/modules/strategy/strategies.ts` (`SpeculativeStrategy`).

## When it runs

| Setting | Effect |
|---|---|
| Strategy `SPECULATIVE` chosen for a run | The run has no planner. The mission is one worker task whose implement stage is speculative. |
| Policy speculation `OFF` (default) | ADAPTIVE never chooses SPECULATIVE. |
| Policy speculation `AUTO` | ADAPTIVE may choose it where a promoted preference or an exploration draw says so. |
| Policy speculation `ALWAYS_FOR_HIGH_RISK` | In 0.3 this behaves as `AUTO`: SPECULATIVE becomes eligible, it is never a default. |

Candidates: 2 by default, 3 at most (`MAX_SPECULATIVE_CANDIDATES`). A request for more is clamped.

ADAPTIVE does not choose SPECULATIVE while Claude is not `AVAILABLE` or within an hour of a usage limit.
Both are facts the runtime reported, not estimates of remaining capacity.

Only the mission's own implementing task is speculative, and only on its first attempt. A retry, a repair
or a resumed task works on the chosen candidate like any other task.

## What happens

```
task worktree (from the integration branch)        base commit B
        │
        ├── candidate a: worktree nexus/<run>/implement-cand-a   from B   session A
        └── candidate b: worktree nexus/<run>/implement-cand-b   from B   session B
                 │  each: implement → commit → project check commands
                 ▼
            tournament (rankCandidates)
                 │
        winner fast-forwarded into the task worktree
                 │
        checks → review → verification → merge        (unchanged pipeline)
```

1. Each candidate gets its own worktree and branch, created from the commit the task's worktree is at.
2. One context pack is composed and given to every candidate. The prompts are identical except for the
   candidate's own worktree path and branch. No prompt mentions that other candidates exist.
3. The sessions run concurrently. A session's path boundary is its own worktree, so the tool policy
   refuses reads and writes in another candidate's directory. No message is routed between candidates.
4. When a session ends, anything uncommitted is committed and the project's check commands run in that
   worktree. The diff against the base commit is stored.
5. The tournament ranks the candidates and the decision is stored with every comparison it made.
6. The winner's branch is fast-forwarded into the task's worktree. It is always a fast-forward because
   the base is the same.
7. All candidate worktrees are removed and their branches deleted. Before that, each candidate's
   evidence, rank and diff (up to 200,000 characters) are in the database.
8. The task continues with the normal checks, review, verification and merge.

## How the winner is chosen

`rankCandidates` applies these rules in order; the first one that separates two candidates decides.

| # | Rule | Kind |
|---|---|---|
| 1 | Produced a result (the session ended normally without a blocker) | correctness |
| 2 | Check commands passed | correctness |
| 3 | Acceptance commands passed (when measured) | correctness |
| 4 | Fewer failing check commands | correctness |
| 5 | Fewer critical review findings (when a review was run) | correctness |
| 6 | Fewer high review findings (when a review was run) | correctness |
| 7 | Smaller change, by lines | tie-breaker |
| 8 | Fewer files changed | tie-breaker |
| 9 | Candidate label | tie-breaker |

A value that was not measured never wins or loses a rule. No rule reads tokens, turns or duration, and
no model is asked which candidate "looks better".

The stored confidence is `decisive` when a correctness rule separated the winner from the runner-up,
`marginal` when only a tie-breaker did, and `none` when no candidate produced a result.

## Edge cases

| Situation | Result |
|---|---|
| No candidate passes its checks | The best-ranked one is still adopted and goes through the normal repair loop. |
| No candidate produces a result | The speculative run is `failed`, the task fails as retryable, and the retry is a normal single implementation. Speculation is not repeated for that task. |
| Pause, usage limit or restart while candidates run | Finished candidates keep their evidence. Unfinished ones resume their SDK session when it is resumable, or continue in the same worktree with a fresh session. |
| The task is cancelled | Candidate worktrees and branches are removed. |
| The run is cleaned up | Leftover candidate worktrees are removed with the run's other worktrees. |

## In the Arena

The hidden evaluator of an Arena case is not an input to the tournament. If it were, SPECULATIVE would
be the only strategy that selects on the hidden test and the comparison would be worthless. In a trial
the tournament uses the visible check commands only; the hidden evaluator scores the finished trial, the
same way for every strategy.

## Records

| Table | Content |
|---|---|
| `speculative_runs` | Task, base commit, candidate count, state, winner |
| `candidate_results` | Label, session, branch, worktree, head commit, evidence, stored diff, rank, outcome, cleanup time |
| `tournament_decisions` | Winner, ranking, each comparison with the rule and the two values, confidence, reason |

Events: `speculative.started`, `speculative.candidate`, `speculative.decided`.

## Limits

- Check commands are the only objective signal at tournament time for a normal run. With no check
  commands configured, the tournament can only use change size and label, and says so (`marginal`).
- Candidates share the task's attempt counter and its lease; the speculative stage counts as attempt 1.
- A candidate's worktree has no row in `worktrees`; it is tracked in `candidate_results`.
- Speculation applies to a single-task run. A planned task graph has no speculative tasks in 0.3.
