# bugfix-cross-module

Measures: tracing a symptom in consumer modules (pricing, inventory, pipeline) to a root cause in a shared helper, and fixing it there.

- Category: bugfix. Complexity: medium. Risk: medium.
- Fixture: `order-desk`, an order pricing / stock reservation / invoicing pipeline (9 source files).
- Defect: `mergeLines` in `src/lines.js` mutates its input: it rewrites `line.sku` in place and uses the caller's first line object as the accumulator (`existing.qty += line.qty`). A second call over the same order merges again and doubles quantities. Visible tests only call each consumer once, so they pass.

Why the hidden tests are fair:
- They use only public exports and assert behaviour (repeatable totals, untouched inputs, exact reserved quantities and stock levels), not implementation details.
- A frozen (deep-frozen) order must flow through `priceOrder`, `Inventory.reserve`, `processOrder` and `mergeLines`; any correct non-mutating implementation passes.
- Superficial fix that fails: cloning the order inside `priceOrder` only (the symptom the prompt mentions first) still leaves `Inventory.reserve` and `processOrder` mutating the order and inflating reservations on retry. Likewise de-duplicating in each consumer fails the `mergeLines` direct tests.
- Merge ordering (first-seen), SKU normalisation, all-or-nothing reservation and invoice content are re-asserted so rewrites that change them fail.

## Version 2
The hidden evaluation command now names its test file explicitly (no glob expansion, works on Node 20 and newer without a shell) and the case allows up to 8 agents so it never caps a strategy's own parallelism.
