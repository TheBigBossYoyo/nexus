import { displayName } from './contacts.js'

export function formatContactLine(record) {
  const email = record.email ? ` <${record.email}>` : ''
  return `#${record.id} ${displayName(record)}${email}`
}
