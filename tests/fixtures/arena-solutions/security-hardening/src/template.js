const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch])
}

function lookup(data, dotted) {
  let current = data
  for (const key of dotted.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

/** Replaces {{ path.to.value }} placeholders with HTML-escaped values from data. */
export function render(template, data) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
    const value = lookup(data, key)
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
      return escapeHtml(String(value))
    }
    return ''
  })
}
