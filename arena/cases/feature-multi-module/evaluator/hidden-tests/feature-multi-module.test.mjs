import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTask,
  completeTask,
  serializeTasks,
  deserializeTasks,
  FileStore,
  MemoryStore,
  TodoService,
  renderTasks,
  runCommand,
} from '../src/index.js'

const V1 = JSON.stringify({
  version: 1,
  tasks: [
    { id: 't1', title: 'Old one', done: false },
    { id: 't2', title: 'Old two', done: true },
  ],
})

function seeded() {
  const service = new TodoService(new MemoryStore())
  service.add('write report', { priority: 'low', dueDate: '2025-03-10' })
  service.add('plain task')
  service.add('fix outage', { priority: 'high' })
  service.add('pay rent', { priority: 'high', dueDate: '2025-03-01' })
  service.add('book trip', { dueDate: '2025-02-20' })
  service.add('tidy desk', { priority: 'low' })
  return service
}

const titles = (tasks) => tasks.map((t) => t.title)

test('createTask defaults and validation', () => {
  assert.deepEqual(createTask({ id: 't1', title: 'x' }), { id: 't1', title: 'x', done: false, priority: 'normal', dueDate: null })
  const task = createTask({ id: 't1', title: 'x', priority: 'high', dueDate: '2024-02-29' })
  assert.equal(task.priority, 'high')
  assert.equal(task.dueDate, '2024-02-29')
  assert.equal(completeTask(task).priority, 'high')
  assert.equal(completeTask(task).dueDate, '2024-02-29')
  assert.throws(() => createTask({ id: 't1', title: 'x', priority: 'urgent' }), RangeError)
  assert.throws(() => createTask({ id: 't1', title: 'x', priority: null }), RangeError)
  for (const bad of ['2025-02-30', '2023-02-29', '2025-13-01', '2025-1-5', '01/02/2025', 'tomorrow', '', 20250101]) {
    assert.throws(() => createTask({ id: 't1', title: 'x', dueDate: bad }), RangeError, String(bad))
  }
})

test('serialise and deserialise round trip the new fields', () => {
  const tasks = [
    createTask({ id: 't1', title: 'a', priority: 'high', dueDate: '2025-05-01' }),
    createTask({ id: 't2', title: 'b', done: true }),
  ]
  const text = serializeTasks(tasks)
  assert.equal(JSON.parse(text).version, 2)
  assert.deepEqual(deserializeTasks(text), tasks)
})

test('version 1 data still loads with defaults', () => {
  assert.deepEqual(deserializeTasks(V1), [
    { id: 't1', title: 'Old one', done: false, priority: 'normal', dueDate: null },
    { id: 't2', title: 'Old two', done: true, priority: 'normal', dueDate: null },
  ])
  assert.throws(() => deserializeTasks('{"version":3,"tasks":[]}'), RangeError)
})

test('corrupt new fields in stored data are rejected', () => {
  const bad = JSON.stringify({ version: 2, tasks: [{ id: 't1', title: 'x', done: false, priority: 'mega', dueDate: null }] })
  assert.throws(() => deserializeTasks(bad), RangeError)
})

test('an old file upgrades in place when saved by the new code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'todo-hidden-'))
  try {
    const file = join(dir, 'tasks.json')
    writeFileSync(file, V1, 'utf8')
    const service = new TodoService(new FileStore(file))
    assert.deepEqual(titles(service.list()), ['Old one', 'Old two'])
    service.add('new work', { priority: 'high', dueDate: '2025-04-01' })
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2)
    const again = new TodoService(new FileStore(file))
    assert.deepEqual(again.list().map((t) => [t.id, t.priority, t.dueDate]), [
      ['t1', 'normal', null],
      ['t2', 'normal', null],
      ['t3', 'high', '2025-04-01'],
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('service add, setPriority and setDueDate persist', () => {
  const store = new MemoryStore()
  const service = new TodoService(store)
  const task = service.add('a')
  assert.equal(task.priority, 'normal')
  assert.equal(task.dueDate, null)
  assert.equal(service.setPriority('t1', 'high').priority, 'high')
  assert.equal(service.setDueDate('t1', '2025-06-30').dueDate, '2025-06-30')
  service.complete('t1')
  const reloaded = new TodoService(store).list()[0]
  assert.deepEqual(reloaded, { id: 't1', title: 'a', done: true, priority: 'high', dueDate: '2025-06-30' })
  assert.equal(service.setDueDate('t1', null).dueDate, null)
  assert.equal(new TodoService(store).list()[0].dueDate, null)
})

test('invalid input is rejected without changing state', () => {
  const store = new MemoryStore()
  const service = new TodoService(store)
  service.add('keep')
  const before = store.text
  assert.throws(() => service.add('bad', { priority: 'urgent' }), RangeError)
  assert.throws(() => service.add('bad', { dueDate: '2025-02-31' }), RangeError)
  assert.throws(() => service.setPriority('t1', 'urgent'), RangeError)
  assert.throws(() => service.setDueDate('t1', 'soon'), RangeError)
  assert.throws(() => service.setPriority('missing', 'low'), RangeError)
  assert.equal(store.text, before)
  assert.equal(service.list().length, 1)
  assert.equal(service.add('next').id, 't2')
})

test('list filters by priority and dueBefore', () => {
  const service = seeded()
  assert.deepEqual(titles(service.list({ priority: 'high' })), ['fix outage', 'pay rent'])
  assert.deepEqual(titles(service.list({ priority: 'normal' })), ['plain task', 'book trip'])
  assert.deepEqual(titles(service.list({ dueBefore: '2025-03-10' })), ['pay rent', 'book trip'])
  assert.deepEqual(titles(service.list({ dueBefore: '2025-03-11' })), ['write report', 'pay rent', 'book trip'])
  assert.deepEqual(titles(service.list({ dueBefore: '2025-03-11', priority: 'high' })), ['pay rent'])
  service.complete('t4')
  assert.deepEqual(titles(service.list({ dueBefore: '2025-03-11', includeDone: false })), ['write report', 'book trip'])
})

test('list sorts by priority with stable ties', () => {
  const service = seeded()
  assert.deepEqual(titles(service.list({ sortBy: 'priority' })), [
    'fix outage',
    'pay rent',
    'plain task',
    'book trip',
    'write report',
    'tidy desk',
  ])
  assert.deepEqual(titles(service.list({ sortBy: 'created' })), titles(service.list()))
})

test('list sorts by due date with undated tasks last and stable ties', () => {
  const service = seeded()
  service.add('same day as rent', { dueDate: '2025-03-01' })
  assert.deepEqual(titles(service.list({ sortBy: 'due' })), [
    'book trip',
    'pay rent',
    'same day as rent',
    'write report',
    'plain task',
    'fix outage',
    'tidy desk',
  ])
  assert.deepEqual(titles(service.list({ sortBy: 'due', priority: 'low' })), ['write report', 'tidy desk'])
})

test('list rejects invalid options and does not reorder the stored tasks', () => {
  const service = seeded()
  assert.throws(() => service.list({ sortBy: 'name' }), RangeError)
  assert.throws(() => service.list({ priority: 'urgent' }), RangeError)
  assert.throws(() => service.list({ dueBefore: '2025-02-30' }), RangeError)
  service.list({ sortBy: 'priority' })
  assert.deepEqual(titles(service.list()).slice(0, 3), ['write report', 'plain task', 'fix outage'])
})

test('renderTasks shows priority, due date and overdue markers', () => {
  const tasks = [
    createTask({ id: 't1', title: 'Plain' }),
    createTask({ id: 't2', title: 'Urgent', priority: 'high' }),
    createTask({ id: 't3', title: 'Later', priority: 'low', dueDate: '2025-09-01' }),
    createTask({ id: 't4', title: 'Late', dueDate: '2025-01-15' }),
    createTask({ id: 't5', title: 'Late but done', done: true, dueDate: '2025-01-15' }),
    createTask({ id: 't6', title: 'Due today', dueDate: '2025-03-01' }),
  ]
  assert.equal(
    renderTasks(tasks),
    [
      '[ ] t1  Plain',
      '[ ] t2  [high] Urgent',
      '[ ] t3  [low] Later (due 2025-09-01)',
      '[ ] t4  Late (due 2025-01-15)',
      '[x] t5  Late but done (due 2025-01-15)',
      '[ ] t6  Due today (due 2025-03-01)',
    ].join('\n'),
  )
  assert.equal(
    renderTasks(tasks, { today: '2025-03-01' }),
    [
      '[ ] t1  Plain',
      '[ ] t2  [high] Urgent',
      '[ ] t3  [low] Later (due 2025-09-01)',
      '[ ] t4  Late (due 2025-01-15) OVERDUE',
      '[x] t5  Late but done (due 2025-01-15)',
      '[ ] t6  Due today (due 2025-03-01)',
    ].join('\n'),
  )
  assert.equal(renderTasks([]), 'No tasks.')
})

test('renderTasks keeps the old layout for version 1 tasks', () => {
  assert.equal(renderTasks(deserializeTasks(V1)), '[ ] t1  Old one\n[x] t2  Old two')
})

test('command layer accepts the new flags', () => {
  const service = new TodoService(new MemoryStore())
  assert.equal(runCommand(['add', 'Pay', 'rent', '--priority', 'high', '--due', '2025-03-01'], service), 'Added t1')
  assert.equal(runCommand(['add', '--due', '2025-01-10', 'File taxes'], service), 'Added t2')
  assert.equal(runCommand(['add', 'Water plants', '--priority', 'low'], service), 'Added t3')
  assert.deepEqual(service.list().map((t) => [t.title, t.priority, t.dueDate]), [
    ['Pay rent', 'high', '2025-03-01'],
    ['File taxes', 'normal', '2025-01-10'],
    ['Water plants', 'low', null],
  ])
  assert.equal(
    runCommand(['list', '--sort', 'priority'], service),
    ['[ ] t1  [high] Pay rent (due 2025-03-01)', '[ ] t2  File taxes (due 2025-01-10)', '[ ] t3  [low] Water plants'].join('\n'),
  )
  assert.equal(
    runCommand(['list', '--sort', 'due', '--today', '2025-02-01'], service),
    ['[ ] t2  File taxes (due 2025-01-10) OVERDUE', '[ ] t1  [high] Pay rent (due 2025-03-01)', '[ ] t3  [low] Water plants'].join('\n'),
  )
  assert.equal(runCommand(['list', '--priority', 'low'], service), '[ ] t3  [low] Water plants')
  assert.equal(runCommand(['list', '--before', '2025-02-01'], service), '[ ] t2  File taxes (due 2025-01-10)')
  runCommand(['done', 't2'], service)
  assert.equal(runCommand(['list', '--open', '--before', '2025-12-31'], service), '[ ] t1  [high] Pay rent (due 2025-03-01)')
})

test('command layer rejects bad values', () => {
  const service = new TodoService(new MemoryStore())
  assert.throws(() => runCommand(['add', 'x', '--priority', 'urgent'], service), RangeError)
  assert.throws(() => runCommand(['add', 'x', '--due', '2025-02-30'], service), RangeError)
  assert.throws(() => runCommand(['list', '--sort', 'name'], service), RangeError)
  assert.equal(service.list().length, 0)
})
