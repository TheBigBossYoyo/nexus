import { crcHex } from './crc32.js'
import { StoreError } from './errors.js'

export function snapshotTempPath(path) {
  return `${path}.tmp`
}

/**
 * snapshot.json: { version: 1, seq, crc, entries: [[key, value], ...] }, crc over JSON.stringify(entries).
 * Written to a temporary file, flushed, then renamed over the old snapshot, so a crash leaves either the
 * old or the new snapshot, never a mixture.
 */
export function writeSnapshot(fs, path, seq, data) {
  const tmp = snapshotTempPath(path)
  const entries = [...data.entries()]
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, seq, crc: crcHex(JSON.stringify(entries)), entries }))
    const fd = fs.openSync(tmp, 'r+')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, path)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // nothing to clean up
    }
    throw error
  }
}

/** Returns { seq, entries } or null when there is no snapshot. Throws StoreError('CORRUPT') when it is damaged. */
export function readSnapshot(fs, path) {
  if (!fs.existsSync(path)) return null
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
  } catch {
    throw new StoreError('CORRUPT', `snapshot ${path} is not valid JSON`)
  }
  const intact =
    parsed &&
    parsed.version === 1 &&
    typeof parsed.seq === 'number' &&
    Array.isArray(parsed.entries) &&
    crcHex(JSON.stringify(parsed.entries)) === parsed.crc
  if (!intact) throw new StoreError('CORRUPT', `snapshot ${path} failed its integrity check`)
  return { seq: parsed.seq, entries: parsed.entries }
}
