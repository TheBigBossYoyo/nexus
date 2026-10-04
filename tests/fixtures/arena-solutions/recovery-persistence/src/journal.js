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

/**
 * Read the journal. A damaged final line is a torn write and is reported through `validBytes` (the length of the
 * intact prefix) so the caller can truncate it; a damaged line followed by more data is real corruption.
 */
export function readJournal(fs, path) {
  if (!fs.existsSync(path)) return { records: [], validBytes: 0, size: 0, endsWithNewline: true }
  const buffer = fs.readFileSync(path)
  const lines = []
  let start = 0
  while (start < buffer.length) {
    const newline = buffer.indexOf(10, start)
    const end = newline === -1 ? buffer.length : newline
    lines.push({ end, terminated: newline !== -1, text: buffer.toString('utf8', start, end) })
    start = newline === -1 ? buffer.length : newline + 1
  }
  const records = []
  let validBytes = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const next = line.terminated ? line.end + 1 : line.end
    if (line.text === '') {
      validBytes = next
      continue
    }
    const record = decodeRecord(line.text)
    if (!record) {
      if (i === lines.length - 1) break
      throw new StoreError('CORRUPT', `journal ${path} contains a damaged record`)
    }
    records.push(record)
    validBytes = next
  }
  const endsWithNewline = validBytes === 0 || buffer[validBytes - 1] === 10
  return { records, validBytes, size: buffer.length, endsWithNewline }
}

/** Appends one record and returns the number of bytes written. */
export function appendRecord(fs, path, record) {
  const line = encodeRecord(record)
  fs.appendFileSync(path, line)
  return Buffer.byteLength(line)
}
