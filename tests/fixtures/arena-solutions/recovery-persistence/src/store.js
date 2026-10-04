import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { applyRecord } from './apply.js'
import { StoreError } from './errors.js'
import { appendRecord, readJournal } from './journal.js'
import { acquireLock } from './lock.js'
import { readSnapshot, snapshotTempPath, writeSnapshot } from './snapshot.js'

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
  let journalSize = 0
  let closed = false

  try {
    // A temporary snapshot is the leftover of an interrupted snapshot; it was never committed.
    try {
      fs.unlinkSync(snapshotTempPath(snapshotPath))
    } catch {
      // none
    }
    const snapshot = readSnapshot(fs, snapshotPath)
    if (snapshot) {
      for (const [key, value] of snapshot.entries) data.set(key, value)
      seq = snapshot.seq
      snapshotSeq = snapshot.seq
    }
    const journal = readJournal(fs, journalPath)
    for (const record of journal.records) {
      journalRecords++
      // Operations already contained in the snapshot must not be applied again.
      if (record.seq <= snapshotSeq) continue
      applyRecord(data, record)
      seq = Math.max(seq, record.seq)
    }
    if (journal.validBytes < journal.size) fs.truncateSync(journalPath, journal.validBytes)
    else if (!journal.endsWithNewline) fs.appendFileSync(journalPath, '\n')
    journalSize = journal.validBytes + (journal.endsWithNewline ? 0 : 1)
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

  /** Persist first, then apply: a failed append leaves memory untouched. */
  function commit(fields) {
    const record = { seq: seq + 1, ...fields }
    let written
    try {
      written = appendRecord(fs, journalPath, record)
    } catch (error) {
      // Best effort: cut off whatever part of the record reached the file.
      try {
        fs.truncateSync(journalPath, journalSize)
      } catch {
        // the next open repairs a torn tail
      }
      throw error
    }
    journalSize += written
    seq = record.seq
    journalRecords += 1
    applyRecord(data, record)
    if (journalRecords >= snapshotEvery) {
      try {
        snapshot()
      } catch {
        // the write itself is durable; the snapshot is retried after the next write
      }
    }
  }

  function snapshot() {
    assertOpen()
    writeSnapshot(fs, snapshotPath, seq, data)
    snapshotSeq = seq
    fs.writeFileSync(journalPath, '')
    journalRecords = 0
    journalSize = 0
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
      commit({ op: 'set', key, value: clone(value) })
    },
    delete(key) {
      assertOpen()
      assertKey(key)
      if (!data.has(key)) return false
      commit({ op: 'delete', key })
      return true
    },
    /** Add `by` (default 1) to a numeric value (missing counts as 0) and return the new value. */
    incr(key, by = 1) {
      assertOpen()
      assertKey(key)
      if (typeof by !== 'number' || !Number.isFinite(by)) throw new TypeError('by must be a finite number')
      const current = data.get(key) ?? 0
      if (typeof current !== 'number') throw new TypeError(`value of ${key} is not a number`)
      commit({ op: 'incr', key, by })
      return data.get(key)
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
