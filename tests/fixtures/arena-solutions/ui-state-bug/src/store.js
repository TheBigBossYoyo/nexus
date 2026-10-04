import { createInitialState } from './state.js'

/**
 * A minimal store. Listeners are called with (state, previousState) after every dispatch that
 * produced a different state object.
 */
export function createStore(reducer, initialState = createInitialState()) {
  let state = initialState
  const listeners = new Set()
  return {
    getState: () => state,
    dispatch(action) {
      const previous = state
      state = reducer(state, action)
      if (state !== previous) for (const listener of [...listeners]) listener(state, previous)
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
