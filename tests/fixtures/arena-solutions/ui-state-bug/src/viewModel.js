import { isDefaultFilter } from './filter.js'
import { pluralize } from './format.js'
import { allVisibleSelected, remainingCount, selectedCount, selectedItems, visibleItems } from './selectors.js'

/**
 * Everything the panel needs to render, as plain data.
 *
 * summary:   "<visible> of <total> shown, <remaining> left, <selected> selected"
 * toolbar.selectAll:      checked when every visible item is selected, indeterminate when only some are,
 *                         disabled when nothing is visible
 * toolbar.deleteSelected: disabled without a selection; label "Delete selected", "Delete 1 item", "Delete 3 items"
 * toolbar.markDone:       disabled unless a selected item is not done yet; label "Mark as done" or "Mark <n> as done"
 *                         where n counts the selected items that are not done yet
 * toolbar.clearFilter:    disabled while the filter is the default one
 */
export function buildViewModel(state) {
  const visible = visibleItems(state)
  const selectedIds = new Set(state.selection)
  const selected = selectedCount(state)
  const pending = selectedItems(state).filter((item) => !item.done).length
  const allSelected = allVisibleSelected(state)

  let emptyMessage = null
  if (state.items.length === 0) emptyMessage = 'Nothing to do yet'
  else if (visible.length === 0) emptyMessage = 'No items match the filter'

  return {
    rows: visible.map((item) => ({
      id: item.id,
      title: item.title,
      tag: item.tag,
      done: item.done,
      selected: selectedIds.has(item.id),
      label: item.done ? `${item.title} (done)` : item.title,
    })),
    summary: `${visible.length} of ${state.items.length} shown, ${remainingCount(state)} left, ${selected} selected`,
    emptyMessage,
    toolbar: {
      selectAll: { checked: allSelected, indeterminate: selected > 0 && !allSelected, disabled: visible.length === 0 },
      deleteSelected: {
        disabled: selected === 0,
        label: selected === 0 ? 'Delete selected' : `Delete ${selected} ${pluralize(selected, 'item')}`,
      },
      markDone: {
        disabled: pending === 0,
        label: pending === 0 ? 'Mark as done' : `Mark ${pending} as done`,
      },
      clearFilter: { disabled: isDefaultFilter(state.filter) },
    },
  }
}
