import { StoreError } from './errors.js'
import { CURRENT_VERSION, isPlainObject } from './schema.js'
import { readTextIfExists, writeText } from './fsutil.js'

function emptyStore() {
  return { version: CURRENT_VERSION, records: [] }
}

/**
 * Loads the contact document. A missing file yields an empty store.
 * Throws StoreError('CORRUPT_FILE') when the file is not a valid document.
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
  if (!isPlainObject(doc) || !Array.isArray(doc.records)) {
    throw new StoreError('CORRUPT_FILE', `${filePath} does not contain a records array`)
  }
  return doc
}

export async function saveStore(filePath, doc) {
  if (doc.version !== CURRENT_VERSION) {
    throw new StoreError('UNSUPPORTED_VERSION', `Cannot save document version ${doc.version}`)
  }
  await writeText(filePath, JSON.stringify(doc, null, 2) + '\n')
}
