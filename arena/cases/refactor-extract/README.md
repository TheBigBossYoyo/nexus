# refactor-extract

Category: refactor. Complexity: medium. Risk: medium.

## What it measures
Whether an agent can perform a behaviour-preserving extract-and-consolidate refactor across three
modules (invoice, quote, report) that each carry a slightly different-looking copy of the same
discount/tax/rounding arithmetic, without "fixing" anything along the way.

## Fixture
`billing-kit`: catalog, tax, validation, formatting, invoice, quote and report modules with passing
visible tests. The arithmetic is duplicated in `invoice.js`, `quote.js` and `report.js`.

## Hidden evaluation
- Characterisation tests of the public API with values recorded from the original code, including
  a half-cent float quirk (0.335 x 3) so "improved" rounding (epsilon, toFixed) is caught.
- Contract tests of `src/pricing.js` (specified in the prompt).
- Seam tests: install a ceil/floor rounding function and require every public function's line amounts to equal
  `computeLineTotal` output under that function, which proves delegation without inspecting source layout.

## Why it is fair
The module path, exports and the rounding seam are all specified in the prompt; the tests use only
public API and the specified seam. Aggregate rounding (subtotals, totals) is deliberately not constrained.
A superficial fix (creating `pricing.js` and wiring only one or two callers, or a module whose internals
call `Math.round` directly) fails the seam tests; a "cleanup" that changes rounding fails characterisation.

## Version 2
The hidden evaluation command now names its test file explicitly (no glob expansion, works on Node 20 and newer without a shell) and the case allows up to 8 agents so it never caps a strategy's own parallelism.
