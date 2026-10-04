import { mergeLines } from './lines.js'
import { applyRate } from './money.js'

export const DEFAULT_TAX_RATE = 0.0825

/**
 * Price an order. Returns merged priced lines plus subtotal, tax and total in cents.
 */
export function priceOrder(order, catalog, { taxRate = DEFAULT_TAX_RATE } = {}) {
  const lines = mergeLines(order.lines).map((line) => {
    const unitCents = catalog.priceCents(line.sku)
    return { sku: line.sku, qty: line.qty, unitCents, totalCents: unitCents * line.qty }
  })
  const subtotalCents = lines.reduce((sum, line) => sum + line.totalCents, 0)
  const taxCents = applyRate(subtotalCents, taxRate)
  return {
    orderId: order.id,
    customer: order.customer,
    lines,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  }
}
