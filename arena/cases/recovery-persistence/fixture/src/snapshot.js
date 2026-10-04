import { crcHex } from './crc32.js'
import { StoreError } from './errors.js'

/** snapshot.json: { version: 1, seq, crc, entries: [[key, value], ...] }, crc over JSON.stringify(entries). */
export function writeSnapshot(fs, path, seq, data) {
  const entries = [...data.entries()]
  fs.writeFileSync(path, JSON.stringify({ version: 1, seq, crc: crcHex(JSON.stringify(entries)), entries }))
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
