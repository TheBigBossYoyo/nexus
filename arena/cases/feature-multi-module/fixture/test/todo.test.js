import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  parseArgs,
  nextId,
} from '../src/index.js'

test('createTask validates and trims', () => {
  const task = createTask({ id: 't1', title: '  Buy milk ' })
  assert.equal(task.id, 't1')
  assert.equal(task.title, 'Buy milk')
  assert.equal(task.done, false)
  assert.throws(() => createTask({ id: 't1', title: '   ' }), RangeError)
  assert.throws(() => createTask({ id: '', title: 'x' }), TypeError)
  assert.equal(completeTask(createTask({ id: 't1', title: 'x' })).done, true)
})

test('storage round trips tasks and loads old version 1 files', () => {
  const tasks = [createTask({ id: 't1', title: 'a' }), createTask({ id: 't2', title: 'b', done: true })]
  const text = serializeTasks(tasks)
  assert.equal(typeof JSON.parse(text).version, 'number')
  const legacy = '{"version":1,"tasks":[{"id":"t1","title":"a","done":false},{"id":"t2","title":"b","done":true}]}'
  assert.deepEqual(deserializeTasks(legacy).map((t) => t.title), ['a', 'b'])
  assert.deepEqual(deserializeTasks(text), tasks)
  assert.deepEqual(deserializeTasks(''), [])
  assert.throws(() => deserializeTasks('{"version":9,"tasks":[]}'), RangeError)
})

test('nextId skips used ids', () => {
  assert.equal(nextId([]), 't1')
  assert.equal(nextId([{ id: 't4' }, { id: 'custom' }]), 't5')
})

test('service adds, completes, removes and persists', () => {
  const store = new MemoryStore()
  const service = new TodoService(store)
  const a = service.add('first')
  service.add('second')
  service.complete(a.id)
  service.remove('t2')
  assert.deepEqual(service.list().map((t) => [t.id, t.done]), [['t1', true]])
  const reloaded = new TodoService(store)
  assert.deepEqual(reloaded.list(), service.list())
  assert.throws(() => service.complete('nope'), RangeError)
  assert.deepEqual(service.list({ includeDone: false }), [])
})

test('FileStore persists to disk and treats a missing file as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'todo-'))
  try {
    const file = join(dir, 'nested', 'tasks.json')
    const store = new FileStore(file)
    assert.deepEqual(store.load(), [])
    const service = new TodoService(store)
    service.add('persist me')
    assert.match(readFileSync(file, 'utf8'), /persist me/)
    assert.deepEqual(new TodoService(new FileStore(file)).list().map((t) => t.title), ['persist me'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderTasks formats lines', () => {
  assert.equal(renderTasks([]), 'No tasks.')
  const text = renderTasks([createTask({ id: 't1', title: 'Buy milk' }), createTask({ id: 't2', title: 'Pay rent', done: true })])
  assert.equal(text, '[ ] t1  Buy milk\n[x] t2  Pay rent')
})

test('parseArgs handles flags', () => {
  assert.deepEqual(parseArgs(['a', '--x', '1', 'b', '--open'], { booleans: ['open'] }), {
    positionals: ['a', 'b'],
    flags: { x: '1', open: true },
  })
  assert.throws(() => parseArgs(['--x']), TypeError)
})

test('runCommand drives the service', () => {
  const service = new TodoService(new MemoryStore())
  assert.equal(runCommand(['add', 'Buy', 'milk'], service), 'Added t1')
  assert.equal(runCommand(['add', 'Pay rent'], service), 'Added t2')
  assert.equal(runCommand(['done', 't1'], service), 'Completed t1')
  assert.equal(runCommand(['list', '--open'], service), '[ ] t2  Pay rent')
  assert.equal(runCommand(['list'], service), '[x] t1  Buy milk\n[ ] t2  Pay rent')
  assert.throws(() => runCommand(['wat'], service), RangeError)
})
