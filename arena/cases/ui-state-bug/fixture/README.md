# todo-panel-state

The state layer behind a filterable, selectable to-do panel. There is no DOM or framework in this
package: a reducer, selectors and a view-model function that returns plain data for the UI to render.

## State

```js
{
  items: [{ id, title, tag, done }],
  filter: { text, tag, hideDone },   // text: case-insensitive substring of the title
  selection: [id, ...],              // order is not significant
}
```

## Rules the UI relies on

- Reducers are pure: a previous state is never modified, and slices an action does not change keep
  their object identity (`items`, `filter`, `selection`, and every untouched item), so the UI can skip re-renders.
- An action that changes nothing returns the very same state object.
- The selection only ever contains items that exist and are visible under the current filter.
- `createStore` listeners are only called when a dispatch produced a different state object.

## Actions

`addItem`, `removeItem`, `toggleDone`, `toggleSelect`, `selectAllVisible`, `clearSelection`, `setFilter(patch)`,
`clearFilter`, `deleteSelected`, `markSelectedDone` (see `src/actions.js`).

## View model

`buildViewModel(state)` returns `{ rows, summary, emptyMessage, toolbar }`; the exact rules for the summary line and the
toolbar buttons are documented in `src/viewModel.js`.

Run the tests with `npm test`.
