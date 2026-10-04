import * as A from './actions.js'
import { createInitialState, normalizeItem, DEFAULT_FILTER } from './state.js'
import { isDefaultFilter, isVisible, sameFilter } from './filter.js'

function visibleIds(state) {
  return state.items.filter((item) => isVisible(item, state.filter)).map((item) => item.id)
}

/** Enforce "the selection only contains existing, visible items" without disturbing identity. */
function pruneSelection(state) {
  if (state.selection.length === 0) return state
  const visible = new Set(visibleIds(state))
  const kept = state.selection.filter((id) => visible.has(id))
  return kept.length === state.selection.length ? state : { ...state, selection: kept }
}

function apply(state, action) {
  switch (action.type) {
    case A.ADD_ITEM: {
      if (state.items.some((item) => item.id === action.item.id)) return state
      return { ...state, items: [...state.items, normalizeItem(action.item)] }
    }
    case A.REMOVE_ITEM: {
      if (!state.items.some((item) => item.id === action.id)) return state
      return { ...state, items: state.items.filter((item) => item.id !== action.id) }
    }
    case A.TOGGLE_DONE: {
      if (!state.items.some((item) => item.id === action.id)) return state
      return { ...state, items: state.items.map((item) => (item.id === action.id ? { ...item, done: !item.done } : item)) }
    }
    case A.TOGGLE_SELECT: {
      if (!visibleIds(state).includes(action.id)) return state
      const selection = state.selection.includes(action.id)
        ? state.selection.filter((id) => id !== action.id)
        : [...state.selection, action.id]
      return { ...state, selection }
    }
    case A.SELECT_ALL_VISIBLE: {
      const ids = visibleIds(state)
      const current = new Set(state.selection)
      if (ids.length === current.size && ids.every((id) => current.has(id))) return state
      return { ...state, selection: ids }
    }
    case A.CLEAR_SELECTION:
      return state.selection.length === 0 ? state : { ...state, selection: [] }
    case A.SET_FILTER: {
      const patch = action.patch ?? {}
      const next = { ...state.filter }
      for (const key of ['text', 'tag', 'hideDone']) if (key in patch) next[key] = patch[key]
      return sameFilter(next, state.filter) ? state : { ...state, filter: next }
    }
    case A.CLEAR_FILTER:
      return isDefaultFilter(state.filter) ? state : { ...state, filter: DEFAULT_FILTER }
    case A.DELETE_SELECTED: {
      if (state.selection.length === 0) return state
      const doomed = new Set(state.selection)
      return { ...state, items: state.items.filter((item) => !doomed.has(item.id)), selection: [] }
    }
    case A.MARK_SELECTED_DONE: {
      const chosen = new Set(state.selection)
      if (!state.items.some((item) => chosen.has(item.id) && !item.done)) return state
      return { ...state, items: state.items.map((item) => (chosen.has(item.id) && !item.done ? { ...item, done: true } : item)) }
    }
    default:
      return state
  }
}

export function reducer(state = createInitialState(), action) {
  return pruneSelection(apply(state, action))
}
