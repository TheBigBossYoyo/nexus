/**
 * Order line helpers shared by pricing, inventory and the pipeline.
 *
 * A line is `{ sku, qty }`. SKUs are matched case-insensitively and ignoring
 * surrounding whitespace.
 */

export function normalizeSku(sku) {
  if (typeof sku !== 'string' || sku.trim() === '') {
    throw new TypeError('line sku must be a non-empty string')
  }
  return sku.trim().toUpperCase()
}

/**
 * Merge lines that refer to the same SKU and return them in first-seen order.
 */
export function mergeLines(lines) {
  if (!Array.isArray(lines)) {
    throw new TypeError('lines must be an array')
  }
  const bySku = new Map()
  for (const line of lines) {
    if (!Number.isInteger(line.qty) || line.qty < 1) {
      throw new RangeError(`invalid quantity for ${String(line.sku)}: ${String(line.qty)}`)
    }
    line.sku = normalizeSku(line.sku)
    const existing = bySku.get(line.sku)
    if (existing) {
      existing.qty += line.qty
    } else {
      bySku.set(line.sku, line)
    }
  }
  return [...bySku.values()]
}
