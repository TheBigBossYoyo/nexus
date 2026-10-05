import { DEFAULT_FILTER } from './state.js'

/** Whether an item is shown under a filter: text is a case-insensitive substring of the title. */
export function isVisible(item, filter) {
  const text = filter.text.trim().toLowerCase()
  if (text !== '' && !item.title.toLowerCase().includes(text)) return false
  if (filter.tag !== null && item.tag !== filter.tag) return false
  if (filter.hideDone && item.done) return false
  return true
}

export function sameFilter(a, b) {
  return a.text === b.text && a.tag === b.tag && a.hideDone === b.hideDone
}

export function isDefaultFilter(filter) {
  return sameFilter(filter, DEFAULT_FILTER)
}
