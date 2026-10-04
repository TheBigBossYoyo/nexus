import { isVisible } from './filter.js'

export function visibleItems(state) {
  return state.items.filter((item) => isVisible(item, state.filter))
}

/** Selected items, in list order. */
export function selectedItems(state) {
  return state.items.filter((item) => state.selection.includes(item.id))
}

export function selectedCount(state) {
  return state.selection.length
}

/** Items that are not done yet, across the whole list (the filter does not matter). */
export function remainingCount(state) {
  return visibleItems(state).filter((item) => !item.done).length
}

/** True when there is at least one visible item and every visible item is selected. */
export function allVisibleSelected(state) {
  const visible = visibleItems(state)
  return visible.length > 0 && visible.every((item) => state.selection.includes(item.id))
}
