import { loadStore, saveStore } from './store.js'
import { splitTags } from './schema.js'

export function displayName(record) {
  return [record.firstName, record.lastName].filter(Boolean).join(' ')
}

function nextId(records) {
  const max = records.reduce((m, r) => Math.max(m, Number.parseInt(r.id, 10) || 0), 0)
  return String(max + 1)
}

export async function addContact(filePath, input, { now = () => Date.now() } = {}) {
  if (!input || typeof input.name !== 'string' || input.name.trim() === '') {
    throw new Error('name is required')
  }
  const store = await loadStore(filePath)
  const parts = input.name.trim().split(/\s+/)
  const lastName = parts.length > 1 ? parts.pop() : ''
  const tags = Array.isArray(input.tags) ? input.tags.join(',') : (input.tags ?? '')
  const record = {
    id: nextId(store.records),
    firstName: parts.join(' '),
    lastName,
    created: new Date(now()).toISOString(),
    tags: splitTags(tags),
  }
  if (input.email) record.email = input.email
  store.records.push(record)
  await saveStore(filePath, store)
  return record
}

export async function search(filePath, query) {
  const needle = query.trim().toLowerCase()
  const { records } = await loadStore(filePath)
  return records.filter((r) => displayName(r).toLowerCase().includes(needle) || (r.email ?? '').toLowerCase().includes(needle))
}

export async function listByTag(filePath, tag) {
  const wanted = tag.trim().toLowerCase()
  const { records } = await loadStore(filePath)
  return records.filter((r) => r.tags.some((t) => t.toLowerCase() === wanted))
}
