# performance-optimization

Category: performance. Complexity: medium. Risk: low.

## What it measures

Whether an agent can find and remove several independent algorithmic hot spots in a small log analytics
pipeline while keeping every output byte-identical: a regular expression compiled per line plus a quadratic
`concat` accumulator (parse), an `Array.some` scan with an expensive `keyOf` (dedupe), a full re-filter per
event (rolling window), one pass per distinct service (service table) and one sort per requested percentile
(latency summary).

## Why the hidden tests are fair

- No wall-clock timing. Work is counted: property reads through a Proxy around the events, calls of the
  injected `keyOf`, `RegExp` constructions and `Array.prototype.sort`/`concat` calls while a function runs.
  Budgets are generous multiples (20x reads, 3x `keyOf` calls, 10 sorts) of what a linear solution needs
  for n = 20000, while the original code exceeds them by orders of magnitude; counters throw once the budget
  is spent, so the unoptimised code fails fast instead of hanging.
- Results are compared to straightforward oracles written in the test, at moderate sizes and at scale.
- Edge cases a quick fix misses: equal timestamps (events sharing `ts` all count for each other), window 0,
  windows larger than the data, custom parse `levels` (a hoisted default-only regex breaks them), a custom
  `keyOf`, keeping the first duplicate in input order, many distinct services, and `percentile` not
  reordering its caller's array.
- Only public exports are used; no internal helper names are required.

## Version 2
Scaling is now measured behaviourally: each operation is timed in-process at n and 4n items (best of several runs after a warm-up) and must stay well below the quadratic ratio. Nothing counts calls of built-ins or property reads, so any linear or n log n implementation passes. A quadratic de-duplication that merely caches its keys fails; two different linear variants pass (see `tests/fixtures/arena-solutions/performance-optimization-variants/`).
