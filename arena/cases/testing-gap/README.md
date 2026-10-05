# testing-gap

Category: testing. Complexity: medium. Risk: low.

## What it measures

Whether an agent can turn a thin test suite into one that actually protects behaviour. The fixture
(`cronkit`, a UTC cron parser and next-run search) has sound code and seven shallow tests. The agent adds
tests under `test/`; it must not touch `src/`.

## How it is evaluated

The hidden test copies the project (including the agent's `test/`) into temporary directories, always with
the pristine sources from `evaluator/hidden-tests/pristine/` (nothing is mutated in place, edits to `src/` are
ignored). It then runs `node --test` with `process.execPath` (no shell):

1. on the unmodified sources: the agent's tests must pass and number at least 8;
2. on each of 13 documented mutants (single string replacements, each valid JavaScript and a real behaviour
   change): at least 10 must make the agent's tests fail (exit code non-zero, timeouts included).

## Why it is fair

- Every mutant is listed with a description in the evaluator and is detectable through the public API by
  testing documented behaviour (boundaries, `*/1`, `5-5`, name case, weekday 7, alias definitions, the
  day-of-month/day-of-week union and the `*/n` wildcard rule, `nextRun` strictly after `from`, month rollover,
  the five-year horizon, `runsPerDay`).
- Three mutants may be missed without penalty; the shipped tests alone kill 1 of 13.
- Tests that assert nothing, or that fail on the real code, cannot score.

## Version 2
The evaluator now also applies behaviour-preserving edits (comments, renamed locals, reordered independent statements, equivalent expressions) and requires the agent's tests to still pass on them: a suite that hashes or greps the sources fails. A mutant only counts as killed when an individual test fails, not when the test file crashes.
