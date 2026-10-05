import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { applyRecord } from './apply.js'
import { StoreError } from './errors.js'
import { appendRecord, readJournal } from './journal.js'
import { acquireLock } from './lock.js'
import { readSnapshot, writeSnapshot } from './snapshot.js'

const clone = (value) => JSON.parse(JSON.stringify(value))

/**
 * Open (creating if needed) the store in `dir`.
 * options: { fs (a node:fs compatible object, default node:fs), snapshotEvery (journal records between automatic snapshots, default 1000) }
 *
 * Files in `dir`: LOCK, journal.log, snapshot.json.
 */
export function openStore(dir, options = {}) {
  const fs = options.fs ?? nodeFs
  const snapshotEvery = options.snapshotEvery ?? 1000
  fs.mkdirSync(dir, { recursive: true })
  const journalPath = join(dir, 'journal.log')
  const snapshotPath = join(dir, 'snapshot.json')
  const releaseLock = acquireLock(fs, join(dir, 'LOCK'))

  const data = new Map()
  let seq = 0
  let snapshotSeq = 0
  let journalRecords = 0
  let closed = false

  try {
    const snapshot = readSnapshot(fs, snapshotPath)
    if (snapshot) {
      for (const [key, value] of snapshot.entries) data.set(key, value)
      seq = snapshot.seq
      snapshotSeq = snapshot.seq
    }
    for (const record of readJournal(fs, journalPath)) {
      applyRecord(data, record)
      seq = record.seq
      journalRecords++
    }
  } catch (error) {
    releaseLock()
    throw error
  }

  function assertOpen() {
    if (closed) throw new StoreError('CLOSED', 'store is closed')
  }

  function assertKey(key) {
    if (typeof key !== 'string' || key === '') throw new TypeError('key must be a non-empty string')
  }

  function append(fields) {
    seq += 1
    journalRecords += 1
    appendRecord(fs, journalPath, { seq, ...fields })
    if (journalRecords >= snapshotEvery) snapshot()
  }

  function snapshot() {
    assertOpen()
    writeSnapshot(fs, snapshotPath, seq, data)
    fs.writeFileSync(journalPath, '')
    snapshotSeq = seq
    journalRecords = 0
  }

  return {
    get(key) {
      assertOpen()
      return data.get(key)
    },
    has(key) {
      assertOpen()
      return data.has(key)
    },
    keys() {
      assertOpen()
      return [...data.keys()].sort()
    },
    get size() {
      return data.size
    },
    set(key, value) {
      assertOpen()
      assertKey(key)
      if (value === undefined) throw new TypeError('value must not be undefined')
      const stored = clone(value)
      data.set(key, stored)
      append({ op: 'set', key, value: stored })
    },
    delete(key) {
      assertOpen()
      assertKey(key)
      if (!data.has(key)) return false
      data.delete(key)
      append({ op: 'delete', key })
      return true
    },
    /** Add `by` (default 1) to a numeric value (missing counts as 0) and return the new value. */
    incr(key, by = 1) {
      assertOpen()
      assertKey(key)
      if (typeof by !== 'number' || !Number.isFinite(by)) throw new TypeError('by must be a finite number')
      const current = data.get(key) ?? 0
      if (typeof current !== 'number') throw new TypeError(`value of ${key} is not a number`)
      const next = current + by
      data.set(key, next)
      append({ op: 'incr', key, by })
      return next
    },
    snapshot,
    stats() {
      return { seq, snapshotSeq, journalRecords, keys: data.size }
    },
    close() {
      if (closed) return
      closed = true
      releaseLock()
    },
  }
}
