import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { openStore, StoreError } from '../src/index.js'

// ---------- helpers ----------
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kvlog-hidden-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const journalOf = (dir) => join(dir, 'journal.log')
const snapshotOf = (dir) => join(dir, 'snapshot.json')
const lockOf = (dir) => join(dir, 'LOCK')

/** Open, read everything, close. */
function dump(dir) {
  const store = openStore(dir)
  try {
    const out = {}
    for (const key of store.keys()) out[key] = store.get(key)
    return out
  } finally {
    store.close()
  }
}

/** A copy of the data directory as the disk looks after a crash (the dead process's lock excluded). */
function crashCopy(t, dir, { journal } = {}) {
  const copy = mkdtempSync(join(tmpdir(), 'kvlog-crash-'))
  t.after(() => rmSync(copy, { recursive: true, force: true }))
  cpSync(dir, copy, { recursive: true, filter: (p) => basename(p) !== 'LOCK' })
  if (journal !== undefined) writeFileSync(journalOf(copy), journal)
  return copy
}

function expectCode(code) {
  return (error) => error instanceof StoreError && error.code === code
}

function findDeadPid() {
  const child = spawnSync(process.execPath, ['-e', '0'])
  const candidates = [child.pid, 2147483000, 2147482000, 999999999]
  for (const pid of candidates) {
    if (!pid) continue
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return pid
    }
  }
  throw new Error('could not find a dead pid')
}

/** An fs wrapper that delegates to node:fs and can be armed to fail or tear writes. */
function makeFaultFs() {
  const state = { mode: null }
  const fdPaths = new Map()
  const eio = () => Object.assign(new Error('injected I/O failure'), { code: 'EIO' })
  const isTmpSnapshot = (name) => name.startsWith('snapshot') && name !== 'snapshot.json'

  function hit(path) {
    const name = basename(String(path))
    switch (state.mode) {
      case 'tear-snapshot':
        return name === 'snapshot.json' ? 'tear' : null
      case 'tear-snapshot-tmp':
        return isTmpSnapshot(name) ? 'tear' : null
      case 'tear-journal':
        return name === 'journal.log' ? 'tear' : null
      case 'fail-journal':
        return name === 'journal.log' ? 'fail' : null
      default:
        return null
    }
  }
  const asBuffer = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
  function inject(path, data, writeHalf) {
    const kind = hit(path)
    if (!kind) return
    if (kind === 'tear') {
      const buf = asBuffer(data)
      if (buf.length > 0) writeHalf(buf.subarray(0, Math.max(1, Math.floor(buf.length / 2))))
    }
    throw eio()
  }
  const isAppendFlag = (options) => {
    const flag = typeof options === 'object' && options ? options.flag : undefined
    return typeof flag === 'string' && flag.startsWith('a')
  }

  const overrides = {
    writeFileSync(path, data, options) {
      const journal = basename(String(path)) === 'journal.log'
      if (!journal || isAppendFlag(options)) inject(path, data, (half) => realFs.writeFileSync(path, half, options))
      return realFs.writeFileSync(path, data, options)
    },
    appendFileSync(path, data, options) {
      inject(path, data, (half) => realFs.appendFileSync(path, half, options))
      return realFs.appendFileSync(path, data, options)
    },
    openSync(path, flags, mode) {
      const fd = realFs.openSync(path, flags, mode)
      fdPaths.set(fd, path)
      return fd
    },
    closeSync(fd) {
      fdPaths.delete(fd)
      return realFs.closeSync(fd)
    },
    writeSync(fd, data, ...rest) {
      const path = fdPaths.get(fd)
      if (path && typeof data !== 'string' && data.length > 0) inject(path, data, (half) => realFs.writeSync(fd, half))
      return realFs.writeSync(fd, data, ...rest)
    },
    renameSync(from, to) {
      if (state.mode === 'fail-rename' && basename(String(to)) === 'snapshot.json') throw eio()
      return realFs.renameSync(from, to)
    },
  }
  const fs = new Proxy(realFs, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key]
      const value = target[key]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    fs,
    arm(mode) {
      state.mode = mode
    },
    disarm() {
      state.mode = null
    },
  }
}

// ---------- torn journal tail ----------
function buildJournalFixture(dir) {
  const store = openStore(dir)
  store.set('a', 1)
  store.set('b', { x: [1, 2] })
  store.incr('n', 5)
  store.incr('n', 2)
  store.set('c', 'last')
  store.close()
  return readFileSync(journalOf(dir))
}

const WITHOUT_LAST = { a: 1, b: { x: [1, 2] }, n: 7 }
const WITH_LAST = { ...WITHOUT_LAST, c: 'last' }

const TEAR_CASES = [
  ['newline and two payload bytes cut', (buf) => buf.subarray(0, buf.length - 3), WITHOUT_LAST],
  ['half of the last record', (buf) => buf.subarray(0, buf.lastIndexOf('\n', buf.length - 2) + 1 + 20), WITHOUT_LAST],
  ['only the checksum of the last record', (buf) => buf.subarray(0, buf.lastIndexOf('\n', buf.length - 2) + 1 + 5), WITHOUT_LAST],
  ['garbage appended without newline', (buf) => Buffer.concat([buf, Buffer.from('dead')]), WITH_LAST],
  ['zero-filled tail', (buf) => Buffer.concat([buf, Buffer.alloc(32)]), WITH_LAST],
  ['garbage line with newline', (buf) => Buffer.concat([buf, Buffer.from('garbage that is no record\n')]), WITH_LAST],
  ['well-formed line with a wrong checksum', (buf) => Buffer.concat([buf, Buffer.from('00000000 {"seq":99,"op":"set","key":"x","value":1}\n')]), WITH_LAST],
]

for (const [name, tear, expected] of TEAR_CASES) {
  test(`torn tail (${name}) is discarded, removed from the file, and later writes survive`, (t) => {
    const dir = tempDir(t)
    const intact = buildJournalFixture(dir)
    writeFileSync(journalOf(dir), tear(intact))

    assert.deepEqual(dump(dir), expected)

    const store = openStore(dir)
    store.set('after', { ok: true })
    assert.equal(store.incr('n', 10), expected.n + 10)
    store.close()

    assert.deepEqual(dump(dir), { ...expected, after: { ok: true }, n: expected.n + 10 })
    // and once more, to be sure nothing was glued onto leftover bytes
    const again = openStore(dir)
    again.set('third', 3)
    again.close()
    assert.deepEqual(dump(dir), { ...expected, after: { ok: true }, n: expected.n + 10, third: 3 })
  })
}

test('a journal containing only a torn record recovers to an empty store', (t) => {
  const dir = tempDir(t)
  const store = openStore(dir)
  store.set('only', 'value')
  store.close()
  const bytes = readFileSync(journalOf(dir))
  writeFileSync(journalOf(dir), bytes.subarray(0, bytes.length - 4))
  assert.deepEqual(dump(dir), {})
  const reopened = openStore(dir)
  reopened.set('k', 1)
  reopened.close()
  assert.deepEqual(dump(dir), { k: 1 })
})

test('a journal that merely lacks its final newline still opens and accepts writes', (t) => {
  const dir = tempDir(t)
  const intact = buildJournalFixture(dir)
  writeFileSync(journalOf(dir), intact.subarray(0, intact.length - 1))
  const store = openStore(dir)
  // the last record is intact, so keeping it is right; dropping it would also be defensible
  assert.ok(store.get('c') === 'last' || store.get('c') === undefined)
  assert.equal(store.get('n'), 7)
  store.set('after', 1)
  store.close()
  const final = dump(dir)
  assert.equal(final.after, 1)
  assert.equal(final.n, 7)
  assert.deepEqual(final.b, { x: [1, 2] })
})

// ---------- genuine corruption is not hidden ----------
test('a damaged record followed by intact records raises CORRUPT and leaves the files alone', (t) => {
  const dir = tempDir(t)
  const intact = buildJournalFixture(dir)
  for (const lineIndex of [0, 2]) {
    const lines = intact.toString('utf8').split('\n')
    const line = lines[lineIndex]
    lines[lineIndex] = `${line.slice(0, 12)}${line[12] === 'X' ? 'Y' : 'X'}${line.slice(13)}`
    const damaged = Buffer.from(lines.join('\n'))
    writeFileSync(journalOf(dir), damaged)
    assert.throws(() => openStore(dir), expectCode('CORRUPT'), `line ${lineIndex}`)
    assert.deepEqual(readFileSync(journalOf(dir)), damaged, 'a failed open must not rewrite the journal')
    assert.equal(existsSync(lockOf(dir)), false, 'a failed open must release the lock')
  }
  writeFileSync(journalOf(dir), intact)
  assert.deepEqual(dump(dir), WITH_LAST)
})

test('a damaged snapshot raises CORRUPT instead of starting empty', (t) => {
  const dir = tempDir(t)
  const store = openStore(dir)
  store.set('a', 1)
  store.set('b', 2)
  store.snapshot()
  store.close()
  const good = readFileSync(snapshotOf(dir), 'utf8')

  const variants = [
    good.slice(0, Math.floor(good.length / 2)),
    'not json at all',
    good.replace('"a"', '"z"'),
    '',
  ]
  for (const [i, text] of variants.entries()) {
    writeFileSync(snapshotOf(dir), text)
    assert.throws(() => openStore(dir), expectCode('CORRUPT'), `variant ${i}`)
    assert.equal(existsSync(lockOf(dir)), false)
  }
  writeFileSync(snapshotOf(dir), good)
  assert.deepEqual(dump(dir), { a: 1, b: 2 })
})

// ---------- interrupted snapshots ----------
for (const mode of ['tear-snapshot', 'tear-snapshot-tmp', 'fail-rename']) {
  test(`an interrupted snapshot (${mode}) loses nothing, with a previous snapshot`, (t) => {
    const dir = tempDir(t)
    const faults = makeFaultFs()
    const store = openStore(dir, { fs: faults.fs })
    store.set('a', 1)
    store.incr('n', 5)
    store.snapshot()
    store.set('b', 2)
    store.incr('n', 5)
    faults.arm(mode)
    try {
      store.snapshot()
    } catch {
      // failing is allowed; losing data is not
    }
    faults.disarm()
    assert.equal(store.get('b'), 2)
    assert.equal(store.get('n'), 10)
    store.set('c', 3)
    store.close()
    assert.deepEqual(dump(dir), { a: 1, b: 2, c: 3, n: 10 })
  })

  test(`an interrupted snapshot (${mode}) loses nothing, without a previous snapshot`, (t) => {
    const dir = tempDir(t)
    const faults = makeFaultFs()
    const store = openStore(dir, { fs: faults.fs })
    store.set('a', 1)
    store.incr('n', 5)
    store.delete('a')
    store.set('d', { deep: [1, { two: 2 }] })
    faults.arm(mode)
    try {
      store.snapshot()
    } catch {
      // allowed
    }
    faults.disarm()
    store.close()
    assert.deepEqual(dump(dir), { d: { deep: [1, { two: 2 }] }, n: 5 })
  })
}

test('a crash while the snapshot is half written (copied disk state) is recoverable', (t) => {
  const dir = tempDir(t)
  const store = openStore(dir)
  store.set('a', 1)
  store.incr('n', 5)
  store.snapshot()
  store.set('b', 2)
  const crashed = crashCopy(t, dir)
  store.close()
  // the interrupted writer left temporary debris next to the good snapshot
  writeFileSync(`${snapshotOf(crashed)}.tmp`, '{"version":1,"seq":99,"cr')
  assert.deepEqual(dump(crashed), { a: 1, b: 2, n: 5 })
  const again = openStore(crashed)
  again.snapshot()
  again.set('c', 3)
  again.close()
  assert.deepEqual(dump(crashed), { a: 1, b: 2, c: 3, n: 5 })
})

// ---------- replay after a crash between snapshot and journal reset ----------
test('no operation is applied twice when the journal was not emptied after a snapshot', (t) => {
  const dir = tempDir(t)
  const store = openStore(dir)
  store.incr('n', 3)
  store.incr('n', 4)
  store.set('s', 'v')
  store.delete('s')
  store.set('t', 1)
  store.incr('t', 1)
  const journalBefore = readFileSync(journalOf(dir))
  store.snapshot()
  store.close()
  writeFileSync(journalOf(dir), journalBefore)

  const reopened = openStore(dir)
  assert.equal(reopened.get('n'), 7)
  assert.equal(reopened.has('s'), false)
  assert.equal(reopened.get('t'), 2)
  assert.equal(reopened.stats().seq, 6)
  assert.equal(reopened.incr('n', 1), 8)
  reopened.close()

  assert.deepEqual(dump(dir), { n: 8, t: 2 })
  // after yet another crash-and-reopen cycle the counters are still exact
  const third = openStore(dir)
  third.incr('t', 10)
  third.snapshot()
  third.close()
  assert.deepEqual(dump(dir), { n: 8, t: 12 })
})

test('journal records older than the snapshot are skipped even when newer ones follow', (t) => {
  const dir = tempDir(t)
  const store = openStore(dir)
  store.incr('n', 1)
  store.incr('n', 1)
  const oldJournal = readFileSync(journalOf(dir))
  store.snapshot()
  store.incr('n', 10)
  const newJournal = readFileSync(journalOf(dir))
  store.close()
  writeFileSync(journalOf(dir), Buffer.concat([oldJournal, newJournal]))
  assert.deepEqual(dump(dir), { n: 12 })
})

// ---------- locks ----------
test('a LOCK left by a dead process does not block opening', (t) => {
  const dir = tempDir(t)
  const store = openStore(dir)
  store.set('a', 1)
  store.snapshot()
  store.set('b', 2)
  const crashed = crashCopy(t, dir)
  store.close()
  writeFileSync(lockOf(crashed), String(findDeadPid()))
  const reopened = openStore(crashed)
  assert.deepEqual(reopened.keys(), ['a', 'b'])
  reopened.set('c', 3)
  reopened.close()
  assert.equal(existsSync(lockOf(crashed)), false)
  assert.deepEqual(dump(crashed), { a: 1, b: 2, c: 3 })
})

test('a lock held by a live process still blocks, and is left in place', (t) => {
  const dir = tempDir(t)
  const store = openStore(dir)
  store.set('a', 1)
  store.close()
  const livePid = String(process.ppid)
  writeFileSync(lockOf(dir), livePid)
  assert.throws(() => openStore(dir), expectCode('LOCKED'))
  assert.equal(readFileSync(lockOf(dir), 'utf8'), livePid)
  assert.deepEqual(readFileSync(journalOf(dir), 'utf8').split('\n').length > 1, true)
})

test('a second handle in this process is refused without disturbing the first', (t) => {
  const dir = tempDir(t)
  const first = openStore(dir)
  first.set('a', 1)
  assert.throws(() => openStore(dir), expectCode('LOCKED'))
  assert.throws(() => openStore(dir), expectCode('LOCKED'))
  assert.equal(existsSync(lockOf(dir)), true)
  first.set('b', 2)
  first.close()
  assert.equal(existsSync(lockOf(dir)), false)
  assert.deepEqual(dump(dir), { a: 1, b: 2 })
})

// ---------- failed writes ----------
for (const mode of ['fail-journal', 'tear-journal']) {
  test(`a write that throws (${mode}) is neither visible now nor after reopening`, (t) => {
    const dir = tempDir(t)
    const faults = makeFaultFs()
    const store = openStore(dir, { fs: faults.fs })
    store.set('a', 1)
    store.incr('n', 2)
    const seqBefore = store.stats().seq
    faults.arm(mode)
    assert.throws(() => store.set('a', 99))
    assert.throws(() => store.set('b', 2))
    assert.throws(() => store.incr('n', 5))
    assert.throws(() => store.delete('a'))
    faults.disarm()
    assert.equal(store.get('a'), 1)
    assert.equal(store.has('b'), false)
    assert.equal(store.get('n'), 2)
    assert.equal(store.size, 2)
    assert.equal(store.stats().seq, seqBefore)
    store.close()
    assert.deepEqual(dump(dir), { a: 1, n: 2 })
    const reopened = openStore(dir)
    reopened.set('c', 3)
    reopened.close()
    assert.deepEqual(dump(dir), { a: 1, c: 3, n: 2 })
  })
}

// ---------- randomised crash simulation ----------
function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const toObject = (map) => Object.fromEntries([...map.entries()].sort(([x], [y]) => (x < y ? -1 : 1)))

test('randomised operations with simulated crashes always recover the acknowledged state', (t) => {
  for (const seed of [11, 22, 33]) {
    const rand = lcg(seed)
    const pick = (list) => list[Math.floor(rand() * list.length)]
    const dir = tempDir(t)
    const store = openStore(dir, { snapshotEvery: 9 })
    const model = new Map()
    let modelBeforeLastRecord = new Map()

    for (let step = 0; step < 90; step++) {
      const roll = rand()
      const before = new Map(model)
      let journaled = true
      if (roll < 0.35) {
        const key = pick(['k0', 'k1', 'k2', 'k3'])
        const value = pick([step, `v${step}`, { step, list: [step, null] }, [step]])
        store.set(key, value)
        model.set(key, JSON.parse(JSON.stringify(value)))
      } else if (roll < 0.65) {
        const key = pick(['c0', 'c1', 'c2'])
        const by = pick([1, 2, 5, -3])
        store.incr(key, by)
        model.set(key, (model.get(key) ?? 0) + by)
      } else if (roll < 0.8) {
        const key = pick(['k0', 'k1', 'k2', 'k3', 'c0', 'c1'])
        journaled = model.has(key)
        store.delete(key)
        model.delete(key)
      } else if (roll < 0.9) {
        // a crash between writing the snapshot and emptying the journal
        const journalBefore = readFileSync(journalOf(dir))
        store.snapshot()
        const crashed = crashCopy(t, dir, { journal: journalBefore })
        assert.deepEqual(dump(crashed), toObject(model), `seed ${seed} step ${step}: snapshot/journal overlap`)
        journaled = false
      } else {
        journaled = false
      }
      if (journaled) modelBeforeLastRecord = before

      if (rand() < 0.35) {
        const crashed = crashCopy(t, dir)
        assert.deepEqual(dump(crashed), toObject(model), `seed ${seed} step ${step}: crash copy`)
      }
      if (rand() < 0.25 && store.stats().journalRecords > 0 && statSync(journalOf(dir)).size > 40) {
        // power loss while the last record was being appended
        const crashed = crashCopy(t, dir)
        const bytes = readFileSync(journalOf(crashed))
        writeFileSync(journalOf(crashed), bytes.subarray(0, bytes.length - (2 + Math.floor(rand() * 3))))
        assert.deepEqual(dump(crashed), toObject(modelBeforeLastRecord), `seed ${seed} step ${step}: torn tail`)
        const resumed = openStore(crashed)
        resumed.set('resumed', step)
        resumed.close()
        assert.deepEqual(dump(crashed), { ...toObject(modelBeforeLastRecord), resumed: step }, `seed ${seed} step ${step}: write after torn tail`)
      }
    }
    store.close()
    assert.deepEqual(dump(dir), toObject(model), `seed ${seed}: clean reopen`)
  }
})
