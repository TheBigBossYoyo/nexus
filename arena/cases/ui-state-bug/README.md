# ui-state-bug

Category: ui. Complexity: medium. Risk: low.

## What it measures

Whether an agent can repair a framework-free UI state layer (reducer, selectors, view model, store) whose defects
only show up as wrong screens: in-place mutation, stale selections after remove/delete/filter change, select-all
selecting hidden items, counts derived from the filtered list, wrong button boundaries and labels, needless
re-renders caused by copying untouched slices and by notifying on no-ops.

## Why the hidden tests are fair

- Every rule tested is written in the fixture README or in the doc comment of `src/viewModel.js` (purity,
  identity of untouched slices, no-op returns the same state, selection only holds existing visible items,
  exact summary and toolbar formats). Selection order is explicitly "not significant" and is compared sorted.
- Purity is checked by deep-freezing every state, so any mutation throws, and by comparing a JSON snapshot of the
  previous state after each action.
- Edge cases a superficial fix misses: pruning the selection on `setFilter` and `removeItem` but not when
  `toggleDone`/`markSelectedDone` hides an item under `hideDone`; fixing mutation but still copying all items
  (identity); fixing `deleteSelected`'s disabled state at 1 but not the label or `markDone` count; `selectAllVisible`
  must be a no-op when it changes nothing; the store must not notify for no-ops (requires the reducer to return the same
  state).
- A seeded random action sequence is compared with a small independent model after every step, so all rules
  must hold in combination. Only exported names are used.
