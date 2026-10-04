# feature-multi-module

Measures: delivering one feature coherently across model, persistence format, service API, text rendering and command layer, while staying backwards compatible with existing saved data.

- Category: feature. Complexity: large (high). Risk: medium.
- Fixture: `todo-service` (9 source files) with visible tests for the existing behaviour.
- Missing capability: task priorities and due dates, specified in the prompt through exact names, error types and output formats.

Why the hidden tests are fair:
- Every asserted name, shape, error type, ordering rule and output string is stated in the prompt; the tests use only the public exports of `src/index.js` and temp directories for file persistence.
- Backwards compatibility is tested with a hand written version 1 payload (the format documented in the fixture), including upgrading an old file in place.
- Tie handling (priority, due date), undated tasks last, `dueBefore` strictness and sorting without mutating stored order catch sloppy comparators.
- Superficial implementations that fail: only extending the model and service (storage still drops the fields, so reloads lose data); bumping to version 2 without accepting version 1; rendering without the OVERDUE rule or applying it to done tasks; wiring flags in the command layer without validation; sorting the service's internal array in place; non-stable or reversed tie ordering.
- Date validation is by real calendar date (leap day accepted, 2025-02-30 rejected), not just a regex.
- No test depends on the wall clock; `today` is always passed explicitly.

## Version 2
The hidden evaluation command now names its test file explicitly (no glob expansion, works on Node 20 and newer without a shell) and the case allows up to 8 agents so it never caps a strategy's own parallelism.
