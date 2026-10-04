import * as A from './actions.js'
import { createInitialState, normalizeItem, DEFAULT_FILTER } from './state.js'

export function reducer(state = createInitialState(), action) {
  switch (action.type) {
    case A.ADD_ITEM: {
      if (state.items.some((item) => item.id === action.item.id)) return { ...state }
      return { ...state, items: [...state.items, normalizeItem(action.item)] }
    }
    case A.REMOVE_ITEM:
      return { ...state, items: state.items.filter((item) => item.id !== action.id) }
    case A.TOGGLE_DONE: {
      const item = state.items.find((candidate) => candidate.id === action.id)
      if (item) item.done = !item.done
      return { ...state, items: [...state.items] }
    }
    case A.TOGGLE_SELECT: {
      const at = state.selection.indexOf(action.id)
      if (at >= 0) state.selection.splice(at, 1)
      else state.selection.push(action.id)
      return { ...state }
    }
    case A.SELECT_ALL_VISIBLE:
      return { ...state, selection: state.items.map((item) => item.id) }
    case A.CLEAR_SELECTION:
      return { ...state, selection: [] }
    case A.SET_FILTER:
      return { ...state, filter: { ...state.filter, ...action.patch } }
    case A.CLEAR_FILTER:
      return { ...state, filter: DEFAULT_FILTER }
    case A.DELETE_SELECTED:
      return { ...state, items: state.items.filter((item) => !state.selection.includes(item.id)) }
    case A.MARK_SELECTED_DONE:
      return {
        ...state,
        items: state.items.map((item) => (state.selection.includes(item.id) ? { ...item, done: true } : item)),
      }
    default:
      return state
  }
}
