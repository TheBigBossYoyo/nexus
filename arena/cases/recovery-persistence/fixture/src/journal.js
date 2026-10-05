import { crcHex } from './crc32.js'
import { StoreError } from './errors.js'

/** One record per line: eight hex digits of CRC-32 of the payload, a space, the JSON payload, a newline. */
export function encodeRecord(record) {
  const payload = JSON.stringify(record)
  return `${crcHex(payload)} ${payload}\n`
}

/** Returns the record, or null when the line is not an intact record. */
export function decodeRecord(line) {
  if (line.length < 10 || line[8] !== ' ') return null
  const payload = line.slice(9)
  if (crcHex(payload) !== line.slice(0, 8)) return null
  try {
    const record = JSON.parse(payload)
    return record && typeof record.seq === 'number' ? record : null
  } catch {
    return null
  }
}

export function readJournal(fs, path) {
  if (!fs.existsSync(path)) return []
  const records = []
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue
    const record = decodeRecord(line)
    if (!record) throw new StoreError('CORRUPT', `journal ${path} contains a damaged record`)
    records.push(record)
  }
  return records
}

export function appendRecord(fs, path, record) {
  fs.appendFileSync(path, encodeRecord(record))
}
