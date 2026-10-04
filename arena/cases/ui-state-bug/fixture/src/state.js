export const DEFAULT_FILTER = Object.freeze({ text: '', tag: null, hideDone: false })

export function normalizeItem(item) {
  return { id: item.id, title: String(item.title), tag: item.tag ?? null, done: Boolean(item.done) }
}

/** `selection` is a list of item ids; its order is not significant. */
export function createInitialState(items = []) {
  return { items: items.map(normalizeItem), filter: DEFAULT_FILTER, selection: [] }
}
