export function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('items must be a non-empty array')
  for (const item of items) {
    if (!item || typeof item.sku !== 'string') throw new Error('item.sku must be a string')
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error('item.quantity must be a positive integer')
    if (item.discountPct !== undefined && !(item.discountPct >= 0 && item.discountPct <= 100)) {
      throw new Error('item.discountPct must be between 0 and 100')
    }
  }
}
