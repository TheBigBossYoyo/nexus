import { StoreError } from './errors.js'
import { CURRENT_VERSION, isPlainObject, splitTags } from './schema.js'
import { readTextIfExists, writeText, writeTextAtomic } from './fsutil.js'

function emptyStore() {
  return { version: CURRENT_VERSION, records: [], quarantine: [] }
}

function toIso(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be an epoch millisecond number`)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${field} is out of range`)
  return date.toISOString()
}

function migrateRecord(raw) {
  if (!isPlainObject(raw)) throw new Error('record is not an object')
  if (typeof raw.id !== 'string' || raw.id === '') throw new Error('id must be a non-empty string')
  if (typeof raw.name !== 'string' || raw.name.trim() === '') throw new Error('name must be a non-empty string')
  const { name, created, updated, tags, ...rest } = raw
  const parts = name.trim().split(/\s+/)
  const lastName = parts.length > 1 ? parts.pop() : ''
  const out = { ...rest, firstName: parts.join(' '), lastName, created: toIso(created, 'created') }
  if (updated !== undefined && updated !== null) out.updated = toIso(updated, 'updated')
  if (tags === undefined || tags === null) out.tags = []
  else if (typeof tags === 'string') out.tags = splitTags(tags)
  else if (Array.isArray(tags) && tags.every((t) => typeof t === 'string')) out.tags = tags.map((t) => t.trim()).filter(Boolean)
  else throw new Error('tags must be a string')
  return out
}

/** Pure v1 -> v2 conversion. Unconvertible records are moved to `quarantine`, never dropped. */
export function migrateV1ToV2(doc) {
  if (!isPlainObject(doc) || doc.version !== 1 || !Array.isArray(doc.records)) {
    throw new StoreError('UNSUPPORTED_VERSION', 'migrateV1ToV2 expects a version 1 document')
  }
  const records = []
  const quarantine = []
  doc.records.forEach((raw, index) => {
    try {
      records.push(migrateRecord(raw))
    } catch (err) {
      quarantine.push({ index, reason: err.message, raw: structuredClone(raw) })
    }
  })
  return { ...structuredClone({ ...doc, records: undefined }), version: 2, records, quarantine }
}

/**
 * Loads the contact document, upgrading version 1 files to version 2 on disk
 * (the original is kept as `<file>.bak`).
 */
export async function loadStore(filePath) {
  const text = await readTextIfExists(filePath)
  if (text === null) return emptyStore()
  let doc
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new StoreError('CORRUPT_FILE', `${filePath} is not valid JSON: ${err.message}`, { cause: err })
  }
  if (!isPlainObject(doc)) throw new StoreError('CORRUPT_FILE', `${filePath} is not a document object`)
  if (doc.version !== 1 && doc.version !== CURRENT_VERSION) {
    throw new StoreError(
      'UNSUPPORTED_VERSION',
      `${filePath} has unsupported version ${JSON.stringify(doc.version)}; this build supports versions 1 and ${CURRENT_VERSION}`,
    )
  }
  if (!Array.isArray(doc.records)) throw new StoreError('CORRUPT_FILE', `${filePath} does not contain a records array`)
  if (doc.version === CURRENT_VERSION) {
    if (!Array.isArray(doc.quarantine)) doc.quarantine = []
    return doc
  }
  const migrated = migrateV1ToV2(doc)
  await writeText(`${filePath}.bak`, text)
  await writeTextAtomic(filePath, JSON.stringify(migrated, null, 2) + '\n')
  return migrated
}

export async function saveStore(filePath, doc) {
  if (doc.version !== CURRENT_VERSION) {
    throw new StoreError('UNSUPPORTED_VERSION', `Cannot save document version ${doc.version}`)
  }
  await writeTextAtomic(filePath, JSON.stringify(doc, null, 2) + '\n')
}
