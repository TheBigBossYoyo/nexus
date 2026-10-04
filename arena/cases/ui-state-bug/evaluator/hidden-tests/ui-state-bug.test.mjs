import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addItem,
  allVisibleSelected,
  buildViewModel,
  clearFilter,
  clearSelection,
  createInitialState,
  createStore,
  deleteSelected,
  markSelectedDone,
  reducer,
  remainingCount,
  removeItem,
  selectAllVisible,
  selectedCount,
  selectedItems,
  setFilter,
  toggleDone,
  toggleSelect,
  visibleItems,
} from '../src/index.js'

const ITEMS = [
  { id: 1, title: 'Buy milk', tag: 'home' },
  { id: 2, title: 'Write report', tag: 'work' },
  { id: 3, title: 'Call mom', tag: 'home', done: true },
  { id: 4, title: 'Fix bug', tag: 'work' },
  { id: 5, title: 'Plan trip', tag: 'home' },
  { id: 6, title: 'Pay rent', tag: 'home', done: true },
]

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

const fresh = () => deepFreeze(createInitialState(ITEMS))
const step = (state, ...actions) => actions.reduce((s, a) => deepFreeze(reducer(s, a)), state)
const sel = (state) => [...state.selection].sort((a, b) => a - b)
const ids = (list) => list.map((i) => i.id)

test('toggleSelect does not mutate the previous state and keeps untouched slices', () => {
  const before = fresh()
  const after = reducer(before, toggleSelect(1))
  assert.deepEqual(before.selection, [])
  assert.deepEqual(sel(after), [1])
  assert.notEqual(after, before)
  assert.notEqual(after.selection, before.selection)
  assert.equal(after.items, before.items)
  assert.equal(after.filter, before.filter)
  const again = reducer(after, toggleSelect(1))
  assert.deepEqual(sel(after), [1])
  assert.deepEqual(again.selection, [])
})

test('toggleDone does not mutate and shares every untouched item, filter and selection', () => {
  const base = step(fresh(), toggleSelect(2))
  const after = reducer(base, toggleDone(1))
  assert.equal(base.items[0].done, false)
  assert.equal(after.items[0].done, true)
  assert.notEqual(after.items, base.items)
  assert.notEqual(after.items[0], base.items[0])
  for (let i = 1; i < ITEMS.length; i++) assert.equal(after.items[i], base.items[i], `item ${i} must be shared`)
  assert.equal(after.filter, base.filter)
  assert.equal(after.selection, base.selection)
  assert.equal(reducer(after, toggleDone(1)).items[0].done, false)
})

test('actions that change nothing return the very same state', () => {
  const base = step(fresh(), toggleSelect(1), setFilter({ tag: 'home' }))
  const cases = [
    ['unknown action', { type: 'nope' }],
    ['removeItem unknown id', removeItem(99)],
    ['toggleDone unknown id', toggleDone(99)],
    ['toggleSelect unknown id', toggleSelect(99)],
    ['toggleSelect hidden item', toggleSelect(2)],
    ['setFilter identical', setFilter({ tag: 'home', text: '', hideDone: false })],
    ['setFilter empty patch', setFilter({})],
    ['addItem duplicate id', addItem({ id: 1, title: 'Again' })],
  ]
  for (const [name, action] of cases) {
    assert.equal(reducer(base, action), base, name)
  }
  const empty = fresh()
  assert.equal(reducer(empty, clearSelection()), empty, 'clearSelection with nothing selected')
  assert.equal(reducer(empty, clearFilter()), empty, 'clearFilter at the default filter')
  assert.equal(reducer(empty, deleteSelected()), empty, 'deleteSelected with nothing selected')
  assert.equal(reducer(empty, markSelectedDone()), empty, 'markSelectedDone with nothing selected')
  const all = step(empty, selectAllVisible())
  assert.equal(reducer(all, selectAllVisible()), all, 'selectAllVisible twice')
  const doneOnly = step(empty, toggleSelect(3), toggleSelect(6))
  assert.equal(reducer(doneOnly, markSelectedDone()), doneOnly, 'markSelectedDone on done items only')
  const nothingVisible = step(empty, setFilter({ text: 'zzz' }))
  assert.equal(reducer(nothingVisible, selectAllVisible()), nothingVisible, 'selectAllVisible with nothing visible')
})

test('removeItem and deleteSelected leave no stale ids in the selection', () => {
  let state = step(fresh(), toggleSelect(1), toggleSelect(2), toggleSelect(4))
  state = step(state, removeItem(1))
  assert.deepEqual(sel(state), [2, 4])
  assert.equal(selectedCount(state), 2)
  assert.equal(buildViewModel(state).summary, '5 of 5 shown, 3 left, 2 selected')
  const deleted = step(state, deleteSelected())
  assert.deepEqual(ids(deleted.items), [3, 5, 6])
  assert.deepEqual(deleted.selection, [])
  assert.equal(deleted.items[0], state.items.find((i) => i.id === 3))
  assert.equal(deleted.filter, state.filter)
})

test('changing the filter drops hidden items from the selection for good', () => {
  let state = step(fresh(), toggleSelect(1), toggleSelect(2), toggleSelect(3))
  state = step(state, setFilter({ tag: 'work' }))
  assert.deepEqual(sel(state), [2])
  assert.deepEqual(ids(selectedItems(state)), [2])
  assert.equal(buildViewModel(state).summary, '2 of 6 shown, 4 left, 1 selected')
  state = step(state, clearFilter())
  assert.deepEqual(sel(state), [2], 'hidden items are not selected again when the filter is cleared')
  // a hidden item cannot be selected
  const filtered = step(fresh(), setFilter({ text: 'milk' }))
  assert.equal(reducer(filtered, toggleSelect(2)), filtered)
})

test('hideDone: finishing a selected item or marking the selection done removes it from the selection', () => {
  const base = step(fresh(), setFilter({ hideDone: true }), toggleSelect(1), toggleSelect(2))
  assert.deepEqual(sel(base), [1, 2])
  const toggled = step(base, toggleDone(1))
  assert.deepEqual(sel(toggled), [2])
  const marked = step(base, markSelectedDone())
  assert.deepEqual(marked.selection, [])
  assert.equal(marked.items[0].done && marked.items[1].done, true)
  assert.equal(marked.items[3], base.items[3])
  // without hideDone the selection stays
  const plain = step(fresh(), toggleSelect(1), markSelectedDone())
  assert.deepEqual(sel(plain), [1])
})

test('selectAllVisible selects exactly the visible items', () => {
  const state = step(fresh(), setFilter({ tag: 'work' }), selectAllVisible())
  assert.deepEqual(sel(state), [2, 4])
  assert.equal(allVisibleSelected(state), true)
  assert.equal(buildViewModel(state).toolbar.selectAll.checked, true)
  const partial = step(fresh(), setFilter({ tag: 'home' }), toggleSelect(1), selectAllVisible())
  assert.deepEqual(sel(partial), [1, 3, 5, 6])
  // select-all, then widen the filter: not everything is selected any more
  const widened = step(state, clearFilter())
  assert.equal(allVisibleSelected(widened), false)
  assert.equal(buildViewModel(widened).toolbar.selectAll.indeterminate, true)
})

test('footer counts use the whole list while a filter is active', () => {
  let state = fresh()
  assert.equal(remainingCount(state), 4)
  state = step(state, setFilter({ tag: 'work' }))
  assert.equal(remainingCount(state), 4)
  assert.equal(buildViewModel(state).summary, '2 of 6 shown, 4 left, 0 selected')
  state = step(state, setFilter({ tag: 'home', hideDone: true }))
  assert.equal(buildViewModel(state).summary, '2 of 6 shown, 4 left, 0 selected')
  state = step(state, toggleDone(2))
  assert.equal(buildViewModel(state).summary, '2 of 6 shown, 3 left, 0 selected')
  assert.deepEqual(visibleItems(state).map((i) => i.id), [1, 5])
})

test('delete button, labels and select-all at the 0 / 1 / many boundaries', () => {
  const none = buildViewModel(fresh()).toolbar
  assert.deepEqual(none.deleteSelected, { disabled: true, label: 'Delete selected' })
  assert.deepEqual(none.markDone, { disabled: true, label: 'Mark as done' })
  assert.deepEqual(none.selectAll, { checked: false, indeterminate: false, disabled: false })

  const one = buildViewModel(step(fresh(), toggleSelect(1))).toolbar
  assert.deepEqual(one.deleteSelected, { disabled: false, label: 'Delete 1 item' })
  assert.deepEqual(one.markDone, { disabled: false, label: 'Mark 1 as done' })
  assert.deepEqual(one.selectAll, { checked: false, indeterminate: true, disabled: false })

  const two = buildViewModel(step(fresh(), toggleSelect(1), toggleSelect(2))).toolbar
  assert.deepEqual(two.deleteSelected, { disabled: false, label: 'Delete 2 items' })
  assert.equal(two.markDone.label, 'Mark 2 as done')

  // mark-done counts only the selected items that are not done yet
  const mixed = buildViewModel(step(fresh(), toggleSelect(1), toggleSelect(3), toggleSelect(6))).toolbar
  assert.deepEqual(mixed.markDone, { disabled: false, label: 'Mark 1 as done' })
  assert.deepEqual(mixed.deleteSelected, { disabled: false, label: 'Delete 3 items' })
  const doneOnly = buildViewModel(step(fresh(), toggleSelect(3), toggleSelect(6))).toolbar
  assert.deepEqual(doneOnly.markDone, { disabled: true, label: 'Mark as done' })

  const all = buildViewModel(step(fresh(), selectAllVisible())).toolbar
  assert.deepEqual(all.selectAll, { checked: true, indeterminate: false, disabled: false })
  assert.equal(all.deleteSelected.label, 'Delete 6 items')
})

test('view model for filtered and empty lists', () => {
  const empty = buildViewModel(createInitialState())
  assert.equal(empty.emptyMessage, 'Nothing to do yet')
  assert.deepEqual(empty.rows, [])
  assert.deepEqual(empty.toolbar.selectAll, { checked: false, indeterminate: false, disabled: true })
  assert.equal(empty.summary, '0 of 0 shown, 0 left, 0 selected')

  const none = buildViewModel(step(fresh(), setFilter({ text: 'zzz' })))
  assert.equal(none.emptyMessage, 'No items match the filter')
  assert.deepEqual(none.toolbar.selectAll, { checked: false, indeterminate: false, disabled: true })
  assert.equal(none.toolbar.clearFilter.disabled, false)

  const shown = buildViewModel(step(fresh(), setFilter({ tag: 'work' }), toggleSelect(4)))
  assert.deepEqual(
    shown.rows,
    [
      { id: 2, title: 'Write report', tag: 'work', done: false, selected: false, label: 'Write report' },
      { id: 4, title: 'Fix bug', tag: 'work', done: false, selected: true, label: 'Fix bug' },
    ],
  )
  assert.equal(shown.emptyMessage, null)
  assert.equal(shown.toolbar.clearFilter.disabled, false)
  assert.equal(buildViewModel(fresh()).toolbar.clearFilter.disabled, true)
})

test('store notifies listeners only when the state object changed', () => {
  const store = createStore(reducer, fresh())
  const calls = []
  const off = store.subscribe((state, previous) => calls.push([state, previous]))
  const initial = store.getState()
  store.dispatch(clearSelection())
  store.dispatch(toggleDone(99))
  store.dispatch({ type: 'unknown' })
  assert.equal(calls.length, 0)
  assert.equal(store.getState(), initial)
  store.dispatch(toggleSelect(1))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], initial)
  assert.equal(calls[0][0], store.getState())
  off()
  store.dispatch(toggleSelect(2))
  assert.equal(calls.length, 1)
})

// ---------- model-based test over deterministic random action sequences ----------
function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const visibleModel = (m) => {
  const text = m.filter.text.trim().toLowerCase()
  return m.items.filter(
    (i) => (text === '' || i.title.toLowerCase().includes(text)) && (m.filter.tag === null || i.tag === m.filter.tag) && !(m.filter.hideDone && i.done),
  )
}

function applyModel(m, a) {
  const next = { items: m.items.map((i) => ({ ...i })), filter: { ...m.filter }, selection: new Set(m.selection) }
  switch (a.type) {
    case 'add':
      if (!next.items.some((i) => i.id === a.item.id)) next.items.push({ id: a.item.id, title: a.item.title, tag: a.item.tag ?? null, done: Boolean(a.item.done) })
      break
    case 'remove':
      next.items = next.items.filter((i) => i.id !== a.id)
      break
    case 'done': {
      const it = next.items.find((i) => i.id === a.id)
      if (it) it.done = !it.done
      break
    }
    case 'select':
      if (visibleModel(next).some((i) => i.id === a.id)) {
        if (next.selection.has(a.id)) next.selection.delete(a.id)
        else next.selection.add(a.id)
      }
      break
    case 'selectAll':
      next.selection = new Set(visibleModel(next).map((i) => i.id))
      break
    case 'clearSel':
      next.selection = new Set()
      break
    case 'filter':
      Object.assign(next.filter, a.patch)
      break
    case 'clearFilter':
      next.filter = { text: '', tag: null, hideDone: false }
      break
    case 'delete':
      next.items = next.items.filter((i) => !next.selection.has(i.id))
      next.selection = new Set()
      break
    case 'markDone':
      for (const i of next.items) if (next.selection.has(i.id)) i.done = true
      break
  }
  const vis = new Set(visibleModel(next).map((i) => i.id))
  next.selection = new Set([...next.selection].filter((id) => vis.has(id)))
  return next
}

const toAction = (a) => {
  switch (a.type) {
    case 'add': return addItem(a.item)
    case 'remove': return removeItem(a.id)
    case 'done': return toggleDone(a.id)
    case 'select': return toggleSelect(a.id)
    case 'selectAll': return selectAllVisible()
    case 'clearSel': return clearSelection()
    case 'filter': return setFilter(a.patch)
    case 'clearFilter': return clearFilter()
    case 'delete': return deleteSelected()
    case 'markDone': return markSelectedDone()
  }
}

test('random action sequences agree with an independent model, stay pure and keep identity', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = lcg(seed * 7919)
    const pick = (list) => list[Math.floor(r() * list.length)]
    let nextId = 100
    let model = { items: ITEMS.map((i) => ({ id: i.id, title: i.title, tag: i.tag, done: Boolean(i.done) })), filter: { text: '', tag: null, hideDone: false }, selection: new Set() }
    let state = fresh()
    for (let n = 0; n < 250; n++) {
      const roll = r()
      const anyId = () => (model.items.length && r() < 0.9 ? pick(model.items).id : 999)
      let a
      if (roll < 0.1) a = { type: 'add', item: { id: r() < 0.2 ? 1 : nextId++, title: pick(['Buy bread', 'Pay bill', 'Call dad', 'Mow lawn']), tag: pick(['home', 'work', null]), done: r() < 0.3 } }
      else if (roll < 0.17) a = { type: 'remove', id: anyId() }
      else if (roll < 0.3) a = { type: 'done', id: anyId() }
      else if (roll < 0.5) a = { type: 'select', id: anyId() }
      else if (roll < 0.56) a = { type: 'selectAll' }
      else if (roll < 0.6) a = { type: 'clearSel' }
      else if (roll < 0.78) {
        const patch = pick([{ tag: pick(['home', 'work', null]) }, { text: pick(['', 'a', 'pay', 'zzz', 'CALL']) }, { hideDone: r() < 0.5 }, {}])
        a = { type: 'filter', patch }
      } else if (roll < 0.83) a = { type: 'clearFilter' }
      else if (roll < 0.9) a = { type: 'delete' }
      else a = { type: 'markDone' }

      const snapshot = JSON.stringify(state)
      const prev = state
      const nextModel = applyModel(model, a)
      state = deepFreeze(reducer(prev, toAction(a)))
      assert.equal(JSON.stringify(prev), snapshot, `previous state mutated by ${a.type} (seed ${seed}, step ${n})`)

      const label = `${a.type} seed ${seed} step ${n}`
      assert.deepEqual(state.items, nextModel.items, `items after ${label}`)
      assert.deepEqual(state.filter, nextModel.filter, `filter after ${label}`)
      assert.deepEqual(sel(state), [...nextModel.selection].sort((x, y) => x - y), `selection after ${label}`)
      assert.equal(new Set(state.selection).size, state.selection.length, `duplicate selection ids after ${label}`)

      const itemsSame = JSON.stringify(prev.items) === JSON.stringify(state.items)
      const filterSame = JSON.stringify(prev.filter) === JSON.stringify(state.filter)
      const selSame = JSON.stringify([...prev.selection].sort()) === JSON.stringify([...state.selection].sort())
      if (itemsSame) assert.equal(state.items, prev.items, `items identity after ${label}`)
      if (filterSame) assert.equal(state.filter, prev.filter, `filter identity after ${label}`)
      if (selSame) assert.equal(state.selection, prev.selection, `selection identity after ${label}`)
      if (itemsSame && filterSame && selSame) assert.equal(state, prev, `no-op identity after ${label}`)
      else assert.notEqual(state, prev, `a change must produce a new state after ${label}`)
      if (!itemsSame) {
        const before = new Map(prev.items.map((i) => [i.id, i]))
        for (const item of state.items) {
          const old = before.get(item.id)
          if (old && JSON.stringify(old) === JSON.stringify(item)) assert.equal(item, old, `unchanged item ${item.id} must keep identity after ${label}`)
        }
      }

      const vm = buildViewModel(state)
      const vis = visibleModel(nextModel)
      assert.deepEqual(vm.rows.map((row) => row.id), vis.map((i) => i.id))
      assert.equal(vm.summary, `${vis.length} of ${nextModel.items.length} shown, ${nextModel.items.filter((i) => !i.done).length} left, ${nextModel.selection.size} selected`)
      assert.equal(vm.toolbar.deleteSelected.disabled, nextModel.selection.size === 0)
      const everySelected = vis.length > 0 && vis.every((i) => nextModel.selection.has(i.id))
      assert.equal(vm.toolbar.selectAll.checked, everySelected)
      assert.equal(vm.toolbar.selectAll.indeterminate, nextModel.selection.size > 0 && !everySelected)
      model = nextModel
    }
  }
})
