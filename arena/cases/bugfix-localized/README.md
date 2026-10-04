# bugfix-localized

Measures: finding and fixing a one-token logic defect in a small library without collateral changes.

- Category: bugfix. Complexity: small (low). Risk: low.
- Fixture: `pager-kit`, a dependency-free pagination helper set (7 source files, visible node:test suite).
- Defect: `pageCount` in `src/page-count.js` uses `remainder > 1` instead of `remainder > 0`, so a final page holding exactly one item is not counted. The visible tests only use remainders of 0 or 2+.

Why the hidden tests are fair:
- They only use the public exports (`paginate`, `pageCount`, `pageWindow`, `describePage`, `pageFromQuery`).
- The prompt describes the symptom (11 items, page size 5, single-item list) but not the tests; any correct page count passes.
- They sweep many total/pageSize combinations, so a fix that special-cases the reported numbers fails.
- Superficial fix that fails: patching `paginate` to add a page itself (or only handling `totalItems < pageSize`) leaves `pageCount`, `pageWindow` and `pageFromQuery` consumers wrong for 11/5 or 101/100.
- Existing behaviour (0 items, exact multiples, clamping, validation) is re-asserted so a rewrite that regresses it fails.
