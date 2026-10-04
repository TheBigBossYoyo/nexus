import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addItem,
  buildViewModel,
  clearFilter,
  clearSelection,
  createInitialState,
  createStore,
  deleteSelected,
  markSelectedDone,
  reducer,
  removeItem,
  selectAllVisible,
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
]

const start = () => createInitialState(ITEMS)
const run = (state, ...actions) => actions.reduce(reducer, state)

test('initial state normalises items', () => {
  const state = start()
  assert.equal(state.items.length, 4)
  assert.equal(state.items[0].done, false)
  assert.deepEqual(state.selection, [])
})

test('addItem appends and ignores duplicate ids', () => {
  let state = run(start(), addItem({ id: 5, title: 'Plan trip' }))
  assert.equal(state.items.length, 5)
  assert.equal(state.items[4].tag, null)
  state = run(state, addItem({ id: 5, title: 'Other' }))
  assert.equal(state.items.length, 5)
})

test('toggleDone flips the flag', () => {
  const state = run(start(), toggleDone(1))
  assert.equal(state.items[0].done, true)
  assert.equal(run(state, toggleDone(1)).items[0].done, false)
})

test('filters combine', () => {
  let state = run(start(), setFilter({ tag: 'home' }))
  assert.deepEqual(visibleItems(state).map((i) => i.id), [1, 3])
  state = run(state, setFilter({ hideDone: true }))
  assert.deepEqual(visibleItems(state).map((i) => i.id), [1])
  state = run(state, setFilter({ text: 'MILK' }))
  assert.deepEqual(visibleItems(state).map((i) => i.id), [1])
  assert.deepEqual(visibleItems(run(state, clearFilter())).map((i) => i.id), [1, 2, 3, 4])
})

test('selection actions', () => {
  let state = run(start(), toggleSelect(2), toggleSelect(4))
  assert.deepEqual([...state.selection].sort(), [2, 4])
  state = run(state, toggleSelect(2))
  assert.deepEqual(state.selection, [4])
  state = run(state, clearSelection())
  assert.deepEqual(state.selection, [])
  assert.equal(run(start(), selectAllVisible()).selection.length, 4)
})

test('deleteSelected and markSelectedDone work on the selection', () => {
  const selected = run(start(), toggleSelect(1), toggleSelect(2))
  assert.deepEqual(run(selected, markSelectedDone()).items.map((i) => i.done), [true, true, true, false])
  assert.deepEqual(run(selected, deleteSelected()).items.map((i) => i.id), [3, 4])
})

test('removeItem drops the item', () => {
  assert.deepEqual(run(start(), removeItem(2)).items.map((i) => i.id), [1, 3, 4])
})

test('view model summary and rows', () => {
  const vm = buildViewModel(run(start(), toggleSelect(1)))
  assert.equal(vm.summary, '4 of 4 shown, 3 left, 1 selected')
  assert.equal(vm.rows.length, 4)
  assert.equal(vm.rows[0].selected, true)
  assert.equal(vm.rows[2].label, 'Call mom (done)')
  assert.equal(vm.emptyMessage, null)
})

test('view model toolbar for no selection and a larger selection', () => {
  const none = buildViewModel(start()).toolbar
  assert.equal(none.deleteSelected.disabled, true)
  assert.equal(none.deleteSelected.label, 'Delete selected')
  assert.equal(none.markDone.disabled, true)
  assert.equal(none.clearFilter.disabled, true)
  const three = buildViewModel(run(start(), toggleSelect(1), toggleSelect(2), toggleSelect(4))).toolbar
  assert.equal(three.deleteSelected.disabled, false)
  assert.equal(three.deleteSelected.label, 'Delete 3 items')
  assert.equal(three.selectAll.indeterminate, true)
})

test('empty messages', () => {
  assert.equal(buildViewModel(createInitialState()).emptyMessage, 'Nothing to do yet')
  assert.equal(buildViewModel(run(start(), setFilter({ text: 'zzz' }))).emptyMessage, 'No items match the filter')
})

test('store dispatches and notifies', () => {
  const store = createStore(reducer, start())
  const seen = []
  const off = store.subscribe((state) => seen.push(state.selection.length))
  store.dispatch(toggleSelect(1))
  off()
  store.dispatch(toggleSelect(2))
  assert.deepEqual(seen, [1])
  assert.equal(store.getState().selection.length, 2)
})
