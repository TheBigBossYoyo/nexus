function lookup(data, dotted) {
  let current = data
  for (const key of dotted.split('.')) {
    if (current === null || current === undefined) return undefined
    current = current[key]
  }
  return current
}

/** Replaces {{ path.to.value }} placeholders with values from data. */
export function render(template, data) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
    const value = lookup(data, key)
    return value === null || value === undefined ? '' : String(value)
  })
}
