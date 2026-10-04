# feature-small

Measures: implementing one precisely specified function in an existing library, including argument validation and edge cases, and wiring its export.

- Category: feature. Complexity: small (low). Risk: low.
- Fixture: `sales-report`, a dependency-free tabular report builder (7 source files) with visible tests for the existing API.
- Missing capability: `groupSummary(rows, options)`; the prompt gives the full contract (groupings, null key, sort keys, tie rule, limit, error types).

Why the hidden tests are fair:
- Everything asserted (result shape, null-key grouping, String(key) ordering, tie order, limit-after-sort, TypeError vs RangeError, no input mutation) is stated in the prompt; file layout is unconstrained apart from the export from `src/index.js`.
- Superficial implementation that fails: implementing `order: 'desc'` with `.reverse()` or a negated comparator on an unstable tie-break flips tied groups; applying `limit` before sorting; sorting keys with `localeCompare`; ignoring that non-numeric values still count; mutating or freezing-sensitive code on frozen input.
- Edge cases covered: empty input, missing/null group field, ties for total and count, every validation branch.
- Existing exports are re-checked so the index file is not broken while adding the new one.

## Version 2
The hidden evaluation command now names its test file explicitly (no glob expansion, works on Node 20 and newer without a shell) and the case allows up to 8 agents so it never caps a strategy's own parallelism.
